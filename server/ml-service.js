import { createHash } from "node:crypto";

const MAX_INDEX_SENTENCES_PER_DOCUMENT = 2500;
const READER_PAGE_CHAR_LIMIT = 850;

export function createMlService({
  getState,
  getRevisions = () => ({}),
  eventLog = null,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch = null
}) {
  let textRefreshInProgress = false;
  let analyticsCache = null;

  async function refreshTextIndex(options = {}) {
    if (textRefreshInProgress) throw indexBusyError("Text search index refresh is already running.");
    textRefreshInProgress = true;
    try {
      options.onProgress?.({
        phase: "text",
        message: "Preparing SQLite FTS5 text index...",
        current: 0,
        total: 1
      });

      const state = getState() ?? {};
      const chunks = await buildTextChunks(state, {
        normalizeJapaneseTerm,
        hasJapaneseText,
        hasKanji
      });
      const activeDocumentIds = (state.documents ?? [])
        .map((document) => String(document.id ?? ""))
        .filter(Boolean);

      const textSearch = ftsSearch && typeof ftsSearch.rebuild === "function"
        ? await ftsSearch.rebuild(chunks, {
            analyze: false,
            pruneDocuments: activeDocumentIds
          })
        : {
            provider: "sqlite-fts5",
            ready: false,
            stale: true,
            chunks: 0,
            error: "SQLite FTS5 service is unavailable."
          };

      options.onProgress?.({
        phase: "text",
        message: "SQLite FTS5 text index refreshed.",
        current: 1,
        total: 1
      });
      analyticsCache = null;
      return {
        ...textSearch,
        provider: "sqlite-fts5",
        chunks: Number(textSearch.chunks) || chunks.length,
        textSearch,
        updatedAt: textSearch.updatedAt || new Date().toISOString()
      };
    } finally {
      textRefreshInProgress = false;
    }
  }

  async function status() {
    const state = getState() ?? {};
    let fts = {
      provider: "sqlite-fts5",
      ready: false,
      stale: true,
      chunks: 0,
      error: "SQLite FTS5 service is unavailable."
    };
    try {
      if (ftsSearch && typeof ftsSearch.status === "function") fts = ftsSearch.status();
    } catch (error) {
      fts = { ...fts, error: error.message };
    }

    const stateStale = Boolean(state.ml?.indexStale);
    const stale = stateStale || Boolean(fts.stale);
    const staleReason = String(state.ml?.indexStaleReason || fts.error || "");
    const textSearch = {
      ...fts,
      provider: "sqlite-fts5",
      ready: Boolean(fts.ready) && !stale,
      stale,
      staleReason
    };

    return {
      provider: "sqlite-fts5",
      ready: textSearch.ready,
      stale,
      staleReason,
      chunks: Number(textSearch.chunks) || 0,
      rebuiltAt: textSearch.rebuiltAt || "",
      updatedAt: textSearch.updatedAt || textSearch.rebuiltAt || "",
      inserted: Number(textSearch.inserted) || 0,
      updated: Number(textSearch.updated) || 0,
      deleted: Number(textSearch.deleted) || 0,
      skipped: Number(textSearch.skipped) || 0,
      tokenizerMode: textSearch.tokenizerMode || "kuromoji-dictionary-aware-v1",
      tokenizerVersion: textSearch.tokenizerVersion || "",
      normalizerVersion: textSearch.normalizerVersion || "",
      dictionarySignature: textSearch.dictionarySignature || "",
      error: textSearch.error || "",
      fts: textSearch,
      textSearch
    };
  }

  async function deleteDocumentSearchIndex(documentId = "") {
    const normalizedDocumentId = String(documentId ?? "");
    if (!normalizedDocumentId) return { deleted: 0, ftsDeleted: 0 };

    const result = ftsSearch && typeof ftsSearch.deleteDocument === "function"
      ? ftsSearch.deleteDocument(normalizedDocumentId)
      : { deleted: 0 };
    const deleted = Number(result?.deleted) || 0;
    analyticsCache = null;
    return {
      deleted,
      ftsDeleted: deleted,
      ready: (await status()).ready
    };
  }

  async function analytics() {
    const state = getState() ?? {};
    const revisions = safeRevisions(getRevisions);
    const signature = analyticsSignature(state, revisions);
    if (analyticsCache?.signature === signature) {
      return { ...analyticsCache.value, cached: true };
    }

    const events = eventLog && typeof eventLog.recent === "function"
      ? await eventLog.recent(1500)
      : [];
    const known = knownSet(state, normalizeJapaneseTerm);
    const indexedAnalytics = typeof ftsSearch?.documentAnalytics === "function"
      ? ftsSearch.documentAnalytics(known, {
          normalizeJapaneseTerm,
          hasJapaneseText,
          hasKanji
        })
      : new Map();
    const documents = [];

    for (const document of state.documents ?? []) {
      try {
        const tokenMetrics = indexedAnalytics.get(document.id)
          ?? cheapDocumentMetrics(document, known, {
            normalizeJapaneseTerm,
            hasJapaneseText,
            hasKanji
          });
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
        averageCoverage: documents.length
          ? Math.round(documents.reduce((sum, item) => sum + item.coverage, 0) / documents.length)
          : 0,
        candidateAcceptanceRate: previewEvents.length
          ? Math.round((exportedEvents.length / previewEvents.length) * 100)
          : 0,
        lookupToWordBankRate: lookupEvents.length
          ? Math.round((wordAddedEvents.length / lookupEvents.length) * 100)
          : 0
      },
      documents: documents.sort((a, b) => b.coverage - a.coverage),
      recentEvents: events.slice(-12).reverse()
    };
    analyticsCache = { signature, value };
    return { ...value, cached: false };
  }

  async function rankCandidates(documentId, candidates = []) {
    const state = getState() ?? {};
    const document = (state.documents ?? []).find((item) => item.id === documentId);
    const known = knownSet(state, normalizeJapaneseTerm);
    const events = eventLog && typeof eventLog.recent === "function"
      ? await eventLog.recent(1000)
      : [];
    const lookupCounts = countEventsByTerm(
      events.filter((event) => event.type === "lookup.performed"),
      normalizeJapaneseTerm
    );
    const exportedTerms = new Set(
      (state.cards ?? [])
        .map((card) => normalizeJapaneseTerm(card.dictionaryForm || card.expression))
        .filter(Boolean)
    );
    const docText = document?.text ?? "";

    const ranked = [];
    for (const candidate of candidates) {
      const term = normalizeJapaneseTerm(candidate.dictionaryForm || candidate.expression);
      const sentenceAnalysis = await safeAnalyzeText(analyzeText, candidate.sentence || candidate.expression || "");
      const metrics = metricsFromTokens(sentenceAnalysis.tokens, known, {
        hasJapaneseText,
        hasKanji,
        normalizeJapaneseTerm
      });
      const recurrence = countTermOccurrences(docText, term);
      const recentLookups = lookupCounts.get(term) ?? 0;
      const hasDictionary = (candidate.dictionaryEntries?.length ?? 0) > 0
        || safeLookup(lookupDictionary, term).length > 0;
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

  return {
    refreshTextIndex,
    status,
    analytics,
    rankCandidates,
    deleteDocumentSearchIndex
  };
}

function indexBusyError(message) {
  const error = new Error(message);
  error.code = "INDEX_BUSY";
  return error;
}

async function buildTextChunks(state, context) {
  const chunks = [];
  for (const document of state.documents ?? []) {
    const documentChunks = buildDocumentLexicalChunks(document, state, context);
    chunks.push(...documentChunks.slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT));
  }
  return chunks;
}

function buildDocumentLexicalChunks(document, state, context) {
  const chunks = [];
  const chapters = Array.isArray(document.chapters) && document.chapters.length > 0
    ? document.chapters
    : [{
        id: "chapter-1",
        title: document.title,
        blocks: [{ type: "text", text: document.text ?? "" }]
      }];
  let pageCursor = 0;
  const known = knownSet(state, context.normalizeJapaneseTerm);

  for (const [chapterIndex, chapter] of chapters.entries()) {
    const chapterId = chapter.id || "chapter-" + (chapterIndex + 1);
    const chapterTitle = chapter.title || document.title || "Chapter " + (chapterIndex + 1);
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

function createLexicalTextChunk({
  document,
  chapterId,
  chapterTitle,
  page,
  type,
  text,
  known,
  authorRubyReadings = [],
  state,
  context
}) {
  const terms = lexicalTermsFromText(text, context);
  const knownCoverage = knownCoverageFromTerms(terms, known, context.normalizeJapaneseTerm);
  return {
    id: createChunkId(document.id, chapterId, page, type, text),
    documentId: String(document.id ?? ""),
    title: String(document.title ?? ""),
    chapterId: String(chapterId ?? ""),
    chapterTitle: String(chapterTitle ?? ""),
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
    readAtIndex: isChunkReadSafe({ documentId: document.id, page, type }, state)
  };
}

function lexicalTermsFromText(text = "", context = {}) {
  const terms = [];
  const seen = new Set();
  const normalize = context.normalizeJapaneseTerm
    ?? ((value) => String(value ?? "").normalize("NFKC").trim());
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
        pages.push({
          text: blocksToText(block.blocks ?? []),
          pageSpan: 1,
          sourcePageNumber: block.pageNumber
        });
        continue;
      }
      if (block.type === "image") {
        flushText();
        pages.push({ text: "", pageSpan: 1 });
        continue;
      }
      const text = block.type === "text" || block.type === "link"
        ? String(block.text ?? "")
        : "";
      if (!text.trim()) continue;
      if (textBuffer.length > 0 && count + text.length > READER_PAGE_CHAR_LIMIT) flushText();
      textBuffer.push(text);
      count += text.length;
    }
  }

  flushText();
  return pages.length > 0
    ? pages
    : [{ text: blocksToText(blocks), pageSpan: 1 }];
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
    current += current ? "\n" + sentence : sentence;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [String(text ?? "").slice(0, charLimit)];
}

function blocksToText(blocks = []) {
  return blocks
    .flatMap((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text" || block?.type === "link") return block.text;
      if (block?.type === "page") return blocksToText(block.blocks ?? []);
      return [];
    })
    .join("\n");
}

function splitSentences(text = "") {
  return cleanChunkText(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[\u3002\uff01\uff1f!?])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactParagraphs(text = "") {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return paragraphs.length > 0
    ? paragraphs
    : [String(text ?? "").replace(/\s+/g, " ").trim()].filter(Boolean);
}

function cleanChunkText(value = "") {
  return String(value ?? "")
    .replace(/\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g, (_match, surface) => decodeRubyMarker(surface))
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
    return String(value ?? "");
  }
}

function createChunkId(documentId, chapterId, page, type, text) {
  return createHash("sha1")
    .update([
      String(documentId ?? ""),
      String(chapterId ?? ""),
      String(page ?? 0),
      String(type ?? ""),
      String(text ?? "")
    ].join("\u0001"), "utf8")
    .digest("hex");
}

function knownSet(state, normalize) {
  return new Set(
    (state.knownTerms ?? [])
      .map((term) => normalize(term))
      .filter(Boolean)
  );
}

function knownCoverageFromTerms(terms = [], known, normalize) {
  const content = terms.map((term) => normalize(term.base || term.surface)).filter(Boolean);
  if (content.length === 0) return 100;
  const knownCount = content.filter((term) => known.has(term)).length;
  return Math.round((knownCount / content.length) * 100);
}

function isChunkReadSafe(row = {}, state = {}) {
  if (row.type === "card") return true;
  const progress = state.progress?.[row.documentId];
  if (!progress) return false;
  return Number(row.page) <= Number(progress.page ?? -1);
}

function safeRevisions(getRevisions) {
  try {
    return getRevisions?.() ?? {};
  } catch {
    return {};
  }
}

function analyticsSignature(state, revisions) {
  const documents = (state.documents ?? []).map((document) => [
    document.id,
    document.updatedAt ?? document.createdAt ?? "",
    String(document.text ?? "").length
  ]);
  return JSON.stringify({
    documents,
    knownTerms: (state.knownTerms ?? []).length,
    cards: (state.cards ?? []).length,
    revisions
  });
}

function cheapDocumentMetrics(document, known, context) {
  const terms = lexicalTermsFromText(document.text ?? "", context);
  const knownTokens = terms.filter((term) => known.has(term.base)).length;
  const unknownTerms = new Set(terms.filter((term) => !known.has(term.base)).map((term) => term.base));
  const total = knownTokens + unknownTerms.size;
  return {
    source: "fallback",
    chunks: 0,
    coverage: total ? Math.round((knownTokens / total) * 100) : 0,
    knownTokens,
    unknownTokens: unknownTerms.size,
    uniqueUnknown: unknownTerms.size
  };
}

function metricsFromTokens(tokens = [], known, context) {
  const contentTokens = tokens.filter((token) =>
    context.hasJapaneseText(token.surface) && token.pos !== "\u8a18\u53f7"
  );
  let knownTokens = 0;
  const unknownTerms = new Set();
  for (const token of contentTokens) {
    const surface = context.normalizeJapaneseTerm(token.surface || "");
    const term = context.normalizeJapaneseTerm(token.dictionaryForm || token.base || surface);
    if (!term || !context.hasKanji(surface || term)) continue;
    if (known.has(term) || known.has(surface)) knownTokens += 1;
    else unknownTerms.add(term);
  }
  const total = knownTokens + unknownTerms.size;
  return {
    coverage: total ? Math.round((knownTokens / total) * 100) : 0,
    uniqueUnknown: unknownTerms.size
  };
}

async function safeAnalyzeText(analyzeText, text = "") {
  try {
    return await analyzeText(text);
  } catch {
    return { tokens: [], candidates: [] };
  }
}

function safeLookup(lookupDictionary, term) {
  try {
    const result = lookupDictionary?.(term);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function countEventsByTerm(events = [], normalize) {
  const counts = new Map();
  for (const event of events) {
    const term = normalize(event.payload?.term ?? event.term ?? "");
    if (!term) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function countTermOccurrences(text = "", term = "") {
  if (!text || !term) return 0;
  return text.split(term).length - 1;
}

function averageSentenceLength(text = "") {
  const sentences = splitSentences(text);
  return sentences.length
    ? Math.round(sentences.reduce((sum, sentence) => sum + sentence.length, 0) / sentences.length)
    : 0;
}

function kanjiDensity(text = "", hasKanji) {
  const value = String(text ?? "");
  if (!value) return 0;
  const kanjiCount = [...value].filter((char) => hasKanji(char)).length;
  return Math.round((kanjiCount / value.length) * 100);
}

function difficultyLabel(coverage) {
  if (coverage >= 95) return "Comfortable";
  if (coverage >= 88) return "Stretch";
  return "Challenging";
}
