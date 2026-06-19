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
assert.match(rag.answer, /Relevant local evidence/);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ML service test passed.");
