import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSqliteStateStore } from "../server/sqlite-state-store.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yomiapuri-sqlite-"));
const dbPath = path.join(tmp, "state.sqlite");
const store = createSqliteStateStore({ dbPath });

assert.equal(store.hasState(), false);
assert.equal(store.open().pragma("journal_mode", { simple: true }).toLowerCase(), "wal");
assert.equal(Number(store.open().pragma("busy_timeout", { simple: true })), 5000);

const source = {
  documents: [{
    id: "doc-1",
    title: "Book",
    filename: "book.epub",
    type: "epub",
    author: "Author",
    coverPath: "/media/cover.jpg",
    sourcePath: "/media/book.epub",
    text: "本文",
    chapters: [{ id: "ch-1", title: "Chapter", blocks: [{ type: "text", text: "本文" }] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  }],
  knownTerms: ["図書館"],
  knownTermMeta: { 図書館: { addedAt: "2026-01-03T00:00:00.000Z", ankiNoteIds: [123] } },
  trash: {
    documents: [{ id: "trash-doc", title: "Trash", filename: "trash.txt", type: "txt", text: "", chapters: [] }],
    knownTerms: [{ term: "古い", deletedAt: "2026-01-04T00:00:00.000Z", meta: { reason: "test" } }]
  },
  dictionaries: [{
    id: "dict-1",
    name: "Jitendex",
    filename: "jitendex.zip",
    type: "term",
    sortOrder: 0,
    enabledForLookup: true,
    entries: [{ term: "図書館", reading: "としょかん", definitions: ["library"] }]
  }],
  dictionarySettings: { prefixWildcardSearch: true },
  reader: { hideInferredReadableFurigana: true },
  media: { audio: { enabled: true } },
  ai: { translation: { modelId: "q4" } },
  sync: { enabled: true, userEmail: "test@example.com" },
  ml: { indexStale: true, indexStaleReason: "test" },
  progress: { "doc-1": { page: 2, bookmarks: [{ page: 2 }], highlights: { pages: { 2: "<mark>x</mark>" } } } },
  cards: [{ id: "card-1", expression: "図書館", fields: { Word: "図書館" } }],
  anki: { deckName: "Mining", modelName: "JP Mining" },
  templates: [{ id: "tpl-1", name: "Template", fields: ["Word"] }]
};

store.saveState(source);
assert.equal(store.hasState(), true);

const loaded = store.loadState();
assert.equal(loaded.documents[0].title, "Book");
assert.equal(loaded.documents[0].chapters[0].title, "Chapter");
assert.deepEqual(loaded.knownTerms, ["図書館"]);
assert.equal(loaded.knownTermMeta["図書館"].ankiNoteIds[0], 123);
assert.equal(loaded.trash.documents[0].id, "trash-doc");
assert.equal(loaded.trash.knownTerms[0].term, "古い");
assert.equal(loaded.dictionaries[0].name, "Jitendex");
assert.equal(loaded.dictionaries[0].entries, undefined);
assert.equal(store.lookupDictionaryEntries(["dict-1"], loaded.knownTerms[0])[0].definitions[0], "library");
assert.equal(loaded.dictionarySettings.prefixWildcardSearch, true);
assert.equal(loaded.reader.hideInferredReadableFurigana, true);
assert.equal(loaded.ml.indexStale, true);
assert.equal(loaded.progress["doc-1"].page, 2);
assert.equal(loaded.cards[0].fields.Word, "図書館");
assert.equal(loaded.anki.deckName, "Mining");
assert.equal(loaded.templates[0].fields[0], "Word");

store.saveState(loaded);
const reloaded = store.loadState();
assert.equal(reloaded.documents.length, 1);
assert.equal(reloaded.knownTerms.length, 1);
assert.equal(reloaded.dictionaries.length, 1);
assert.equal(reloaded.cards.length, 1);

const updatedWordBank = {
  ...reloaded,
  knownTerms: ["å›³æ›¸é¤¨", "å±±"],
  knownTermMeta: {
    "å›³æ›¸é¤¨": reloaded.knownTermMeta["å›³æ›¸é¤¨"],
    "å±±": { addedAt: "2026-01-05T00:00:00.000Z" }
  }
};
store.saveState(updatedWordBank);
const wordBankUpdated = store.loadState();
assert.deepEqual(wordBankUpdated.knownTerms, ["å›³æ›¸é¤¨", "å±±"]);
assert.equal(wordBankUpdated.knownTermMeta["å±±"].addedAt, "2026-01-05T00:00:00.000Z");

store.saveProgress("doc-1", { page: 9, percentage: 75, updatedAt: "2026-01-06T00:00:00.000Z" });
const progressUpdated = store.loadState();
assert.equal(progressUpdated.progress["doc-1"].page, 9);
assert.equal(progressUpdated.documents[0].title, "Book");
assert.equal(progressUpdated.dictionaries[0].name, "Jitendex");

const knownOnlyUpdate = {
  ...progressUpdated,
  knownTerms: ["山"],
  knownTermMeta: { 山: { addedAt: "2026-01-07T00:00:00.000Z" } },
  trash: { ...progressUpdated.trash, knownTerms: [{ term: "海", deletedAt: "2026-01-08T00:00:00.000Z" }] }
};
store.saveKnownTermsState(knownOnlyUpdate);
const knownOnlyLoaded = store.loadState();
assert.deepEqual(knownOnlyLoaded.knownTerms, ["山"]);
assert.equal(knownOnlyLoaded.trash.knownTerms[0].term, "海");
assert.equal(knownOnlyLoaded.documents[0].id, "doc-1");
assert.equal(knownOnlyLoaded.dictionaries[0].name, "Jitendex");

const dictionaryOnlyUpdate = {
  ...knownOnlyLoaded,
  dictionaries: [{ ...knownOnlyLoaded.dictionaries[0], name: "Updated Dictionary", sortOrder: 2 }]
};
store.saveDictionariesState(dictionaryOnlyUpdate);
const dictionaryOnlyLoaded = store.loadState();
assert.equal(dictionaryOnlyLoaded.dictionaries[0].name, "Updated Dictionary");
assert.equal(store.lookupDictionaryEntries(["dict-1"], loaded.knownTerms[0])[0].definitions[0], "library");
assert.equal(dictionaryOnlyLoaded.documents[0].id, "doc-1");
assert.deepEqual(dictionaryOnlyLoaded.knownTerms, ["山"]);

const documentOnlyUpdate = {
  ...dictionaryOnlyLoaded,
  documents: [{ ...dictionaryOnlyLoaded.documents[0], title: "Updated Book" }]
};
store.saveDocumentsState(documentOnlyUpdate);
const documentOnlyLoaded = store.loadState();
assert.equal(documentOnlyLoaded.documents[0].title, "Updated Book");
assert.equal(documentOnlyLoaded.dictionaries[0].name, "Updated Dictionary");

const cardAndKnownUpdate = {
  ...documentOnlyLoaded,
  knownTerms: ["山", "川"],
  knownTermMeta: { 山: { addedAt: "2026-01-07T00:00:00.000Z" }, 川: { addedAt: "2026-01-09T00:00:00.000Z" } },
  cards: [{ id: "card-2", expression: "川", fields: { Word: "川" }, updatedAt: "2026-01-09T00:00:00.000Z" }]
};
store.saveCardsAndKnownTermsState(cardAndKnownUpdate);
const cardAndKnownLoaded = store.loadState();
assert.deepEqual(cardAndKnownLoaded.knownTerms, ["山", "川"]);
assert.equal(cardAndKnownLoaded.cards[0].id, "card-2");
assert.equal(cardAndKnownLoaded.documents[0].title, "Updated Book");

store.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log("SQLite state store test passed.");
