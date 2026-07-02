import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";

const HASH_VECTOR_DIMENSIONS = 128;
const MAX_INDEX_SENTENCES_PER_DOCUMENT = 2500;
const MAX_ANALYTICS_CHARS = 120000;
const READER_PAGE_CHAR_LIMIT = 850;
const VECTOR_CACHE_FILE = "vector-cache.json";

export function createHashEmbeddingProvider() {
  return {
    id: "local-hash-ngram-v1",
    label: "Local hash n-gram fallback",
    dimensions: HASH_VECTOR_DIMENSIONS,
    async embed(text = "") {
      return hashEmbedText(text);
    },
    async embedMany(texts = []) {
      return texts.map((text) => hashEmbedText(text));
    }
  };
}

export function createMlService({
  getState,
  getRevisions = () => ({}),
  vectorDir,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch = null,
  embeddingProvider = createHashEmbeddingProvider()
}) {
  const queryVectorCache = new Map();
  let analyticsCache = null;
  let textRefreshInProgress = false;
  let vectorUpdateInProgress = false;
  let indexStatus = {
    provider: "lancedb",
    embeddingProvider: embeddingProvider.id,
    embeddingDimensions: embeddingProvider.dimensions,
    vectorDir,
    ready: false,
    chunks: 0,
    rebuiltAt: "",
    error: ""
  };

  async function rebuildIndex(options = {}) {
    if (!options.internal) {
      if (options.skipVectors === true) return refreshTextIndex(options);
      await refreshTextIndex(options);
      return updateSemanticVectors(options);
    }
    await fs.mkdir(vectorDir, { recursive: true });
    const state = getState();
    const existingChunkSidecar = await readChunkSidecar(vectorDir);
    const activeSidecarCount = countActiveSidecarChunks(existingChunkSidecar, state);
    const targetInfo = typeof embeddingProvider.configuredInfo === "function" ? embeddingProvider.configuredInfo() : embeddingInfo();
    if (options.skipVectors === true) {
      const currentFtsStatus = ftsSearch && typeof ftsSearch.status === "function" ? ftsSearch.status() : null;
      if (canReturnFastLexicalRebuild(state, existingChunkSidecar, currentFtsStatus)) {
        const previousStatus = await readStoredIndexStatus(vectorDir);
        const runtimeInfo = embeddingInfo();
        indexStatus = {
          ...previousStatus,
          provider: "lancedb",
          embeddingProvider: runtimeInfo.id,
          embeddingProviderLabel: runtimeInfo.label,
          embeddingDimensions: runtimeInfo.dimensions,
          embeddingDevice: runtimeInfo.device || "",
          embeddingFallback: Boolean(runtimeInfo.fallback),
          embeddingError: runtimeInfo.error || "",
          vectorDir,
          ready: Boolean(previousStatus.ready),
          chunks: activeSidecarCount,
          reusedVectors: activeSidecarCount,
          embeddedVectors: 0,
          vectorRowsInsertedOrUpdated: 0,
          vectorRowsSkipped: activeSidecarCount,
          lexicalOnly: true,
          lexicalFastPath: true,
          updatedAt: new Date().toISOString(),
          error: previousStatus.error || "",
          fts: currentFtsStatus
        };
        return withRuntimeStatus(indexStatus);
      }
      const updatePlan = buildLexicalChunkUpdatePlan(state, existingChunkSidecar, {
        normalizeJapaneseTerm,
        hasJapaneseText,
        hasKanji
      });
      let ftsStatus = ftsSearch && typeof ftsSearch.status === "function" ? ftsSearch.status() : null;
      const cleanupErrors = [];
      for (const documentId of updatePlan.removedDocumentIds) {
        try {
          if (ftsSearch && typeof ftsSearch.deleteDocument === "function") ftsSearch.deleteDocument(documentId);
          await deleteLanceDocumentRows(vectorDir, documentId);
        } catch (error) {
          cleanupErrors.push(`${documentId}: ${error.message}`);
        }
      }
      if (updatePlan.removedDocumentIds.length > 0 && ftsSearch && typeof ftsSearch.status === "function") {
        ftsStatus = ftsSearch.status();
      }
      const shouldRefreshFtsStatus = Boolean(ftsStatus?.stale) || !ftsStatus?.ready;
      if (ftsSearch && typeof ftsSearch.rebuild === "function" && (updatePlan.changedChunks.length > 0 || shouldRefreshFtsStatus)) {
        const chunksForRefresh = updatePlan.changedChunks.length > 0 ? updatePlan.changedChunks : updatePlan.allChunks;
        ftsStatus = await ftsSearch.rebuild(chunksForRefresh, {
          analyze: false,
          pruneDocuments: updatePlan.changedDocumentIds
        });
      }
      const previousStatus = await readStoredIndexStatus(vectorDir);
      const runtimeInfo = embeddingInfo();
      indexStatus = {
        ...previousStatus,
        provider: "lancedb",
        embeddingProvider: runtimeInfo.id,
        embeddingProviderLabel: runtimeInfo.label,
        embeddingDimensions: runtimeInfo.dimensions,
        embeddingDevice: runtimeInfo.device || "",
        embeddingFallback: Boolean(runtimeInfo.fallback),
        embeddingError: runtimeInfo.error || "",
        vectorDir,
        ready: Boolean(previousStatus.ready),
        chunks: updatePlan.allChunks.length,
        reusedVectors: activeSidecarCount,
        embeddedVectors: 0,
        vectorRowsInsertedOrUpdated: 0,
        vectorRowsSkipped: updatePlan.allChunks.length,
        lexicalOnly: true,
        lexicalFastPath: false,
        updatedAt: new Date().toISOString(),
        error: cleanupErrors.length > 0 ? `Index cleanup incomplete: ${cleanupErrors.join("; ")}` : previousStatus.error || "",
        fts: ftsStatus
      };
      await fs.writeFile(path.join(vectorDir, "chunks.json"), JSON.stringify(updatePlan.allChunks), "utf8");
      await pruneVectorCacheToChunkIds(vectorDir, new Set(updatePlan.allChunks.map((chunk) => chunk.id)));
      await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
      return withRuntimeStatus(indexStatus);
    }
    const canReturnNoop = await canReturnFastRebuild(state, existingChunkSidecar, targetInfo, vectorDir);
    if (canReturnNoop) {
      const runtimeInfo = embeddingInfo();
      const ftsStatus = ftsSearch && typeof ftsSearch.status === "function" ? ftsSearch.status() : null;
      indexStatus = {
        ...(await status()),
        provider: "lancedb",
        embeddingProvider: runtimeInfo.id,
        embeddingProviderLabel: runtimeInfo.label,
        embeddingDimensions: runtimeInfo.dimensions,
        embeddingDevice: runtimeInfo.device || "",
        embeddingFallback: Boolean(runtimeInfo.fallback),
        embeddingError: runtimeInfo.error || "",
        vectorDir,
        ready: true,
        chunks: activeSidecarCount,
        reusedVectors: activeSidecarCount,
        embeddedVectors: 0,
        vectorRowsInsertedOrUpdated: 0,
        vectorRowsSkipped: activeSidecarCount,
        rebuiltAt: new Date().toISOString(),
        error: "",
        fts: ftsStatus
      };
      await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
      return withRuntimeStatus(indexStatus);
    }
    const sourceChunks = uniqueChunksById(await buildVectorChunksIncremental(state, existingChunkSidecar, {
      normalizeJapaneseTerm,
      hasJapaneseText,
      hasKanji
    }));
    const removedDocumentIds = removedDocumentIdsFromSidecar(existingChunkSidecar, state);
    const cleanupErrors = [];
    for (const documentId of removedDocumentIds) {
      try {
        await deleteLanceDocumentRows(vectorDir, documentId);
        if (ftsSearch && typeof ftsSearch.deleteDocument === "function") ftsSearch.deleteDocument(documentId);
      } catch (error) {
        cleanupErrors.push(`${documentId}: ${error.message}`);
      }
    }
    const chunks = [];
    const texts = sourceChunks.map(vectorTextForChunk);
    const vectorCache = await readVectorCache(vectorDir);
    const vectorWritePlan = vectorRowsNeedingWrite(sourceChunks, texts, vectorCache, existingChunkSidecar, targetInfo);
    const { vectors, reused, embedded } = await vectorsForChunks(sourceChunks, texts, vectorCache, targetInfo, options);
    for (const [index, chunk] of sourceChunks.entries()) {
      chunks.push({ ...chunk, vector: vectors[index] });
    }
    let runtimeInfo = embeddingInfo();
    let ftsStatus = null;
    if (!options.skipTextIndex && ftsSearch && typeof ftsSearch.rebuild === "function") {
      ftsStatus = await ftsSearch.rebuild(sourceChunks);
    } else if (ftsSearch && typeof ftsSearch.status === "function") {
      ftsStatus = ftsSearch.status();
    }

    const db = await lancedb.connect(vectorDir);
    const vectorRows = chunks.map(encodeChunkForVectorTable);
    const changedVectorRows = vectorRows.filter((row) => vectorWritePlan.changedIds.has(row.id));
    const vectorTableResult = await updateVectorTableIncremental(db, vectorRows, changedVectorRows);
    if (vectorTableResult.createdEmpty) {
      await db.createTable("chunks", [{
        id: "empty",
        documentId: "",
        title: "Empty index",
        chapterId: "",
        chapterTitle: "",
        page: 0,
        text: "",
        type: "empty",
        knownCoverage: 0,
        terms: [""],
        dictionaryForms: [""],
        mined: false,
        readAtIndex: false,
        vector: await embeddingProvider.embed("", { providerId: runtimeInfo.id })
      }], { mode: "overwrite" });
      runtimeInfo = embeddingInfo();
    }

    indexStatus = {
      provider: "lancedb",
      embeddingProvider: runtimeInfo.id,
      embeddingProviderLabel: runtimeInfo.label,
      embeddingDimensions: runtimeInfo.dimensions,
      embeddingDevice: runtimeInfo.device || "",
      embeddingFallback: Boolean(runtimeInfo.fallback),
      embeddingError: runtimeInfo.error || "",
      vectorDir,
      ready: true,
      chunks: chunks.length,
      reusedVectors: reused,
      embeddedVectors: embedded,
      vectorRowsInsertedOrUpdated: vectorTableResult.changedRows,
      vectorRowsSkipped: Math.max(0, chunks.length - vectorTableResult.changedRows),
      rebuiltAt: new Date().toISOString(),
      error: cleanupErrors.length > 0 ? `Index cleanup incomplete: ${cleanupErrors.join("; ")}` : "",
      fts: ftsStatus
    };
    const shouldRewriteSidecars = embedded > 0
      || vectorTableResult.changedRows > 0
      || existingChunkSidecar.size !== chunks.length
      || removedDocumentIds.length > 0;
    if (shouldRewriteSidecars) {
      await fs.writeFile(path.join(vectorDir, "chunks.json"), JSON.stringify(chunks.map(({ vector, ...chunk }) => chunk)), "utf8");
      await writeVectorCache(vectorDir, chunks, texts, runtimeInfo);
    }
    await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
    return withRuntimeStatus(indexStatus);
  }

  async function refreshTextIndex(options = {}) {
    if (textRefreshInProgress) throw indexBusyError("Text search index refresh is already running.");
    textRefreshInProgress = true;
    try {
      options.onProgress?.({ phase: "text", message: "Refreshing text search index...", current: 0, total: 1 });
      const result = await rebuildIndex({ ...options, skipVectors: true, internal: true });
      options.onProgress?.({ phase: "text", message: "Text search index refreshed.", current: 1, total: 1 });
      return result;
    } finally {
      textRefreshInProgress = false;
    }
  }

  async function updateSemanticVectors(options = {}) {
    if (vectorUpdateInProgress) throw indexBusyError("Semantic vector update is already running.");
    vectorUpdateInProgress = true;
    try {
      options.onProgress?.({ phase: "scan", message: "Checking semantic vector cache...", current: 0, total: 1 });
      const result = await rebuildIndex({ ...options, skipVectors: false, skipTextIndex: true, internal: true });
      return result;
    } finally {
      vectorUpdateInProgress = false;
    }
  }

  async function vectorsForChunks(sourceChunks, texts, vectorCache, targetInfo, options = {}) {
    const vectors = new Array(sourceChunks.length);
    const missing = [];
    let reused = 0;
    const targetProvider = targetInfo.id;
    const targetDimensions = Number(targetInfo.dimensions) || 0;

    sourceChunks.forEach((chunk, index) => {
      const cacheEntry = vectorCache.get(chunk.id);
      const hash = chunkContentHash(texts[index]);
      if (
        cacheEntry
        && cacheEntry.hash === hash
        && cacheEntry.embeddingProvider === targetProvider
        && Number(cacheEntry.embeddingDimensions) === targetDimensions
        && Array.isArray(cacheEntry.vector)
        && cacheEntry.vector.length === targetDimensions
      ) {
        vectors[index] = cacheEntry.vector;
        reused += 1;
      } else {
        missing.push({ index, text: texts[index] });
      }
    });

    if (missing.length === 0) {
      options.onProgress?.({ phase: "vectors", message: "No new semantic vectors needed.", current: 0, total: 0 });
      return { vectors, reused, embedded: 0 };
    }

    const missingTexts = missing.map((item) => item.text);
    options.onProgress?.({ phase: "vectors", message: `Embedding chunks 0 / ${missing.length}...`, current: 0, total: missing.length });
    const missingVectors = typeof embeddingProvider.embedMany === "function"
      ? await embeddingProvider.embedMany(missingTexts)
      : await Promise.all(missingTexts.map((text) => embeddingProvider.embed(text)));
    options.onProgress?.({ phase: "vectors", message: `Embedding chunks ${missing.length} / ${missing.length}...`, current: missing.length, total: missing.length });
    let runtimeInfo = embeddingInfo();

    if (runtimeInfo.id !== targetProvider || Number(runtimeInfo.dimensions) !== targetDimensions) {
      const allVectors = typeof embeddingProvider.embedMany === "function"
        ? await embeddingProvider.embedMany(texts, { providerId: runtimeInfo.id })
        : await Promise.all(texts.map((text) => embeddingProvider.embed(text, { providerId: runtimeInfo.id })));
      options.onProgress?.({ phase: "vectors", message: `Embedding chunks ${texts.length} / ${texts.length}...`, current: texts.length, total: texts.length });
      return { vectors: allVectors, reused: 0, embedded: allVectors.length };
    }

    for (const [offset, item] of missing.entries()) {
      vectors[item.index] = missingVectors[offset];
    }
    return { vectors, reused, embedded: missing.length };
  }

  async function status() {
    if (indexStatus.ready || indexStatus.error) return withRuntimeStatus(indexStatus);
    try {
      const raw = await fs.readFile(path.join(vectorDir, "status.json"), "utf8");
      indexStatus = { ...indexStatus, ...JSON.parse(raw) };
      indexStatus.vectorDir = vectorDir;
    } catch {
      indexStatus = { ...indexStatus, ready: false };
    }
    return withRuntimeStatus(indexStatus);
  }

  async function search(query, options = {}) {
    const {
      limit = 8,
      readSafe = false,
      documentId = "",
      currentPage = null,
      includeCards = true,
      scope = "library",
      allowVector = false
    } = options;
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) return { query: "", results: [], status: await status() };
    const currentStatus = await status();
    const ftsRuntimeStatus = ftsSearch && typeof ftsSearch.status === "function" ? ftsSearch.status() : null;
    const responseStatus = ftsRuntimeStatus && !currentStatus.fts
      ? { ...currentStatus, fts: ftsRuntimeStatus }
      : currentStatus;
    if (!currentStatus.ready) return { query: normalizedQuery, results: [], status: responseStatus };

    const resultLimit = Math.max(1, Math.min(20, Number(limit) || 8));
    const queryVariants = await queryVariantsForSearch(normalizedQuery, { analyzeText, normalizeJapaneseTerm });
    const state = getState();
    const activeDocumentIds = new Set((state.documents ?? []).map((document) => String(document.id ?? "")).filter(Boolean));
    const lexicalResult = await hybridLexicalSearch(normalizedQuery, queryVariants, {
      ftsSearch,
      vectorDir,
      limit: resultLimit * 8,
      documentId: scope === "document" ? documentId : ""
    });
    const lexicalRows = lexicalResult.rows;
    let vectorRows = [];
    const runVectorSearch = shouldRunVectorSearch(normalizedQuery, lexicalRows, { resultLimit, hasJapaneseText, currentStatus: responseStatus, ftsReady: Boolean(ftsRuntimeStatus?.ready || currentStatus.fts?.ready) });
    const ranVectorSearch = allowVector === true && runVectorSearch;
    if (ranVectorSearch) {
      try {
        const db = await lancedb.connect(vectorDir);
        const table = await db.openTable("chunks");
        vectorRows = await vectorSearch(table, normalizedQuery, currentStatus, resultLimit * 6, {
          activeDocumentIds,
          includeCards,
          scope,
          documentId,
          readSafe,
          currentPage,
          state
        });
      } catch {
        vectorRows = [];
      }
    }

    const byId = new Map();
    for (const row of vectorRows.filter((row) => row.id !== "empty")) {
      byId.set(row.id, {
        ...row,
        vectorScore: typeof row._distance === "number" ? Math.max(0, 1 - row._distance) : 0,
        lexicalScore: 0
      });
    }
    for (const row of lexicalRows) {
      const existing = byId.get(row.id) ?? {};
      byId.set(row.id, {
        ...existing,
        ...row,
        vectorScore: existing.vectorScore ?? 0,
        lexicalScore: row.lexicalScore
      });
    }

    const rows = [...byId.values()]
      .filter((row) => activeDocumentIds.has(String(row.documentId ?? "")))
      .filter((row) => includeCards || row.type !== "card")
      .filter((row) => scope !== "document" || !documentId || row.documentId === documentId)
      .filter((row) => !readSafe || isChunkReadSafe(row, state, { documentId, currentPage }))
      .sort((a, b) => retrievalScore(b, normalizedQuery, { documentId, currentPage, queryVariants }) - retrievalScore(a, normalizedQuery, { documentId, currentPage, queryVariants }))
      .filter(uniqueSearchResult())
      .slice(0, resultLimit);

    return {
      query: normalizedQuery,
      results: rows.map((row) => publicSearchResult(row, normalizedQuery, { documentId, currentPage, queryVariants }, state)),
      status: responseStatus
    };
  }

  async function ragAnswer(question, options = {}) {
    const result = await search(question, { limit: 6, readSafe: options.readSafe !== false, ...options });
    const citations = result.results.slice(0, 5);
    const answer = citations.length === 0
      ? "No indexed local evidence was found. Rebuild the ML index after importing or reading books."
      : [
          "Retrieved local evidence:",
          ...citations.map((item, index) => {
            const label = `${item.title || "Untitled"}${item.chapterTitle ? `, ${item.chapterTitle}` : ""}${Number.isFinite(Number(item.page)) ? `, page ${Number(item.page) + 1}` : ""}`;
            return `${index + 1}. ${label}\n${item.text}`;
          })
        ].join("\n\n");
    return { question: String(question ?? "").trim(), answer, citations, status: result.status };
  }

  async function deleteDocumentVectors(documentId = "") {
    const normalizedDocumentId = String(documentId ?? "");
    if (!normalizedDocumentId) return { deleted: 0, ready: (await status()).ready };

    const existingStatus = await status();
    const ftsDeleted = ftsSearch && typeof ftsSearch.deleteDocument === "function"
      ? ftsSearch.deleteDocument(normalizedDocumentId).deleted
      : 0;
    const lancedbDeleted = await deleteLanceDocumentRows(vectorDir, normalizedDocumentId);
    const chunksPath = path.join(vectorDir, "chunks.json");
    let chunks = [];
    try {
      const raw = await fs.readFile(chunksPath, "utf8");
      chunks = JSON.parse(raw);
    } catch {
      return { deleted: 0, lancedbDeleted, ftsDeleted, ready: existingStatus.ready };
    }

    if (!Array.isArray(chunks) || chunks.length === 0) return { deleted: 0, lancedbDeleted, ftsDeleted, ready: existingStatus.ready };
    const remainingChunks = chunks.filter((chunk) => chunk.documentId !== normalizedDocumentId);
    const deleted = chunks.length - remainingChunks.length;
    if (deleted === 0) return { deleted: 0, lancedbDeleted, ftsDeleted, ready: existingStatus.ready };

    await fs.mkdir(vectorDir, { recursive: true });
    await fs.writeFile(chunksPath, JSON.stringify(remainingChunks), "utf8");
    await pruneVectorCacheToChunkIds(vectorDir, new Set(remainingChunks.map((chunk) => chunk.id)));

    indexStatus = {
      ...existingStatus,
      ready: true,
      chunks: remainingChunks.length,
      rebuiltAt: existingStatus.rebuiltAt || "",
      updatedAt: new Date().toISOString(),
      error: ""
    };
    await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
    return { deleted, lancedbDeleted, ftsDeleted, ready: true, chunks: remainingChunks.length };
  }

  async function analytics() {
    const state = getState();
    const revisions = safeRevisions(getRevisions);
    const signature = analyticsSignature(state, revisions);
    if (analyticsCache?.signature === signature) {
      return { ...analyticsCache.value, cached: true };
    }

    const events = await eventLog.recent(1500);
    const known = knownSet(state, normalizeJapaneseTerm);
    const indexedAnalytics = typeof ftsSearch?.documentAnalytics === "function"
      ? ftsSearch.documentAnalytics(known, { normalizeJapaneseTerm, hasJapaneseText, hasKanji })
      : new Map();
    const documents = [];

    for (const document of state.documents ?? []) {
      try {
        const tokenMetrics = indexedAnalytics.get(document.id)
          ?? cheapDocumentMetrics(document, known, { hasJapaneseText, hasKanji, normalizeJapaneseTerm });
        documents.push({
          id: document.id,
          title: document.title,
          type: document.type,
          analyticsSource: tokenMetrics.source ?? "fallback",
          indexedChunks: tokenMetrics.chunks ?? 0,
          coverage: tokenMetrics.coverage,
          knownTokens: tokenMetrics.knownTokens,
          unknownTokens: tokenMetrics.unknownTokens,
          uniqueUnknown: tokenMetrics.uniqueUnknown,
          averageSentenceLength: averageSentenceLength(document.text),
          kanjiDensity: kanjiDensity(document.text, hasKanji),
          difficulty: difficultyLabel(tokenMetrics.coverage)
        });
      } catch (error) {
        documents.push({
          id: document.id,
          title: document.title,
          type: document.type,
          coverage: 0,
          knownTokens: 0,
          unknownTokens: 0,
          uniqueUnknown: 0,
          averageSentenceLength: 0,
          kanjiDensity: 0,
          difficulty: "Unavailable",
          error: error.message
        });
      }
    }

    const exportedEvents = events.filter((event) => event.type === "anki.exported");
    const previewEvents = events.filter((event) => event.type === "sentence.previewed");
    const lookupEvents = events.filter((event) => event.type === "lookup.performed");
    const wordAddedEvents = events.filter((event) => event.type === "wordbank.added");

    const value = {
      totals: {
        documents: state.documents?.length ?? 0,
        knownTerms: state.knownTerms?.length ?? 0,
        cards: state.cards?.length ?? 0,
        events: events.length,
        indexChunks: (await status()).chunks
      },
      metrics: {
        averageCoverage: documents.length ? Math.round(documents.reduce((sum, item) => sum + item.coverage, 0) / documents.length) : 0,
        candidateAcceptanceRate: previewEvents.length ? Math.round((exportedEvents.length / previewEvents.length) * 100) : 0,
        lookupToWordBankRate: lookupEvents.length ? Math.round((wordAddedEvents.length / lookupEvents.length) * 100) : 0
      },
      documents: documents.sort((a, b) => b.coverage - a.coverage),
      recentEvents: events.slice(-12).reverse()
    };
    analyticsCache = { signature, value };
    return { ...value, cached: false };
  }

  async function rankCandidates(documentId, candidates = []) {
    const state = getState();
    const document = state.documents.find((item) => item.id === documentId);
    const known = knownSet(state, normalizeJapaneseTerm);
    const events = await eventLog.recent(1000);
    const lookupCounts = countEventsByTerm(events.filter((event) => event.type === "lookup.performed"), normalizeJapaneseTerm);
    const exportedTerms = new Set((state.cards ?? []).map((card) => normalizeJapaneseTerm(card.dictionaryForm || card.expression)).filter(Boolean));
    const docText = document?.text ?? "";

    const ranked = [];
    for (const candidate of candidates) {
      const term = normalizeJapaneseTerm(candidate.dictionaryForm || candidate.expression);
      const sentenceAnalysis = await analyzeText(candidate.sentence || candidate.expression || "");
      const metrics = metricsFromTokens(sentenceAnalysis.tokens, known, hasJapaneseText, hasKanji, normalizeJapaneseTerm);
      const recurrence = countTermOccurrences(docText, term);
      const recentLookups = lookupCounts.get(term) ?? 0;
      const hasDictionary = (candidate.dictionaryEntries?.length ?? 0) > 0 || lookupDictionary(term).length > 0;
      const duplicate = exportedTerms.has(term);
      const idealUnknown = metrics.uniqueUnknown === 1 || metrics.uniqueUnknown === 2;
      const sentenceLength = String(candidate.sentence || "").length;
      let score = 0;
      score += idealUnknown ? 28 : Math.max(0, 18 - metrics.uniqueUnknown * 5);
      score += Math.min(25, Math.round(metrics.coverage / 4));
      score += Math.min(15, recurrence * 3);
      score += Math.min(12, recentLookups * 4);
      score += hasDictionary ? 10 : -8;
      score += sentenceLength >= 12 && sentenceLength <= 80 ? 10 : -8;
      score -= duplicate ? 25 : 0;
      ranked.push({
        ...candidate,
        rankScore: Math.max(0, Math.round(score)),
        rankBadges: [
          idealUnknown ? "i+1" : "",
          recurrence >= 3 ? "high recurrence" : "",
          recentLookups > 0 ? "recent lookup" : "",
          duplicate ? "duplicate risk" : "",
          hasDictionary ? "dictionary match" : ""
        ].filter(Boolean),
        rankReasons: {
          knownCoverage: metrics.coverage,
          uniqueUnknown: metrics.uniqueUnknown,
          recurrence,
          recentLookups,
          sentenceLength,
          hasDictionary,
          duplicate
        }
      });
    }

    return ranked.sort((a, b) => b.rankScore - a.rankScore);
  }

  function withRuntimeStatus(statusValue = {}) {
    const mlState = getState().ml ?? {};
    const runtimeInfo = embeddingInfo();
    let ftsStatus = statusValue.fts;
    if (ftsSearch && typeof ftsSearch.status === "function") {
      try {
        ftsStatus = ftsSearch.status();
      } catch (error) {
        ftsStatus = { provider: "sqlite-fts5", ready: false, stale: true, error: error.message };
      }
    }
    const storedProvider = statusValue.embeddingProvider || runtimeInfo.id;
    const storedDimensions = statusValue.embeddingDimensions || runtimeInfo.dimensions;
    const providerMismatch = Boolean(statusValue.ready && storedProvider && runtimeInfo.id && storedProvider !== runtimeInfo.id);
    const dimensionMismatch = Boolean(
      statusValue.ready
      && storedDimensions
      && runtimeInfo.dimensions
      && Number(storedDimensions) !== Number(runtimeInfo.dimensions)
    );
    const stale = Boolean(mlState.indexStale || providerMismatch || dimensionMismatch);
    const staleReason = mlState.indexStaleReason
      || (providerMismatch ? `Embedding model changed from ${storedProvider} to ${runtimeInfo.id}.` : "")
      || (dimensionMismatch ? "Embedding vector dimensions changed." : "");
    const combined = {
      ...statusValue,
      fts: ftsStatus,
      embeddingProvider: storedProvider,
      embeddingProviderLabel: statusValue.embeddingProviderLabel || runtimeInfo.label,
      embeddingDimensions: storedDimensions,
      embeddingDevice: statusValue.embeddingDevice || runtimeInfo.device || "",
      embeddingFallback: Boolean(statusValue.embeddingFallback ?? runtimeInfo.fallback),
      embeddingError: statusValue.embeddingError || runtimeInfo.error || "",
      stale,
      staleReason
    };
    return {
      ...combined,
      textSearch: textSearchStatus(ftsStatus),
      semanticVectors: semanticVectorStatus(combined, { stale, staleReason })
    };
  }

  function embeddingInfo() {
    return typeof embeddingProvider.info === "function"
      ? embeddingProvider.info()
      : {
          id: embeddingProvider.id,
          label: embeddingProvider.label,
          dimensions: embeddingProvider.dimensions
        };
  }

  function textSearchStatus(ftsStatus = {}) {
    ftsStatus = ftsStatus ?? {};
    return {
      provider: ftsStatus.provider || "sqlite-fts5",
      ready: Boolean(ftsStatus.ready),
      stale: Boolean(ftsStatus.stale),
      chunks: Number(ftsStatus.chunks) || 0,
      updatedAt: ftsStatus.updatedAt || ftsStatus.rebuiltAt || "",
      rebuiltAt: ftsStatus.rebuiltAt || "",
      inserted: Number(ftsStatus.inserted) || 0,
      updated: Number(ftsStatus.updated) || 0,
      deleted: Number(ftsStatus.deleted) || 0,
      skipped: Number(ftsStatus.skipped) || 0,
      error: ftsStatus.error || ""
    };
  }

  function semanticVectorStatus(statusValue = {}, staleInfo = {}) {
    statusValue = statusValue ?? {};
    staleInfo = staleInfo ?? {};
    return {
      provider: statusValue.provider || "lancedb",
      ready: Boolean(statusValue.ready),
      stale: Boolean(staleInfo.stale),
      chunks: Number(statusValue.chunks) || 0,
      updatedAt: statusValue.updatedAt || statusValue.rebuiltAt || "",
      rebuiltAt: statusValue.rebuiltAt || "",
      embeddingProvider: statusValue.embeddingProvider || "",
      embeddingProviderLabel: statusValue.embeddingProviderLabel || statusValue.embeddingProvider || "",
      embeddingDimensions: Number(statusValue.embeddingDimensions) || 0,
      embeddingDevice: statusValue.embeddingDevice || "",
      embeddingFallback: Boolean(statusValue.embeddingFallback),
      embeddingError: statusValue.embeddingError || "",
      embeddedVectors: Number(statusValue.embeddedVectors) || 0,
      reusedVectors: Number(statusValue.reusedVectors) || 0,
      vectorRowsInsertedOrUpdated: Number(statusValue.vectorRowsInsertedOrUpdated) || 0,
      vectorRowsSkipped: Number(statusValue.vectorRowsSkipped) || 0,
      staleReason: staleInfo.staleReason || "",
      error: statusValue.error || ""
    };
  }

  async function vectorSearch(table, query, currentStatus, limit, filterContext = {}) {
    try {
      const vector = await cachedQueryVector(query, currentStatus);
      if (currentStatus.embeddingDimensions && vector.length !== Number(currentStatus.embeddingDimensions)) return [];
      let searchQuery = table.search(vector);
      const predicate = vectorFilterPredicate(filterContext);
      if (predicate) searchQuery = searchQuery.where(predicate);
      return await searchQuery.limit(Math.max(limit, 30)).toArray();
    } catch {
      return [];
    }
  }

  async function cachedQueryVector(query, currentStatus) {
    const key = [
      currentStatus.embeddingProvider || embeddingProvider.id,
      currentStatus.embeddingDimensions || embeddingProvider.dimensions,
      String(query ?? "").normalize("NFKC").trim()
    ].join("\u0001");
    const cached = queryVectorCache.get(key);
    if (cached) return cached;
    const vector = await embeddingProvider.embed(query, { providerId: currentStatus.embeddingProvider });
    queryVectorCache.set(key, vector);
    if (queryVectorCache.size > 100) queryVectorCache.delete(queryVectorCache.keys().next().value);
    return vector;
  }

  return { rebuildIndex, refreshTextIndex, updateSemanticVectors, status, search, ragAnswer, analytics, rankCandidates, deleteDocumentVectors };
}

function indexBusyError(message) {
  const error = new Error(message);
  error.code = "INDEX_BUSY";
  return error;
}

async function buildChunks(state, context) {
  const chunks = [];
  for (const document of state.documents ?? []) {
    const documentChunks = await buildDocumentChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  return chunks;
}

async function buildChunksIncremental(state, existingChunkSidecar = new Map(), context) {
  const chunks = [];
  const existingByDocument = chunksByDocument(existingChunkSidecar);
  for (const document of state.documents ?? []) {
    const cachedChunks = existingByDocument.get(document.id) ?? [];
    if (cachedChunks.length > 0 && !documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: false })) {
      chunks.push(...cachedChunks.map((chunk) => refreshCachedChunkMetadata(chunk, document)));
      continue;
    }
    const documentChunks = await buildDocumentChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  return chunks;
}

async function buildLexicalChunksIncremental(state, existingChunkSidecar = new Map(), context) {
  const chunks = [];
  const existingByDocument = chunksByDocument(existingChunkSidecar);
  for (const document of state.documents ?? []) {
    const cachedChunks = existingByDocument.get(document.id) ?? [];
    if (cachedChunks.length > 0 && !documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: true })) {
      chunks.push(...cachedChunks.map((chunk) => refreshCachedChunkMetadata(chunk, document)));
      continue;
    }
    const documentChunks = buildDocumentLexicalChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  return chunks;
}

async function buildVectorChunksIncremental(state, existingChunkSidecar = new Map(), context) {
  const chunks = [];
  const existingByDocument = chunksByDocument(existingChunkSidecar);
  for (const document of state.documents ?? []) {
    const cachedChunks = existingByDocument.get(document.id) ?? [];
    if (cachedChunks.length > 0 && !documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: true })) {
      chunks.push(...cachedChunks.map((chunk) => refreshCachedChunkMetadata(chunk, document)));
      continue;
    }
    const documentChunks = buildDocumentLexicalChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  return chunks;
}

function buildLexicalChunkUpdatePlan(state, existingChunkSidecar = new Map(), context) {
  const allChunks = [];
  const changedChunks = [];
  const changedDocumentIds = [];
  const activeDocumentIds = new Set((state.documents ?? []).map((document) => String(document.id ?? "")).filter(Boolean));
  const removedDocumentIds = [];
  const existingByDocument = chunksByDocument(existingChunkSidecar);
  for (const documentId of existingByDocument.keys()) {
    if (!activeDocumentIds.has(String(documentId))) removedDocumentIds.push(String(documentId));
  }
  for (const document of state.documents ?? []) {
    const cachedChunks = existingByDocument.get(document.id) ?? [];
    if (cachedChunks.length > 0 && !documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: true })) {
      allChunks.push(...cachedChunks.map((chunk) => refreshCachedChunkMetadata(chunk, document)));
      continue;
    }
    const documentChunks = buildDocumentLexicalChunks(document, state, context).slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT);
    changedChunks.push(...documentChunks);
    allChunks.push(...documentChunks);
    changedDocumentIds.push(document.id);
  }
  return {
    allChunks: uniqueChunksById(allChunks),
    changedChunks: uniqueChunksById(changedChunks),
    changedDocumentIds: [...new Set(changedDocumentIds.map(String).filter(Boolean))],
    removedDocumentIds: [...new Set(removedDocumentIds)]
  };
}

function chunksByDocument(existingChunkSidecar = new Map()) {
  const byDocument = new Map();
  for (const chunk of existingChunkSidecar.values()) {
    const documentId = String(chunk.documentId ?? "");
    if (!documentId || chunk.type === "empty") continue;
    if (!byDocument.has(documentId)) byDocument.set(documentId, []);
    byDocument.get(documentId).push(chunk);
  }
  for (const chunks of byDocument.values()) chunks.sort((a, b) => Number(a.page) - Number(b.page));
  return byDocument;
}

function countActiveSidecarChunks(existingChunkSidecar = new Map(), state = {}) {
  const activeIds = new Set((state.documents ?? []).map((document) => String(document.id ?? "")).filter(Boolean));
  let count = 0;
  for (const chunk of existingChunkSidecar.values()) {
    if (activeIds.has(String(chunk.documentId ?? ""))) count += 1;
  }
  return count;
}

function removedDocumentIdsFromSidecar(existingChunkSidecar = new Map(), state = {}) {
  const activeIds = new Set((state.documents ?? []).map((document) => String(document.id ?? "")).filter(Boolean));
  const removed = new Set();
  for (const chunk of existingChunkSidecar.values()) {
    const documentId = String(chunk.documentId ?? "");
    if (documentId && !activeIds.has(documentId)) removed.add(documentId);
  }
  return [...removed];
}

async function canReturnFastRebuild(state = {}, existingChunkSidecar = new Map(), targetInfo = {}, vectorDir = "") {
  if (existingChunkSidecar.size === 0) return false;
  const byDocument = chunksByDocument(existingChunkSidecar);
  for (const document of state.documents ?? []) {
    const cachedChunks = byDocument.get(document.id) ?? [];
    if (cachedChunks.length === 0 || documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: true })) return false;
  }
  const activeChunks = [...existingChunkSidecar.values()]
    .filter((chunk) => chunk?.id && (state.documents ?? []).some((document) => document.id === chunk.documentId));
  const vectorCache = await readVectorCache(vectorDir);
  for (const chunk of activeChunks) {
    const cacheEntry = vectorCache.get(chunk.id);
    const text = vectorTextForChunk(chunk);
    const cached = cacheEntry
      && cacheEntry.hash === chunkContentHash(text)
      && cacheEntry.embeddingProvider === targetInfo.id
      && Number(cacheEntry.embeddingDimensions) === Number(targetInfo.dimensions)
      && Array.isArray(cacheEntry.vector)
      && cacheEntry.vector.length === Number(targetInfo.dimensions);
    if (!cached) return false;
  }
  try {
    const raw = await fs.readFile(path.join(vectorDir, "status.json"), "utf8");
    const stored = JSON.parse(raw);
    if (!stored.ready) return false;
    if (stored.embeddingProvider !== targetInfo.id) return false;
    if (Number(stored.embeddingDimensions) !== Number(targetInfo.dimensions)) return false;
    return true;
  } catch {
    return false;
  }
}

function canReturnFastLexicalRebuild(state = {}, existingChunkSidecar = new Map(), ftsStatus = null) {
  if (!ftsStatus?.ready || ftsStatus.stale) return false;
  if (existingChunkSidecar.size === 0) return false;
  const activeDocuments = (state.documents ?? []).filter((document) => document?.id);
  if (activeDocuments.length === 0) return false;
  const byDocument = chunksByDocument(existingChunkSidecar);
  for (const document of activeDocuments) {
    const cachedChunks = byDocument.get(document.id) ?? [];
    if (cachedChunks.length === 0 || documentIndexNeedsRebuild(document, cachedChunks, { allowLexicalOnly: true })) return false;
  }
  const activeSidecarCount = countActiveSidecarChunks(existingChunkSidecar, state);
  return activeSidecarCount > 0 && Number(ftsStatus.chunks) === activeSidecarCount;
}

function documentIndexNeedsRebuild(document = {}, cachedChunks = [], options = {}) {
  if (!cachedChunks.length) return true;
  if (!options.allowLexicalOnly && cachedChunks.some((chunk) => chunk.lexicalOnly === true)) return true;
  const expectedSignature = documentSourceFingerprint(document);
  const cachedSignature = cachedChunks.find((chunk) => chunk.documentSourceFingerprint)?.documentSourceFingerprint;
  return Boolean(cachedSignature && expectedSignature && cachedSignature !== expectedSignature);
}

function refreshCachedChunkMetadata(chunk = {}, document = {}) {
  return {
    ...chunk,
    title: document.title || chunk.title || "Untitled",
    documentSourceFingerprint: chunk.documentSourceFingerprint || documentSourceFingerprint(document),
    vector: undefined
  };
}

function documentSourceFingerprint(document = {}) {
  const blockParts = [];
  for (const chapter of document.chapters ?? []) {
    blockParts.push(chapter.id ?? "", chapter.title ?? "");
    for (const block of chapter.blocks ?? []) blockParts.push(blockFingerprint(block));
  }
  return createHash("sha1")
    .update(String(document.id ?? ""))
    .update("\u0001")
    .update(String(document.type ?? ""))
    .update("\u0001")
    .update(String(document.text?.length ?? 0))
    .update("\u0001")
    .update(blockParts.join("\u0001"))
    .digest("hex");
}

function blockFingerprint(block = {}) {
  if (typeof block === "string") return block.length > 120 ? `${block.length}:${block.slice(0, 60)}:${block.slice(-60)}` : block;
  if (!block || typeof block !== "object") return "";
  const text = String(block.text ?? "");
  const asset = String(block.src || block.href || block.fileName || "");
  return [
    block.type ?? "",
    block.pageNumber ?? "",
    text.length,
    text.slice(0, 60),
    text.slice(-60),
    asset
  ].join(":");
}

function uniqueChunksById(chunks = []) {
  const byId = new Map();
  for (const chunk of chunks) {
    if (!chunk?.id || byId.has(chunk.id)) continue;
    byId.set(chunk.id, chunk);
  }
  return [...byId.values()];
}

async function readChunkSidecar(vectorDir) {
  try {
    const raw = await fs.readFile(path.join(vectorDir, "chunks.json"), "utf8");
    const chunks = JSON.parse(raw);
    return new Map(Array.isArray(chunks) ? chunks.filter((chunk) => chunk?.id).map((chunk) => [chunk.id, chunk]) : []);
  } catch {
    return new Map();
  }
}

async function readStoredIndexStatus(vectorDir) {
  try {
    const raw = await fs.readFile(path.join(vectorDir, "status.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function vectorRowsNeedingWrite(sourceChunks = [], texts = [], vectorCache = new Map(), existingChunkSidecar = new Map(), targetInfo = {}) {
  const changedIds = new Set();
  const targetProvider = targetInfo.id;
  const targetDimensions = Number(targetInfo.dimensions) || 0;
  for (const [index, chunk] of sourceChunks.entries()) {
    const cacheEntry = vectorCache.get(chunk.id);
    const cached = cacheEntry
      && cacheEntry.hash === chunkContentHash(texts[index])
      && cacheEntry.embeddingProvider === targetProvider
      && Number(cacheEntry.embeddingDimensions) === targetDimensions
      && Array.isArray(cacheEntry.vector)
      && cacheEntry.vector.length === targetDimensions;
    if (!cached || !existingChunkSidecar.has(chunk.id)) changedIds.add(chunk.id);
  }
  return { changedIds };
}

function vectorTextForChunk(chunk = {}) {
  return `${chunk.title ?? ""}\n${chunk.chapterTitle ?? ""}\n${chunk.text ?? ""}`;
}

async function updateVectorTableIncremental(db, vectorRows = [], changedVectorRows = []) {
  if (vectorRows.length === 0) {
    try {
      await db.openTable("chunks");
      return { changedRows: 0, createdEmpty: false };
    } catch {
      return { changedRows: 0, createdEmpty: true };
    }
  }

  let table;
  try {
    table = await db.openTable("chunks");
  } catch {
    await db.createTable("chunks", vectorRows, { mode: "overwrite" });
    return { changedRows: vectorRows.length, createdEmpty: false };
  }

  if (changedVectorRows.length === 0) return { changedRows: 0, createdEmpty: false };

  try {
    await table.mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(changedVectorRows);
  } catch {
    for (const row of changedVectorRows) {
      try {
        await table.delete(`id = ${sqlStringLiteral(row.id)}`);
      } catch {
        // Continue with add fallback.
      }
    }
    await table.add(changedVectorRows, { mode: "append" });
  }
  return { changedRows: changedVectorRows.length, createdEmpty: false };
}

async function deleteLanceDocumentRows(vectorDir, documentId = "") {
  try {
    const db = await lancedb.connect(vectorDir);
    const table = await db.openTable("chunks");
    const result = await table.delete(`documentId = ${sqlStringLiteral(documentId)}`);
    return Number(result?.numDeletedRows ?? 0);
  } catch {
    return 0;
  }
}

async function readVectorCache(vectorDir) {
  try {
    const raw = await fs.readFile(path.join(vectorDir, VECTOR_CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed) ? parsed : [];
    return new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  } catch {
    return new Map();
  }
}

async function writeVectorCache(vectorDir, chunks, texts, runtimeInfo) {
  const entries = chunks
    .map((chunk, index) => ({
      id: chunk.id,
      hash: chunkContentHash(texts[index]),
      embeddingProvider: runtimeInfo.id,
      embeddingDimensions: runtimeInfo.dimensions,
      vector: chunk.vector
    }))
    .filter((entry) => Array.isArray(entry.vector) && entry.vector.length === Number(runtimeInfo.dimensions));
  await fs.writeFile(path.join(vectorDir, VECTOR_CACHE_FILE), JSON.stringify({
    version: 1,
    embeddingProvider: runtimeInfo.id,
    embeddingDimensions: runtimeInfo.dimensions,
    updatedAt: new Date().toISOString(),
    entries
  }), "utf8");
}

async function pruneVectorCacheToChunkIds(vectorDir, chunkIds = new Set()) {
  const cachePath = path.join(vectorDir, VECTOR_CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed) ? parsed : [];
    const nextEntries = entries.filter((entry) => chunkIds.has(entry?.id));
    await fs.writeFile(cachePath, JSON.stringify({
      ...(Array.isArray(parsed) ? {} : parsed),
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: nextEntries
    }), "utf8");
  } catch {
    // No vector cache exists yet.
  }
}

function chunkContentHash(text = "") {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

async function buildDocumentChunks(document, state, context) {
  const chunks = [];
  const chapters = Array.isArray(document.chapters) && document.chapters.length > 0
    ? document.chapters
    : [{ id: "chapter-1", title: document.title, blocks: [{ type: "text", text: document.text ?? "" }] }];
  let pageCursor = 0;
  const known = knownSet(state, context.normalizeJapaneseTerm);
  const minedSentences = new Set((state.cards ?? []).map((card) => context.normalizeJapaneseTerm(card.sentence)).filter(Boolean));

  for (const [chapterIndex, chapter] of chapters.entries()) {
    const chapterId = chapter.id || `chapter-${chapterIndex + 1}`;
    const chapterTitle = chapter.title || document.title || `Chapter ${chapterIndex + 1}`;
    const virtualPages = chapterVirtualPages(chapter.blocks ?? []);
    for (const page of virtualPages) {
      const pageIndex = pageCursor;
      pageCursor += Math.max(1, page.pageSpan || 1);
      const cleanPageText = cleanChunkText(page.text);
      const authorRubyReadings = rubyReadingsFromText(page.text);
      if (!cleanPageText || cleanPageText.length < 6) continue;

      const paragraphTexts = compactParagraphs(cleanPageText);
      for (const paragraph of paragraphTexts) {
        if (paragraph.length >= 80) {
          chunks.push(await createTextChunk({
            document,
            chapterId,
            chapterTitle,
            page: pageIndex,
            type: "paragraph",
            text: paragraph,
            known,
            minedSentences,
            authorRubyReadings,
            state,
            context
          }));
          if (chunks.length >= MAX_INDEX_SENTENCES_PER_DOCUMENT) return chunks;
        }
      }

      for (const sentence of splitSentences(cleanPageText)) {
        const clean = cleanChunkText(sentence);
        if (clean.length < 6) continue;
        chunks.push(await createTextChunk({
          document,
          chapterId,
          chapterTitle,
          page: pageIndex,
          type: "sentence",
          text: clean,
          known,
          minedSentences,
          authorRubyReadings,
          state,
          context
        }));
        if (chunks.length >= MAX_INDEX_SENTENCES_PER_DOCUMENT) return chunks;
      }
    }
  }
  return chunks;
}

function buildDocumentLexicalChunks(document, state, context) {
  const chunks = [];
  const chapters = Array.isArray(document.chapters) && document.chapters.length > 0
    ? document.chapters
    : [{ id: "chapter-1", title: document.title, blocks: [{ type: "text", text: document.text ?? "" }] }];
  let pageCursor = 0;
  const known = knownSet(state, context.normalizeJapaneseTerm);

  for (const [chapterIndex, chapter] of chapters.entries()) {
    const chapterId = chapter.id || `chapter-${chapterIndex + 1}`;
    const chapterTitle = chapter.title || document.title || `Chapter ${chapterIndex + 1}`;
    const virtualPages = chapterVirtualPages(chapter.blocks ?? []);
    for (const page of virtualPages) {
      const pageIndex = pageCursor;
      pageCursor += Math.max(1, page.pageSpan || 1);
      const cleanPageText = cleanChunkText(page.text);
      const authorRubyReadings = rubyReadingsFromText(page.text);
      if (!cleanPageText || cleanPageText.length < 6) continue;

      for (const paragraph of compactParagraphs(cleanPageText)) {
        if (paragraph.length < 80) continue;
        chunks.push(createLexicalTextChunk({
          document,
          chapterId,
          chapterTitle,
          page: pageIndex,
          type: "paragraph",
          text: paragraph,
          known,
          authorRubyReadings,
          state,
          context
        }));
        if (chunks.length >= MAX_INDEX_SENTENCES_PER_DOCUMENT) return chunks;
      }

      for (const sentence of splitSentences(cleanPageText)) {
        const clean = cleanChunkText(sentence);
        if (clean.length < 6) continue;
        chunks.push(createLexicalTextChunk({
          document,
          chapterId,
          chapterTitle,
          page: pageIndex,
          type: "sentence",
          text: clean,
          known,
          authorRubyReadings,
          state,
          context
        }));
        if (chunks.length >= MAX_INDEX_SENTENCES_PER_DOCUMENT) return chunks;
      }
    }
  }
  return chunks;
}

async function createTextChunk({ document, chapterId, chapterTitle, page, type, text, known, minedSentences, authorRubyReadings = [], state, context }) {
  const analysis = await safeAnalyzeText(context.analyzeText, text);
  const terms = chunkTermsFromAnalysis(analysis, context);
  const dictionaryForms = [...new Set(terms.map((term) => term.base).filter(Boolean))];
  const knownCoverage = knownCoverageFromTerms(terms, known, context.normalizeJapaneseTerm);
  const dictionaryMatches = dictionaryForms.filter((term) => {
    try {
      return context.lookupDictionary(term).length > 0;
    } catch {
      return false;
    }
  });

  return {
    id: createChunkId(document.id, chapterId, page, type, text),
    documentId: document.id,
    title: document.title,
    documentSourceFingerprint: documentSourceFingerprint(document),
    chapterId,
    chapterTitle,
    page,
    text,
    type,
    knownCoverage,
    terms: [...new Set(terms.map((term) => term.surface).filter(Boolean))].slice(0, 40),
    dictionaryForms: dictionaryForms.slice(0, 40),
    dictionaryMatches: dictionaryMatches.slice(0, 20),
    authorRubyReadings: authorRubyReadings
      .filter((item) => text.includes(item.surface))
      .slice(0, 40),
    mined: minedSentences.has(context.normalizeJapaneseTerm(text)),
    readAtIndex: isChunkReadSafe({ documentId: document.id, page, type }, state, {})
  };
}

function createLexicalTextChunk({ document, chapterId, chapterTitle, page, type, text, known, authorRubyReadings = [], state, context }) {
  const terms = lexicalTermsFromText(text, context);
  const knownCoverage = knownCoverageFromTerms(terms, known, context.normalizeJapaneseTerm);
  return {
    id: createChunkId(document.id, chapterId, page, type, text),
    documentId: document.id,
    title: document.title,
    documentSourceFingerprint: documentSourceFingerprint(document),
    chapterId,
    chapterTitle,
    page,
    text,
    type,
    lexicalOnly: true,
    knownCoverage,
    terms: [...new Set(terms.map((term) => term.surface).filter(Boolean))].slice(0, 80),
    dictionaryForms: [...new Set(terms.map((term) => term.base).filter(Boolean))].slice(0, 80),
    dictionaryMatches: [],
    authorRubyReadings: authorRubyReadings
      .filter((item) => text.includes(item.surface))
      .slice(0, 40),
    mined: false,
    readAtIndex: isChunkReadSafe({ documentId: document.id, page, type }, state, {})
  };
}

function lexicalTermsFromText(text = "", context = {}) {
  const terms = [];
  const seen = new Set();
  const normalize = context.normalizeJapaneseTerm ?? ((value) => String(value ?? "").normalize("NFKC").trim());
  const add = (value) => {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized) || !context.hasJapaneseText?.(normalized)) return;
    seen.add(normalized);
    terms.push({ surface: normalized, base: normalized });
  };
  for (const match of String(text ?? "").normalize("NFKC").matchAll(/[\u3400-\u9fff][\u3040-\u30ff\u3400-\u9fff]{0,8}/gu)) {
    add(match[0]);
  }
  for (const match of String(text ?? "").normalize("NFKC").matchAll(/[\u3400-\u9fff]{2,}/gu)) {
    add(match[0]);
  }
  return terms.slice(0, 80);
}

function chapterVirtualPages(blocks = []) {
  const pages = [];
  let textBuffer = [];
  let count = 0;

  function flushText() {
    if (textBuffer.length === 0) return;
    pages.push({ text: textBuffer.join("\n"), pageSpan: 1 });
    textBuffer = [];
    count = 0;
  }

  for (const originalBlock of blocks) {
    const expandedBlocks = splitLongTextBlock(originalBlock, READER_PAGE_CHAR_LIMIT);
    for (const block of expandedBlocks) {
      if (block.type === "page") {
        flushText();
        pages.push({ text: blocksToText(block.blocks ?? []), pageSpan: 1, sourcePageNumber: block.pageNumber });
        continue;
      }
      if (block.type === "image") {
        flushText();
        pages.push({ text: "", pageSpan: 1 });
        continue;
      }
      const text = block.type === "text" || block.type === "link" ? String(block.text ?? "") : "";
      if (!text.trim()) continue;
      if (textBuffer.length > 0 && count + text.length > READER_PAGE_CHAR_LIMIT) flushText();
      textBuffer.push(text);
      count += text.length;
    }
  }
  flushText();
  return pages.length > 0 ? pages : [{ text: blocksToText(blocks), pageSpan: 1 }];
}

function splitLongTextBlock(block = {}, charLimit = READER_PAGE_CHAR_LIMIT) {
  if (block.type !== "text" || String(block.text ?? "").length <= charLimit) return [block];
  return chunkTextBySentences(block.text, charLimit).map((text) => ({ ...block, text }));
}

function chunkTextBySentences(text = "", charLimit = READER_PAGE_CHAR_LIMIT) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > charLimit) {
      chunks.push(current);
      current = "";
    }
    current += current ? `\n${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [String(text ?? "").slice(0, charLimit)];
}

function blocksToText(blocks = []) {
  return blocks
    .flatMap((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text;
      if (block?.type === "link") return block.text;
      if (block?.type === "page") return blocksToText(block.blocks ?? []);
      return [];
    })
    .join("\n");
}

async function safeAnalyzeText(analyzeText, text = "") {
  try {
    return await analyzeText(text);
  } catch {
    return { tokens: [], candidates: [] };
  }
}

function chunkTermsFromAnalysis(analysis = {}, context) {
  const tokens = Array.isArray(analysis.tokens) ? analysis.tokens : [];
  const terms = [];
  for (const token of tokens) {
    const surface = context.normalizeJapaneseTerm(token.surface ?? "");
    const base = context.normalizeJapaneseTerm(token.dictionaryForm || token.base || token.surface || "");
    if (!surface || !context.hasJapaneseText(surface)) continue;
    if (!context.hasKanji(surface) && !context.hasKanji(base)) continue;
    terms.push({ surface, base });
  }
  if (terms.length > 0) return terms;
  return queryTermsForLexical(textFromAnalysis(analysis)).map((term) => ({ surface: term, base: context.normalizeJapaneseTerm(term) }));
}

function textFromAnalysis(analysis = {}) {
  return (analysis.tokens ?? []).map((token) => token.surface ?? "").join("");
}

function knownCoverageFromTerms(terms = [], known, normalizeJapaneseTerm) {
  const content = terms.map((term) => normalizeJapaneseTerm(term.base || term.surface)).filter(Boolean);
  if (content.length === 0) return 100;
  const knownCount = content.filter((term) => known.has(term)).length;
  return Math.round((knownCount / content.length) * 100);
}

function compactParagraphs(text = "") {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length > 0) return paragraphs;
  return [String(text ?? "").replace(/\s+/g, " ").trim()].filter(Boolean);
}

function splitSentences(text = "") {
  return cleanChunkText(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[\u3002\uff01\uff1f!?])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanChunkText(value = "") {
  return String(value ?? "")
    .replace(/\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g, (_match, surface) => {
      try {
        return decodeURIComponent(surface);
      } catch {
        return surface;
      }
    })
    .replace(/<rt[\s\S]*?<\/rt>/gi, "")
    .replace(/<rp[\s\S]*?<\/rp>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rubyReadingsFromText(value = "") {
  const readings = [];
  for (const match of String(value ?? "").matchAll(/\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g)) {
    const surface = decodeRubyMarker(match[1]);
    const reading = decodeRubyMarker(match[2]);
    if (surface && reading) readings.push({ surface, reading });
  }
  return readings;
}

function decodeRubyMarker(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hashEmbedText(text = "") {
  const vector = Array.from({ length: HASH_VECTOR_DIMENSIONS }, () => 0);
  const normalized = String(text ?? "").normalize("NFKC").toLowerCase();
  const grams = [];
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index <= normalized.length - size; index += 1) grams.push(normalized.slice(index, index + size));
  }
  for (const gram of grams) {
    const digest = createHash("sha1").update(gram).digest();
    const slot = digest[0] % HASH_VECTOR_DIMENSIONS;
    vector[slot] += digest[1] % 2 === 0 ? 1 : -1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

async function queryVariantsForSearch(query = "", context = {}) {
  const variants = new Set([String(query ?? "").normalize("NFKC").trim()].filter(Boolean));
  for (const term of queryTermsForLexical(query)) variants.add(context.normalizeJapaneseTerm?.(term) ?? term);
  for (const match of String(query ?? "").normalize("NFKC").matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
    const normalized = context.normalizeJapaneseTerm?.(match[0] ?? "") ?? String(match[0] ?? "").normalize("NFKC").trim();
    if (usefulQueryTerm(normalized)) variants.add(normalized);
  }
  return [...variants].filter(Boolean);
}

async function lexicalSearch(query = "", queryVariants = [], vectorDir, limit = 20) {
  try {
    const raw = await fs.readFile(path.join(vectorDir, "chunks.json"), "utf8");
    const chunks = JSON.parse(raw);
    return chunks
      .map((chunk) => ({ ...chunk, lexicalScore: lexicalScore(query, queryVariants, chunk.text, chunk) }))
      .filter((chunk) => chunk.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function hybridLexicalSearch(query = "", queryVariants = [], context = {}) {
  const { ftsSearch, vectorDir, limit = 20, documentId = "" } = context;
  const japaneseQuery = /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(query ?? ""));
  if (ftsSearch && typeof ftsSearch.search === "function") {
    try {
      const result = await ftsSearch.search(query, { limit, documentId });
      if (japaneseQuery && Array.isArray(result?.results)) return { rows: result.results, source: "fts-japanese" };
      if (result?.status?.ready && Array.isArray(result.results)) return { rows: result.results, source: "fts-ready" };
      if (Array.isArray(result.results) && result.results.length > 0) return { rows: result.results, source: "fts-results" };
    } catch {
      // Fall through to the sidecar lexical scan below.
    }
  }
  return { rows: await lexicalSearch(query, queryVariants, vectorDir, limit), source: "sidecar" };
}

function shouldRunVectorSearch(query = "", lexicalRows = [], context = {}) {
  const resultLimit = Math.max(1, Number(context.resultLimit) || 8);
  const regexJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(query ?? ""));
  const helperJapanese = typeof context.hasJapaneseText === "function" ? context.hasJapaneseText(query) : false;
  const isJapanese = regexJapanese || helperJapanese;
  if (isJapanese) return false;
  if (lexicalRows.some((row) => Number(row.exactScore) > 0)) return false;
  if (lexicalRows.length >= resultLimit) return false;
  return true;
}

function vectorFilterPredicate(context = {}) {
  const clauses = [];
  const activeIds = [...(context.activeDocumentIds ?? [])].filter(Boolean);
  if (activeIds.length === 0) return "documentId = '__no_active_documents__'";
  clauses.push(`documentId IN (${activeIds.map(sqlStringLiteral).join(", ")})`);

  if (context.scope === "document" && context.documentId) {
    clauses.push(`documentId = ${sqlStringLiteral(context.documentId)}`);
  }
  if (context.includeCards === false) {
    clauses.push(`type != 'card'`);
  }
  if (context.readSafe) {
    const safeClauses = [];
    const state = context.state ?? {};
    for (const documentId of activeIds) {
      const progressPage = Number(state.progress?.[documentId]?.page);
      const currentPage = context.documentId === documentId && Number.isFinite(Number(context.currentPage))
        ? Number(context.currentPage)
        : NaN;
      const page = Number.isFinite(currentPage) ? currentPage : progressPage;
      if (Number.isFinite(page)) safeClauses.push(`(documentId = ${sqlStringLiteral(documentId)} AND page <= ${Math.max(-1, Math.floor(page))})`);
    }
    if (context.includeCards !== false) safeClauses.push(`type = 'card'`);
    clauses.push(`(${safeClauses.length ? safeClauses.join(" OR ") : "documentId = '__no_read_safe_documents__'"})`);
  }

  return clauses.join(" AND ");
}

function lexicalScore(query = "", queryVariants = [], text = "", chunk = {}) {
  const normalizedQuery = String(query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const normalizedText = String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery || !normalizedText) return 0;
  const terms = [
    normalizedQuery,
    ...queryVariants,
    ...queryTermsForLexical(normalizedQuery)
  ].map((term) => String(term ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  const termScores = terms.map((term) => lexicalScoreTerm(term, normalizedText));
  const dictionaryForms = new Set(arrayFromPossiblyLanceList(chunk.dictionaryForms).map((term) => String(term).normalize("NFKC").toLowerCase().replace(/\s+/g, "")));
  const termMatches = terms.some((term) => dictionaryForms.has(term));
  return Math.max(...termScores, termMatches ? 12 : 0);
}

function lexicalScoreTerm(term = "", normalizedText = "") {
  const normalizedQuery = String(term ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery || !normalizedText) return 0;
  let score = 0;
  if (normalizedText.includes(normalizedQuery)) score += 10 + Math.min(10, normalizedQuery.length);
  const queryChars = [...new Set([...normalizedQuery])];
  const matchedChars = queryChars.filter((char) => normalizedText.includes(char)).length;
  score += matchedChars / Math.max(1, queryChars.length);
  for (let size = 2; size <= Math.min(4, normalizedQuery.length); size += 1) {
    for (let index = 0; index <= normalizedQuery.length - size; index += 1) {
      if (normalizedText.includes(normalizedQuery.slice(index, index + size))) score += 0.75;
    }
  }
  return score;
}

function retrievalScore(row = {}, query = "", options = {}) {
  let score = combinedScore(row);
  if (Number(row.exactScore) > 0) score += 20;
  const normalizedText = String(row.text ?? "").normalize("NFKC").replace(/\s+/g, "");
  const normalizedQuery = String(query ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (normalizedQuery && normalizedText.includes(normalizedQuery)) score += 12;
  const variants = (options.queryVariants ?? []).map((term) => String(term ?? "").normalize("NFKC").replace(/\s+/g, "")).filter(Boolean);
  const dictionaryForms = new Set(arrayFromPossiblyLanceList(row.dictionaryForms).map((term) => String(term).normalize("NFKC").replace(/\s+/g, "")));
  const terms = new Set(arrayFromPossiblyLanceList(row.terms).map((term) => String(term).normalize("NFKC").replace(/\s+/g, "")));
  for (const variant of variants) {
    if (variant && normalizedText.includes(variant)) score += 8 + Math.min(8, variant.length);
    if (dictionaryForms.has(variant)) score += 10;
    if (terms.has(variant)) score += 6;
  }
  if (options.documentId && row.documentId === options.documentId) score += 3;
  if (Number.isFinite(Number(options.currentPage)) && Number.isFinite(Number(row.page))) {
    const distance = Math.abs(Number(row.page) - Number(options.currentPage));
    score += Math.max(0, 4 - Math.min(4, distance));
  }
  if (row.type === "paragraph") score += 0.4;
  if (row.type === "card") score += 0.8;
  score += Math.min(1, (Number(row.knownCoverage) || 0) / 100);
  return score;
}

function publicSearchResult(row = {}, query = "", options = {}, state = {}) {
  return {
    id: row.id,
    documentId: row.documentId,
    title: row.title,
    chapterId: row.chapterId,
    chapterTitle: row.chapterTitle,
    page: Number(row.page) || 0,
    text: row.text,
    type: row.type,
    knownCoverage: Number(row.knownCoverage) || 0,
    terms: arrayFromPossiblyLanceList(row.terms).slice(0, 20),
    dictionaryForms: arrayFromPossiblyLanceList(row.dictionaryForms).slice(0, 20),
    dictionaryMatches: arrayFromPossiblyLanceList(row.dictionaryMatches).slice(0, 20),
    mined: Boolean(row.mined),
    readSafe: isChunkReadSafe(row, state, options),
    source: row.source || (row.lexicalScore ? "lexical" : "vector"),
    exactScore: Number(row.exactScore) || 0,
    bm25Score: Number.isFinite(Number(row.bm25Score)) ? Number(row.bm25Score) : null,
    score: Number(retrievalScore(row, query, options).toFixed(3))
  };
}

function arrayFromPossiblyLanceList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value ? [value] : [];
    }
  }
  if (value && typeof value === "object" && Array.isArray(value.values)) return value.values.map(String);
  return [];
}

function encodeChunkForVectorTable(chunk = {}) {
  return {
    id: String(chunk.id ?? ""),
    documentId: String(chunk.documentId ?? ""),
    title: String(chunk.title ?? ""),
    chapterId: String(chunk.chapterId ?? ""),
    chapterTitle: String(chunk.chapterTitle ?? ""),
    page: Number.isFinite(Number(chunk.page)) ? Number(chunk.page) : 0,
    text: String(chunk.text ?? ""),
    type: String(chunk.type ?? "sentence"),
    knownCoverage: Number(chunk.knownCoverage) || 0,
    terms: JSON.stringify(chunk.terms ?? []),
    dictionaryForms: JSON.stringify(chunk.dictionaryForms ?? []),
    dictionaryMatches: JSON.stringify(chunk.dictionaryMatches ?? []),
    mined: Boolean(chunk.mined),
    readAtIndex: Boolean(chunk.readAtIndex),
    vector: Array.isArray(chunk.vector) ? chunk.vector : []
  };
}

function queryTermsForLexical(query = "") {
  const terms = new Set();
  const normalized = String(query ?? "").normalize("NFKC");
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    for (const part of segmenter.segment(normalized)) {
      const term = String(part.segment ?? "").trim();
      if (part.isWordLike && usefulQueryTerm(term)) terms.add(term);
    }
  }
  for (const match of normalized.matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
    const value = match[0];
    if (usefulQueryTerm(value)) terms.add(value);
    for (const kanjiMatch of value.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
      if (usefulQueryTerm(kanjiMatch[0])) terms.add(kanjiMatch[0]);
    }
  }
  return [...terms];
}

function usefulQueryTerm(term = "") {
  const value = String(term ?? "").trim();
  if (value.length < 2) return false;
  if (/^(\u306b\u3064\u3044\u3066|\u3068\u3057\u3066|\u3053\u3068|\u3082\u306e|\u305d\u308c|\u3053\u308c|\u3069\u3053|\u51fa\u3066|\u304f\u308b|\u63a2\u3057\u3066|\u6587\u3092|\u3059\u308b|\u3044\u308b|\u3042\u308b)$/u.test(value)) return false;
  return /[\u3400-\u9fff]/u.test(value) || value.length >= 3;
}

function combinedScore(row = {}) {
  return (Number(row.lexicalScore) || 0) + (Number(row.vectorScore) || 0);
}

function uniqueSearchResult() {
  const seen = new Set();
  return (row) => {
    const key = `${row.type}\u0001${String(row.text ?? "").normalize("NFKC").replace(/\s+/g, "")}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function isChunkReadSafe(row = {}, state = {}, options = {}) {
  if (row.type === "card") return true;
  const progress = state.progress?.[row.documentId];
  if (!progress && options.documentId && row.documentId === options.documentId && Number.isFinite(Number(options.currentPage))) {
    return Number(row.page) <= Number(options.currentPage);
  }
  if (!progress) return false;
  return Number(row.page) <= Number(progress.page ?? -1);
}

function metricsFromTokens(tokens = [], known, hasJapaneseText, hasKanji, normalizeJapaneseTerm) {
  const contentTokens = tokens.filter((token) => hasJapaneseText(token.surface) && token.pos !== "\u8a18\u53f7");
  let knownTokens = 0;
  const unknownTermCounts = new Map();
  const properNameCounts = new Map();
  for (const token of contentTokens) {
    const term = normalizeJapaneseTerm(token.base || token.surface);
    if (!term || !hasKanji(token.surface)) continue;
    if (isProperNameToken(token)) {
      properNameCounts.set(term, (properNameCounts.get(term) ?? 0) + 1);
      continue;
    }
    const learned = known.has(term) || known.has(normalizeJapaneseTerm(token.surface));
    if (learned) knownTokens += 1;
    else unknownTermCounts.set(term, (unknownTermCounts.get(term) ?? 0) + 1);
  }
  const unknownTokens = [...unknownTermCounts.values()].reduce((sum, count) => sum + count, 0);
  const total = knownTokens + unknownTokens;
  return {
    coverage: total ? Math.round((knownTokens / total) * 100) : 100,
    knownTokens,
    unknownTokens,
    uniqueUnknown: unknownTermCounts.size,
    unknownTermCounts,
    properNameCounts
  };
}

function cheapDocumentMetrics(document = {}, known = new Set(), context = {}) {
  const { hasKanji, normalizeJapaneseTerm } = context;
  const sample = String(document.text ?? "").slice(0, MAX_ANALYTICS_CHARS);
  let knownTokens = 0;
  let unknownTokens = 0;
  const unknownTerms = new Set();

  const candidates = uniqueFallbackTerms(sample, normalizeJapaneseTerm, hasKanji);
  for (const term of candidates) {
    if (known.has(term)) {
      knownTokens += 1;
    } else {
      unknownTokens += 1;
      unknownTerms.add(term);
    }
  }

  const total = knownTokens + unknownTokens;
  return {
    source: "fallback",
    coverage: total ? Math.round((knownTokens / total) * 100) : 100,
    knownTokens,
    unknownTokens,
    uniqueUnknown: unknownTerms.size
  };
}

function uniqueFallbackTerms(text = "", normalizeJapaneseTerm, hasKanji) {
  const terms = new Set();
  for (const match of String(text ?? "").normalize("NFKC").matchAll(/[\u3400-\u9fff][\u3040-\u30ff\u3400-\u9fff]{0,5}/gu)) {
    const normalized = normalizeJapaneseTerm(match[0]);
    if (normalized && hasKanji(normalized)) terms.add(normalized);
  }
  return [...terms].slice(0, 5000);
}

function safeRevisions(getRevisions) {
  try {
    return typeof getRevisions === "function" ? getRevisions() : {};
  } catch {
    return {};
  }
}

function analyticsSignature(state = {}, revisions = {}) {
  const documents = (state.documents ?? []).map((document) => [
    document.id,
    document.updatedAt ?? "",
    String(document.text ?? "").length,
    Number(state.progress?.[document.id]?.page ?? 0)
  ]);
  return JSON.stringify({
    revisions: {
      documents: revisions.documents ?? 0,
      knownTerms: revisions.known_terms ?? 0,
      progress: revisions.reading_progress ?? 0,
      cards: revisions.cards ?? 0,
      dictionaries: revisions.dictionaries ?? 0,
      ml: revisions["settings:ml"] ?? 0
    },
    documents,
    knownTerms: state.knownTerms?.length ?? 0,
    cards: state.cards?.length ?? 0
  });
}

function isProperNameToken(token = {}) {
  const details = [
    token.posDetail1,
    token.posDetail2,
    token.posDetail3,
    token.pos_detail_1,
    token.pos_detail_2,
    token.pos_detail_3
  ].map((value) => String(value ?? ""));
  return details.some((value) =>
    value === "\u56fa\u6709\u540d\u8a5e" ||
    value === "\u4eba\u540d" ||
    value === "\u5730\u57df"
  );
}

function knownSet(state, normalizeJapaneseTerm) {
  return new Set((state.knownTerms ?? []).map(normalizeJapaneseTerm).filter(Boolean));
}

function averageSentenceLength(text = "") {
  const sentences = splitSentences(text).slice(0, 500);
  if (sentences.length === 0) return 0;
  return Math.round(sentences.reduce((sum, sentence) => sum + sentence.length, 0) / sentences.length);
}

function kanjiDensity(text = "", hasKanji) {
  const chars = [...String(text ?? "").replace(/\s+/g, "")];
  if (chars.length === 0) return 0;
  return Math.round((chars.filter(hasKanji).length / chars.length) * 100);
}

function difficultyLabel(coverage) {
  if (coverage >= 95) return "Comfortable";
  if (coverage >= 88) return "Stretch";
  return "Hard";
}

function countEventsByTerm(events = [], normalizeJapaneseTerm) {
  const counts = new Map();
  for (const event of events) {
    const term = normalizeJapaneseTerm(event.payload?.term ?? "");
    if (!term) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function countTermOccurrences(text = "", term = "") {
  if (!text || !term) return 0;
  return String(text).split(term).length - 1;
}

function createChunkId(...parts) {
  return createHash("sha1").update(parts.join("\u0001")).digest("hex");
}

function sqlStringLiteral(value = "") {
  return `'${String(value).replace(/'/g, "''")}'`;
}
