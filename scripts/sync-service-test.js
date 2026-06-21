import assert from "node:assert/strict";
import { createSyncService, defaultSyncSettings, buildPushPayload } from "../server/sync-service.js";

const state = {
  documents: [{
    id: "doc-1",
    title: "Book One",
    filename: "book.epub",
    type: "epub",
    createdAt: "2026-01-01T00:00:00.000Z",
    text: "図書館へ行く。",
    chapters: [{ id: "ch-1", title: "Chapter 1", blocks: [{ type: "text", text: "図書館へ行く。" }] }]
  }],
  progress: {
    "doc-1": {
      percentage: 42,
      page: 3,
      chapterId: "ch-1",
      mode: "paged",
      scrollTop: 0,
      zoom: 100,
      highlights: { pages: { 3: ["図書館"] }, scrollHtml: "" },
      bookmarks: [{ page: 3, chapterId: "ch-1" }],
      updatedAt: "2026-01-02T00:00:00.000Z"
    }
  },
  knownTerms: ["図書館"],
  knownTermMeta: { 図書館: { addedAt: "2026-01-01T00:00:00.000Z", ankiNoteIds: [123] } },
  trash: {
    documents: [],
    knownTerms: [{ term: "削除", meta: {}, deletedAt: "2026-01-03T00:00:00.000Z" }]
  },
  cards: [{ id: "card-1", expression: "図書館", dictionaryForm: "図書館", ankiNoteId: 123, createdAt: "2026-01-04T00:00:00.000Z" }],
  anki: { deckName: "Mining", modelName: "JP Mining" },
  media: { audio: { enabled: false }, image: { enabled: false } },
  dictionarySettings: { prefixWildcardSearch: false },
  dictionaries: [{ id: "dict-1", name: "Jitendex", entries: [{ term: "図書館", definitions: ["library"] }], enabledForLookup: true }],
  templates: [],
  sync: {
    ...defaultSyncSettings(),
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
    deviceId: "device-1",
    deviceName: "Desktop"
  }
};

let saved = 0;
const importedEvents = [];
const eventLog = {
  readAll: async () => [{ id: "event-1", type: "lookup.performed", payload: { term: "図書館" }, createdAt: "2026-01-05T00:00:00.000Z" }],
  appendImported: async (event) => importedEvents.push(event)
};

const payload = await buildPushPayload(state, { ...state.sync, userId: "user-1", userEmail: "test@example.com" }, "", eventLog);
assert.equal(payload.documents[0].content.text, "図書館へ行く。");
assert.equal(payload.knownTerms.length, 2);
assert.equal(payload.settings.find((item) => item.key === "dictionariesMetadata").value[0].entries, undefined);
assert.equal(JSON.stringify(payload).includes("vector-index"), false);

state.trash.knownTerms.push({ term: state.knownTerms[0], meta: {}, deletedAt: "2025-12-01T00:00:00.000Z" });
const duplicatePayload = await buildPushPayload(state, { ...state.sync, userId: "user-1", userEmail: "test@example.com" }, "", eventLog);
assert.equal(duplicatePayload.knownTerms.filter((row) => row.term === state.knownTerms[0]).length, 1);

const tables = new Map();
function table(name) {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
}

const createClient = () => ({
  auth: {
    signInWithPassword: async ({ email }) => ({
      data: {
        user: { id: "user-1", email },
        session: { access_token: "access", refresh_token: "refresh" }
      },
      error: null
    }),
    setSession: async () => ({
      data: {
        user: { id: "user-1", email: "test@example.com" },
        session: { access_token: "access", refresh_token: "refresh" }
      },
      error: null
    }),
    signOut: async () => ({ error: null })
  },
  from(name) {
    return {
      upsert: async (rows) => {
        for (const row of rows) {
          table(name).push(row);
        }
        return { data: rows, error: null };
      },
      select() {
        return {
          eq(_field, value) {
            const rows = table(name).filter((row) => row.user_id === value);
            return {
              range: async (from, to) => ({
                data: rows.slice(from, to + 1),
                error: null
              })
            };
          }
        };
      }
    };
  },
  storage: {
    from: () => ({
      upload: async () => ({ data: null, error: null })
    })
  }
});

const service = createSyncService({
  getState: () => state,
  saveState: async () => { saved += 1; },
  mediaDir: "",
  eventLog,
  createClient,
  platform: "test"
});

await service.signIn({ email: "test@example.com", password: "secret" });
assert.equal(state.sync.userId, "user-1");
await service.push();
assert.equal(table("documents").some((row) => row.id === "doc-1"), true);
assert.equal(table("known_terms").some((row) => row.term === "図書館" && row.deleted_at === null), true);

table("documents").push({
  user_id: "user-1",
  id: "doc-2",
  title: "Remote Book",
  filename: "remote.txt",
  type: "txt",
  order_index: 0,
  content: { text: "遠い本", chapters: [] },
  created_at: "2026-02-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z"
});
table("reading_progress").push({
  user_id: "user-1",
  document_id: "doc-2",
  page: 2,
  chapter_id: "remote",
  mode: "scroll",
  percentage: 55,
  scroll_top: 12,
  zoom: 110,
  updated_at: "2026-02-02T00:00:00.000Z"
});
table("reader_annotations").push({
  user_id: "user-1",
  document_id: "doc-2",
  kind: "reader_state",
  payload: { highlights: { pages: { 2: ["遠い"] } }, bookmarks: [{ page: 2 }] },
  updated_at: "2026-02-03T00:00:00.000Z"
});
table("known_terms").push({
  user_id: "user-1",
  term: "遠い",
  meta: { addedAt: "2026-02-01T00:00:00.000Z" },
  deleted_at: null,
  updated_at: "2026-02-01T00:00:00.000Z"
});
table("learning_events").push({
  user_id: "user-1",
  id: "event-remote",
  type: "reading.progress",
  payload: { documentId: "doc-2" },
  created_at: "2026-02-03T00:00:00.000Z"
});

await service.pull();
assert.equal(state.documents.some((document) => document.id === "doc-2"), true);
assert.equal(state.progress["doc-2"].page, 2);
assert.equal(state.knownTerms.includes("遠い"), true);
assert.equal(state.ml.indexStale, true);
assert.equal(importedEvents.some((event) => event.id === "event-remote"), true);
assert.equal(saved > 0, true);

console.log("Sync service test passed.");
