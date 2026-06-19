import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";

const VECTOR_DIMENSIONS = 128;
const MAX_INDEX_SENTENCES_PER_DOCUMENT = 2500;
const MAX_ANALYTICS_CHARS = 120000;

export function createMlService({
  getState,
  vectorDir,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji
}) {
  let indexStatus = {
    provider: "lancedb",
    vectorDir,
    ready: false,
    chunks: 0,
    rebuiltAt: "",
    error: ""
  };

  async function rebuildIndex() {
    await fs.mkdir(vectorDir, { recursive: true });
    const state = getState();
    const chunks = buildChunks(state, normalizeJapaneseTerm).map((chunk) => ({
      ...chunk,
      vector: embedText(`${chunk.title}\n${chunk.text}`)
    }));
    const db = await lancedb.connect(vectorDir);
    if (chunks.length > 0) {
      await db.createTable("chunks", chunks, { mode: "overwrite" });
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
        mined: false,
        vector: embedText("")
      }], { mode: "overwrite" });
    }
    indexStatus = {
      provider: "lancedb",
      vectorDir,
      ready: true,
      chunks: chunks.length,
      rebuiltAt: new Date().toISOString(),
      error: ""
    };
    await fs.writeFile(path.join(vectorDir, "chunks.json"), JSON.stringify(chunks.map(({ vector, ...chunk }) => chunk)), "utf8");
    await fs.writeFile(path.join(vectorDir, "status.json"), JSON.stringify(indexStatus, null, 2), "utf8");
    return indexStatus;
  }

  async function status() {
    if (indexStatus.ready || indexStatus.error) return indexStatus;
    try {
      const raw = await fs.readFile(path.join(vectorDir, "status.json"), "utf8");
      indexStatus = { ...indexStatus, ...JSON.parse(raw) };
    } catch {
      indexStatus = { ...indexStatus, ready: false };
    }
    return indexStatus;
  }

  async function search(query, { limit = 8 } = {}) {
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) return { query: "", results: [], status: await status() };
    const currentStatus = await status();
    if (!currentStatus.ready) return { query: normalizedQuery, results: [], status: currentStatus };
    const db = await lancedb.connect(vectorDir);
    const table = await db.openTable("chunks");
    const resultLimit = Math.max(1, Math.min(20, Number(limit) || 8));
    const [vectorRows, lexicalRows] = await Promise.all([
      table.search(embedText(normalizedQuery)).limit(Math.max(resultLimit * 4, 20)).toArray(),
      lexicalSearch(normalizedQuery, vectorDir, resultLimit * 4)
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
    const rows = [...byId.values()]
      .sort((a, b) => combinedScore(b) - combinedScore(a))
      .filter(uniqueSearchResult())
      .slice(0, resultLimit);
    return {
      query: normalizedQuery,
      results: rows
        .map((row) => ({
          id: row.id,
          documentId: row.documentId,
          title: row.title,
          chapterId: row.chapterId,
          chapterTitle: row.chapterTitle,
          page: row.page,
          text: row.text,
          type: row.type,
          knownCoverage: Number(row.knownCoverage) || 0,
          mined: Boolean(row.mined),
          score: Number(combinedScore(row).toFixed(3))
        })),
      status: currentStatus
    };
  }

  async function ragAnswer(question) {
    const result = await search(question, { limit: 6 });
    const citations = result.results.slice(0, 5);
    const answer = citations.length === 0
      ? "No indexed local evidence was found. Rebuild the ML index after importing or reading books."
      : [
          "Relevant local evidence:",
          ...citations.map((item, index) => `${index + 1}. ${item.text}`)
        ].join("\n");
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

  return { rebuildIndex, status, search, ragAnswer, analytics, rankCandidates };
}

function buildChunks(state, normalizeJapaneseTerm) {
  const chunks = [];
  for (const document of state.documents ?? []) {
    const chapters = Array.isArray(document.chapters) && document.chapters.length > 0
      ? document.chapters
      : [{ id: "chapter-1", title: document.title, blocks: [{ type: "text", text: document.text ?? "" }] }];
    let page = 0;
    for (const chapter of chapters) {
      const text = blocksToText(chapter.blocks ?? []) || document.text || "";
      const sentences = splitSentences(text).slice(0, MAX_INDEX_SENTENCES_PER_DOCUMENT);
      for (const sentence of sentences) {
        const clean = cleanChunkText(sentence);
        if (clean.length < 6) continue;
        chunks.push({
          id: createChunkId(document.id, chapter.id || chapter.title || "", page, clean),
          documentId: document.id,
          title: document.title,
          chapterId: chapter.id || "",
          chapterTitle: chapter.title || document.title,
          page,
          text: clean,
          type: "sentence",
          knownCoverage: 0,
          mined: (state.cards ?? []).some((card) => normalizeJapaneseTerm(card.sentence) === normalizeJapaneseTerm(clean))
        });
        page += 1;
      }
    }
  }
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
      mined: true
    });
  }
  return chunks;
}

function splitSentences(text = "") {
  return cleanChunkText(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function blocksToText(blocks = []) {
  return blocks.map((block) => typeof block === "string" ? block : block?.text ?? "").join("\n");
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
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function embedText(text = "") {
  const vector = Array.from({ length: VECTOR_DIMENSIONS }, () => 0);
  const normalized = String(text ?? "").normalize("NFKC").toLowerCase();
  const grams = [];
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index <= normalized.length - size; index += 1) grams.push(normalized.slice(index, index + size));
  }
  for (const gram of grams) {
    const digest = createHash("sha1").update(gram).digest();
    const slot = digest[0] % VECTOR_DIMENSIONS;
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
      .map((chunk) => ({ ...chunk, lexicalScore: lexicalScore(query, chunk.text) }))
      .filter((chunk) => chunk.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function lexicalScore(query = "", text = "") {
  const normalizedQuery = String(query ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const normalizedText = String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery || !normalizedText) return 0;
  const termScores = queryTermsForLexical(normalizedQuery).map((term) => lexicalScoreTerm(term, normalizedText));
  return Math.max(...termScores, lexicalScoreTerm(normalizedQuery, normalizedText));
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

function queryTermsForLexical(query = "") {
  const terms = new Set();
  if (globalThis.Intl?.Segmenter) {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    for (const part of segmenter.segment(query)) {
      const term = String(part.segment ?? "").trim();
      if (part.isWordLike && usefulQueryTerm(term)) terms.add(term);
    }
  }
  for (const match of query.matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
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
  if (/^(について|として|こと|もの|それ|これ|どこ|出て|くる|探して|文を|する|いる|ある)$/u.test(value)) return false;
  return /[\u3400-\u9fff]/u.test(value) || value.length >= 3;
}

function combinedScore(row = {}) {
  return (Number(row.lexicalScore) || 0) + (Number(row.vectorScore) || 0);
}

function uniqueSearchResult() {
  const seen = new Set();
  return (row) => {
    const key = String(row.text ?? "").normalize("NFKC").replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function metricsFromTokens(tokens = [], known, hasJapaneseText, hasKanji, normalizeJapaneseTerm) {
  const contentTokens = tokens.filter((token) => hasJapaneseText(token.surface) && token.pos !== "記号");
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
