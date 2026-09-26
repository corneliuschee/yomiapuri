import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFtsSearchService, escapeFtsTerm } from "../src/backend/fts-search-service.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yomi-fts-"));
const dbPath = path.join(tmp, "yomiapuri.sqlite");
const documents = [{ id: "doc-1", title: "Test Book" }];
const state = { documents };

const normalizeJapaneseTerm = (value = "") => String(value ?? "").normalize("NFKC").trim();
const analyzeText = async (text = "") => {
  const terms = [
    ["告白", "告白", "こくはく"],
    ["遅れました", "遅れる", "おくれる"],
    ["遅れまし", "遅れる", "おくれる"],
    ["周", "周", "あまね"],
    ["私", "私", "わたし"],
    ["図書館", "図書館", "としょかん"],
    ["行く", "行く", "いく"]
  ];
  const tokens = [];
  for (const [surface, base, reading] of terms) {
    let index = String(text).indexOf(surface);
    while (index !== -1) {
      tokens.push({
        surface,
        base,
        dictionaryForm: base,
        reading,
        displayReading: reading,
        lookupTerms: [surface, base],
        pos: "名詞",
        start: index
      });
      index = String(text).indexOf(surface, index + surface.length);
    }
  }
  return { tokens: tokens.sort((a, b) => a.start - b.start), candidates: [] };
};

const service = createFtsSearchService({
  dbPath,
  getState: () => state,
  analyzeText,
  normalizeJapaneseTerm,
  tokenizerVersion: "test-kuromoji",
  normalizerVersion: "test-normalizer",
  dictionarySignature: () => "dict-test"
});

assert.equal(escapeFtsTerm('告白 "test" * - OR'), '"告白 ""test"" * - OR"');

const payload = await service.payloadForText("私は私と図書館へ行く。");
const terms = payload.termsText.split(/\s+/);
assert.equal(terms.filter((term) => term === "私").length, 1);
assert.equal(terms.includes("図書館"), true);
assert.equal(payload.readingsText.split(/\s+/).filter((term) => term === "わたし").length, 1);

await service.rebuild([
  {
    id: "chunk-1",
    documentId: "doc-1",
    title: "Test Book",
    chapterId: "chapter-1",
    chapterTitle: "Chapter One",
    page: 12,
    type: "sentence",
    text: "今年、告白された。",
    knownCoverage: 40,
    terms: ["告白"],
    dictionaryForms: ["告白"],
    dictionaryMatches: ["告白"]
  },
  {
    id: "chunk-2",
    documentId: "doc-1",
    title: "Test Book",
    chapterId: "chapter-1",
    chapterTitle: "Chapter One",
    page: 13,
    type: "sentence",
    text: "渡すのが遅れました。",
    knownCoverage: 50,
    terms: ["遅れました"],
    dictionaryForms: ["遅れる"],
    dictionaryMatches: ["遅れる"]
  },
  {
    id: "chunk-3",
    documentId: "doc-1",
    title: "Test Book",
    chapterId: "chapter-1",
    chapterTitle: "Chapter One",
    page: 14,
    type: "sentence",
    text: "周はいつも通りだった。",
    knownCoverage: 90,
    terms: ["周"],
    dictionaryForms: ["周"],
    dictionaryMatches: [],
    authorRubyReadings: [{ surface: "周", reading: "あまね" }]
  }
]);

const status = service.status();
assert.equal(status.ready, true);
assert.equal(status.chunks, 3);

const exact = await service.search("告白", { limit: 3 });
assert.equal(exact.results[0].id, "chunk-1");
assert.equal(exact.results[0].exactScore, 1);

const partial = await service.search("遅れまし", { limit: 3 });
assert.equal(partial.results[0].id, "chunk-2");

const rubySearch = await service.search("あまね", { limit: 3 });
assert.equal(rubySearch.results.some((result) => result.id === "chunk-3"), true);

const deleted = service.deleteDocument("doc-1");
assert.equal(deleted.deleted, 3);
const afterDelete = await service.search("告白", { limit: 3 });
assert.equal(afterDelete.results.length, 0);

service.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log("FTS search service test passed.");
