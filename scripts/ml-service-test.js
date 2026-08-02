import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLearningEventLog } from "../server/learning-events.js";
import { createMlService } from "../server/ml-service.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yomiapuri-ml-"));
const documentText = "\u56f3\u66f8\u9928\u3078\u884c\u304f\u3002\u56f3\u66f8\u9928\u3067\u672c\u3092\u8aad\u3080\u3002";
const state = {
  documents: [{
    id: "doc-1",
    title: "Test Novel",
    type: "txt",
    text: documentText,
    chapters: [{
      id: "chapter-1",
      title: "Chapter One",
      blocks: [{ type: "text", text: documentText }]
    }]
  }],
  progress: {
    "doc-1": { page: 1, percentage: 100, updatedAt: "2026-01-01T00:00:00.000Z" }
  },
  knownTerms: ["\u884c\u304f"],
  cards: []
};

const normalizeJapaneseTerm = (value = "") => String(value ?? "").normalize("NFKC").trim();
const hasJapaneseText = (value = "") => /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value));
const hasKanji = (value = "") => /[\u3400-\u9fff]/u.test(String(value));
const lookupDictionary = (term = "") => term === "\u56f3\u66f8\u9928"
  ? [{ term: "\u56f3\u66f8\u9928", reading: "\u3068\u3057\u3087\u304b\u3093", definitions: ["library"] }]
  : [];

const tokenSpecs = [
  ["\u56f3\u66f8\u9928", "\u56f3\u66f8\u9928", "\u3068\u3057\u3087\u304b\u3093"],
  ["\u884c\u304f", "\u884c\u304f", "\u3044\u304f"],
  ["\u672c", "\u672c", "\u307b\u3093"]
];

const analyzeText = async (text = "") => {
  const tokens = [];
  for (const [surface, base, reading] of tokenSpecs) {
    let start = String(text).indexOf(surface);
    while (start >= 0) {
      tokens.push({
        surface,
        base,
        dictionaryForm: base,
        reading,
        displayReading: reading,
        lookupTerms: [surface, base],
        pos: "\u540d\u8a5e",
        start
      });
      start = String(text).indexOf(surface, start + surface.length);
    }
  }
  return { tokens: tokens.sort((left, right) => left.start - right.start), candidates: [] };
};

const indexedRows = new Map();
const deletedDocuments = [];
const ftsSearch = {
  async rebuild(chunks = [], options = {}) {
    const documentIds = new Set(
      Array.isArray(options.pruneDocuments)
        ? options.pruneDocuments.map(String)
        : chunks.map((chunk) => String(chunk.documentId))
    );
    for (const [id, row] of indexedRows) {
      if (documentIds.has(String(row.documentId))) indexedRows.delete(id);
    }
    for (const chunk of chunks) indexedRows.set(String(chunk.id), { ...chunk });
    return this.status();
  },
  status() {
    return {
      provider: "sqlite-fts5",
      ready: true,
      stale: false,
      chunks: indexedRows.size,
      rebuiltAt: "2026-01-01T00:00:00.000Z"
    };
  },
  async search(query = "", options = {}) {
    const normalizedQuery = normalizeJapaneseTerm(query);
    const rows = [...indexedRows.values()].filter((row) => {
      if (options.documentId && String(row.documentId) !== String(options.documentId)) return false;
      return String(row.text ?? "").includes(normalizedQuery);
    });
    return { query: normalizedQuery, results: rows.map((row) => ({ ...row, source: "fts-exact", exactScore: 1 })) };
  },
  deleteDocument(documentId = "") {
    const before = indexedRows.size;
    for (const [id, row] of indexedRows) {
      if (String(row.documentId) === String(documentId)) indexedRows.delete(id);
    }
    const deleted = before - indexedRows.size;
    if (deleted > 0) deletedDocuments.push(String(documentId));
    return { deleted };
  },
  documentAnalytics() {
    return new Map([[
      "doc-1",
      { source: "sqlite-fts5", chunks: indexedRows.size, coverage: 50, knownTokens: 1, unknownTokens: 1, uniqueUnknown: 1 }
    ]]);
  }
};

const eventLog = createLearningEventLog({ eventsPath: path.join(tmp, "events.jsonl") });
await eventLog.append("lookup.performed", { term: "\u56f3\u66f8\u9928" });

const service = createMlService({
  getState: () => state,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch
});

const refreshed = await service.refreshTextIndex();
assert.equal(refreshed.provider === "sqlite-fts5" || refreshed.fts?.provider === "sqlite-fts5", true);
assert.equal(refreshed.ready, true);

const status = await service.status();
assert.equal(status.ready, true);
assert.equal(status.fts?.provider === "sqlite-fts5" || status.provider === "sqlite-fts5", true);
assert.equal(Number(status.chunks ?? status.fts?.chunks) > 0, true);

const analytics = await service.analytics();
assert.equal(analytics.totals.documents, 1);
assert.equal(analytics.totals.indexChunks > 0, true);
assert.equal(Object.prototype.hasOwnProperty.call(analytics, "recommendations"), false);

const search = await ftsSearch.search("\u56f3\u66f8\u9928", { limit: 3 });
assert.equal(search.results.length > 0, true);
assert.match(search.results[0].text, /\u56f3\u66f8\u9928/);

const deleted = await service.deleteDocumentSearchIndex("doc-1");
assert.equal(deleted.deleted > 0, true);
assert.equal(deletedDocuments.includes("doc-1"), true);
assert.equal((await ftsSearch.search("\u56f3\u66f8\u9928", { limit: 3 })).results.length, 0);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ML service test passed.");
