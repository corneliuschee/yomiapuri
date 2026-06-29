import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLearningEventLog } from "../server/learning-events.js";
import { createMlService } from "../server/ml-service.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kanji-reader-ml-"));
const state = {
  documents: [{
    id: "doc-1",
    title: "Test Novel",
    type: "txt",
    text: "図書館へ行く。図書館で本を読む。山を見る。雪ノ下が来る。",
    chapters: [{
      id: "chapter-1",
      title: "Chapter One",
      blocks: [{ type: "text", text: "図書館へ行く。図書館で本を読む。山を見る。雪ノ下が来る。" }]
    }]
  }],
  progress: {
    "doc-1": { page: 4, percentage: 100, updatedAt: "2026-01-01T00:00:00.000Z" }
  },
  knownTerms: ["行く"],
  cards: []
};

const normalizeJapaneseTerm = (value = "") => String(value ?? "").normalize("NFKC").trim();
const hasJapaneseText = (value = "") => /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value));
const hasKanji = (value = "") => /[\u3400-\u9fff]/u.test(String(value));
const lookupDictionary = (term = "") => term === "図書館"
  ? [{ term: "図書館", reading: "としょかん", definitions: ["library"] }]
  : [];
const analyzeText = async (text = "") => ({
  tokens: String(text).match(/雪ノ下|図書館|行く|本|読む|山|見る|来る|へ|で|が|。/gu)?.map((surface, index) => ({
    surface,
    base: surface === "読む" ? "読む" : surface,
    reading: "",
    pos: surface === "。" ? "記号" : "名詞",
    posDetail1: surface === "雪ノ下" ? "固有名詞" : "",
    posDetail2: surface === "雪ノ下" ? "人名" : "",
    learned: surface === "行く",
    eligible: hasKanji(surface) && surface !== "行く",
    start: index
  })) ?? [],
  candidates: []
});

const eventLog = createLearningEventLog({ eventsPath: path.join(tmp, "events.jsonl") });
await eventLog.append("lookup.performed", { term: "図書館" });

const service = createMlService({
  getState: () => state,
  vectorDir: path.join(tmp, "vector-index"),
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji
});

const ranked = await service.rankCandidates("doc-1", [{
  expression: "図書館",
  dictionaryForm: "図書館",
  sentence: "図書館へ行く。",
  dictionaryEntries: lookupDictionary("図書館")
}]);
assert.equal(ranked[0].expression, "図書館");
assert.equal(ranked[0].rankBadges.includes("recent lookup"), true);
assert.equal(ranked[0].rankBadges.includes("dictionary match"), true);

const analytics = await service.analytics();
assert.equal(analytics.totals.documents, 1);
assert.equal(Object.prototype.hasOwnProperty.call(analytics, "recommendations"), false);
assert.equal(analytics.metrics.lookupToWordBankRate, 0);

const status = await service.rebuildIndex();
assert.equal(status.ready, true);
assert.equal(status.provider, "lancedb");
assert.equal(status.chunks > 0, true);

const search = await service.search("図書館", { limit: 3 });
assert.equal(search.results.length > 0, true);
assert.match(search.results[0].text, /図書館/);

const rag = await service.ragAnswer("図書館はどこに出る?");
assert.equal(rag.citations.length > 0, true);
assert.match(rag.answer, /Retrieved local evidence/);

const vectorDelete = await service.deleteDocumentVectors("doc-1");
assert.equal(vectorDelete.deleted > 0, true);
assert.equal(vectorDelete.chunks, 0);
const deletedSearch = await service.search("å›³æ›¸é¤¨", { limit: 3 });
assert.equal(deletedSearch.results.length, 0);
await service.rebuildIndex();

const unreadState = {
  ...state,
  progress: {
    "doc-1": { page: -1, percentage: 0, updatedAt: "2026-01-01T00:00:00.000Z" }
  }
};
const unreadService = createMlService({
  getState: () => unreadState,
  vectorDir: path.join(tmp, "vector-index"),
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji
});
const safeSearch = await unreadService.search("山を見る", { readSafe: true, limit: 5 });
assert.equal(safeSearch.results.some((item) => /山/.test(item.text)), false);

let queryEmbedCalls = 0;
const countingEmbeddingProvider = {
  id: "counting-test",
  label: "Counting test",
  dimensions: 4,
  info() {
    return { id: "counting-test", label: "Counting test", dimensions: 4 };
  },
  async embed() {
    queryEmbedCalls += 1;
    return [1, 0, 0, 0];
  },
  async embedMany(texts = []) {
    return texts.map(() => [1, 0, 0, 0]);
  }
};
const exactFtsSearch = {
  rebuild() {
    return { provider: "sqlite-fts5", ready: true, chunks: 1 };
  },
  status() {
    return { provider: "sqlite-fts5", ready: true, chunks: 1 };
  },
  async search() {
    return {
      results: [{
        id: "exact-hit",
        documentId: "doc-1",
        title: "Test Novel",
        chapterId: "chapter-1",
        chapterTitle: "Chapter One",
        page: 0,
        text: "\u544a\u767d\u3055\u308c\u305f\u3002",
        type: "sentence",
        lexicalScore: 50,
        exactScore: 1,
        source: "fts-exact"
      }]
    };
  },
  deleteDocument() {
    return { deleted: 0 };
  }
};
const exactService = createMlService({
  getState: () => ({
    ...state,
    documents: [{
      ...state.documents[0],
      text: "\u544a\u767d\u3055\u308c\u305f\u3002",
      chapters: [{ id: "chapter-1", title: "Chapter One", blocks: [{ type: "text", text: "\u544a\u767d\u3055\u308c\u305f\u3002" }] }]
    }]
  }),
  vectorDir: path.join(tmp, "exact-vector-index"),
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch: exactFtsSearch,
  embeddingProvider: countingEmbeddingProvider
});
await exactService.rebuildIndex();
queryEmbedCalls = 0;
const exactSearch = await exactService.search("\u544a\u767d", { limit: 3 });
assert.equal(exactSearch.results[0].source, "fts-exact");
assert.equal(queryEmbedCalls, 0);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ML service test passed.");
