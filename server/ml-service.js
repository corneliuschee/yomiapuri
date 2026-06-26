import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";

const HASH_VECTOR_DIMENSIONS = 128;
const MAX_INDEX_SENTENCES_PER_DOCUMENT = 2500;
const MAX_ANALYTICS_CHARS = 120000;
const READER_PAGE_CHAR_LIMIT = 850;

export function createHashEmbeddingProvider() {
  return {
    id: "local-hash-ngram-v1",
    label: "Local hash n-gram fallback",
    dimensions: HASH_VECTOR_DIMENSIONS,
    async embed(text = "") {
      return hashEmbedText(text);
    }
  };
}

export function createMlService({
  getState,
  vectorDir,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  embeddingProvider = createHashEmbeddingProvider()
}) {
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

  async function rebuildIndex() {
    await fs.mkdir(vectorDir, { recursive: true });
    const state = getState();
    const sourceChunks = await buildChunks(state, {
      analyzeText,
      lookupDictionary,
      normalizeJapaneseTerm,
      hasJapaneseText,
      hasKanji
    });
    const chunks = [];
    for (const chunk of sourceChunks) {
      chunks.push({
        ...chunk,
        vector: await embeddingProvider.embed(`${chunk.title}\n${chunk.chapterTitle}\n${chunk.text}`)
      });
    }

    const db = await lancedb.connect(vectorDir);
    const vectorRows = chunks.map(encodeChunkForVectorTable);
    if (chunks.length > 0) {
      await db.createTable("chunks", vectorRows, { mode: "overwrite" });
    } else {
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
        terms: [],
        dictionaryForms: [],
        mined: false,
        readAtIndex: false,
        vector: await embeddingProvider.embed("")
      }], { mode: "overwrite" });
    }

    indexStatus = {
      provider: "lancedb",
      embeddingProvider: embeddingProvider.id,
      embeddingProviderLabel: embeddingProvider.label,
      embeddingDimensions: embeddingProvider.dimensions,
      vectorDir,
      ready: true,
      chunks: chunks.length,
      rebuiltAt: new Date().toISOString(),
      error: ""
    };
    await fs.writeFile(path.join(vectorDir, "chunks.json"), JSON.stringify(chunks.map(({ vector, ...chunk }) => chunk)), "utf8");
    await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
    return withRuntimeStatus(indexStatus);
  }

  async function status() {
    if (indexStatus.ready || indexStatus.error) return withRuntimeStatus(indexStatus);
    try {
      const raw = await fs.readFile(path.join(vectorDir, "status.json"), "utf8");
      indexStatus = { ...indexStatus, ...JSON.parse(raw) };
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
      scope = "library"
    } = options;
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) return { query: "", results: [], status: await status() };
    const currentStatus = await status();
    if (!currentStatus.ready) return { query: normalizedQuery, results: [], status: currentStatus };

    const db = await lancedb.connect(vectorDir);
    const table = await db.openTable("chunks");
    const resultLimit = Math.max(1, Math.min(20, Number(limit) || 8));
    const [vectorRows, lexicalRows] = await Promise.all([
      table.search(await embeddingProvider.embed(normalizedQuery)).limit(Math.max(resultLimit * 6, 30)).toArray(),
      lexicalSearch(normalizedQuery, vectorDir, resultLimit * 6)
    ]);

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

    const state = getState();
    const rows = [...byId.values()]
      .filter((row) => includeCards || row.type !== "card")
      .filter((row) => scope !== "document" || !documentId || row.documentId === documentId)
      .filter((row) => !readSafe || isChunkReadSafe(row, state, { documentId, currentPage }))
      .sort((a, b) => retrievalScore(b, normalizedQuery, { documentId, currentPage }) - retrievalScore(a, normalizedQuery, { documentId, currentPage }))
      .filter(uniqueSearchResult())
      .slice(0, resultLimit);

    return {
      query: normalizedQuery,
      results: rows.map((row) => publicSearchResult(row, normalizedQuery, { documentId, currentPage }, state)),
      status: currentStatus
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

  async function analytics() {
    const state = getState();
    const events = await eventLog.recent(1500);
    const known = knownSet(state, normalizeJapaneseTerm);
    const documents = [];

    for (const document of state.documents ?? []) {
      const analysis = await analyzeText(String(document.text ?? "").slice(0, MAX_ANALYTICS_CHARS));
      const tokenMetrics = metricsFromTokens(analysis.tokens, known, hasJapaneseText, hasKanji, normalizeJapaneseTerm);
      documents.push({
        id: document.id,
        title: document.title,
        type: document.type,
        coverage: tokenMetrics.coverage,
        knownTokens: tokenMetrics.knownTokens,
        unknownTokens: tokenMetrics.unknownTokens,
        uniqueUnknown: tokenMetrics.uniqueUnknown,
        averageSentenceLength: averageSentenceLength(document.text),
        kanjiDensity: kanjiDensity(document.text, hasKanji),
        difficulty: difficultyLabel(tokenMetrics.coverage)
      });
    }

    const exportedEvents = events.filter((event) => event.type === "anki.exported");
    const previewEvents = events.filter((event) => event.type === "sentence.previewed");
    const lookupEvents = events.filter((event) => event.type === "lookup.performed");
    const wordAddedEvents = events.filter((event) => event.type === "wordbank.added");

    return {
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
    return {
      ...statusValue,
      embeddingProvider: statusValue.embeddingProvider || embeddingProvider.id,
      embeddingProviderLabel: statusValue.embeddingProviderLabel || embeddingProvider.label,
      embeddingDimensions: statusValue.embeddingDimensions || embeddingProvider.dimensions,
      stale: Boolean(mlState.indexStale),
      staleReason: mlState.indexStaleReason || ""
    };
  }

  return { rebuildIndex, status, search, ragAnswer, analytics, rankCandidates };
}

async function buildChunks(state, context) {
  const chunks = [];
  for (const document of state.documents ?? []) {
    const documentChunks = await buildDocumentChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  chunks.push(...buildCardChunks(state, context.normalizeJapaneseTerm));
  return chunks;
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
          state,
          context
        }));
        if (chunks.length >= MAX_INDEX_SENTENCES_PER_DOCUMENT) return chunks;
      }
    }
  }
  return chunks;
}

async function createTextChunk({ document, chapterId, chapterTitle, page, type, text, known, minedSentences, state, context }) {
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
    chapterId,
    chapterTitle,
    page,
    text,
    type,
    knownCoverage,
    terms: [...new Set(terms.map((term) => term.surface).filter(Boolean))].slice(0, 40),
    dictionaryForms: dictionaryForms.slice(0, 40),
    dictionaryMatches: dictionaryMatches.slice(0, 20),
    mined: minedSentences.has(context.normalizeJapaneseTerm(text)),
    readAtIndex: isChunkReadSafe({ documentId: document.id, page, type }, state, {})
  };
}

function buildCardChunks(state, normalizeJapaneseTerm) {
  const chunks = [];
  for (const card of state.cards ?? []) {
    const text = [card.expression, card.reading, card.meaning, card.sentence].filter(Boolean).join(" - ");
    const clean = cleanChunkText(text);
    if (!clean) continue;
    chunks.push({
      id: createChunkId(card.id || card.ankiNoteId || "", "card", 0, clean),
      documentId: card.documentId || "",
      title: card.source || "Anki card",
      chapterId: "",
      chapterTitle: "Mined cards",
      page: 0,
      text: clean,
      type: "card",
      knownCoverage: 100,
      terms: [card.expression, card.dictionaryForm].map(normalizeJapaneseTerm).filter(Boolean),
      dictionaryForms: [card.dictionaryForm || card.expression].map(normalizeJapaneseTerm).filter(Boolean),
      dictionaryMatches: [],
      mined: true,
      readAtIndex: true
    });
  }
  return chunks;
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

async function lexicalSearch(query = "", vectorDir, limit = 20) {
  try {
    const raw = await fs.readFile(path.join(vectorDir, "chunks.json"), "utf8");
    const chunks = JSON.parse(raw);
    return chunks
      .map((chunk) => ({ ...chunk, lexicalScore: lexicalScore(query, chunk.text, chunk) }))
      .filter((chunk) => chunk.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function lexicalScore(query = "", text = "", chunk = {}) {
  const normalizedQuery = String(query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const normalizedText = String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery || !normalizedText) return 0;
  const terms = [
    normalizedQuery,
    ...queryTermsForLexical(normalizedQuery),
    ...arrayFromPossiblyLanceList(chunk.dictionaryForms),
    ...arrayFromPossiblyLanceList(chunk.terms)
  ].filter(Boolean);
  const termScores = terms.map((term) => lexicalScoreTerm(term, normalizedText));
  return Math.max(...termScores);
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
  const normalizedText = String(row.text ?? "").normalize("NFKC").replace(/\s+/g, "");
  const normalizedQuery = String(query ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (normalizedQuery && normalizedText.includes(normalizedQuery)) score += 12;
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
    ...chunk,
    terms: JSON.stringify(chunk.terms ?? []),
    dictionaryForms: JSON.stringify(chunk.dictionaryForms ?? []),
    dictionaryMatches: JSON.stringify(chunk.dictionaryMatches ?? [])
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
