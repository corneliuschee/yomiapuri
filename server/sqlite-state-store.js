import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function createSqliteStateStore({ dbPath }) {
  let db;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    return db;
  }

  function hasState() {
    const database = open();
    const row = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("initialized");
    return row?.value === "true";
  }

  function loadState() {
    const database = open();
    if (!hasState()) return null;

    const settings = {};
    for (const row of database.prepare("SELECT key, value_json FROM app_settings").all()) {
      settings[row.key] = parseJson(row.value_json, {});
    }

    const documents = database.prepare("SELECT * FROM documents ORDER BY order_index ASC").all().map(rowToDocument);
    const trashDocuments = database.prepare("SELECT * FROM trash_documents ORDER BY order_index ASC").all().map(rowToDocument);
    const progress = Object.fromEntries(database.prepare("SELECT document_id, payload_json FROM reading_progress").all()
      .map((row) => [row.document_id, parseJson(row.payload_json, {})]));
    const knownRows = database.prepare("SELECT term, meta_json FROM known_terms ORDER BY order_index ASC").all();
    const knownTerms = knownRows.map((row) => row.term);
    const knownTermMeta = Object.fromEntries(knownRows.map((row) => [row.term, parseJson(row.meta_json, {})]));
    const trashKnownTerms = database.prepare("SELECT entry_json FROM trash_known_terms ORDER BY order_index ASC").all()
      .map((row) => parseJson(row.entry_json, null))
      .filter((entry) => entry !== null);
    const cards = database.prepare("SELECT payload_json FROM cards ORDER BY order_index ASC").all()
      .map((row) => parseJson(row.payload_json, null))
      .filter((entry) => entry !== null);
    const dictionaries = database.prepare("SELECT payload_json FROM dictionaries ORDER BY sort_order ASC, rowid ASC").all()
      .map((row) => parseJson(row.payload_json, null))
      .filter((entry) => entry !== null);
    const templates = database.prepare("SELECT payload_json FROM templates ORDER BY order_index ASC").all()
      .map((row) => parseJson(row.payload_json, null))
      .filter((entry) => entry !== null);

    return {
      documents,
      knownTerms,
      knownTermMeta,
      trash: {
        documents: trashDocuments,
        knownTerms: trashKnownTerms
      },
      dictionaries,
      dictionarySettings: settings.dictionarySettings ?? {},
      reader: settings.reader ?? {},
      media: settings.media ?? {},
      ai: settings.ai ?? {},
      sync: settings.sync ?? {},
      ml: settings.ml ?? {},
      progress,
      cards,
      anki: settings.anki ?? {},
      templates
    };
  }

  const saveState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      clearTables(database);
      insertDocuments(database, "documents", snapshot.documents ?? []);
      insertDocuments(database, "trash_documents", snapshot.trash?.documents ?? []);
      insertProgress(database, snapshot.progress ?? {});
      insertKnownTerms(database, snapshot.knownTerms ?? [], snapshot.knownTermMeta ?? {});
      insertTrashKnownTerms(database, snapshot.trash?.knownTerms ?? []);
      insertPayloadRows(database, "cards", snapshot.cards ?? [], "id");
      insertDictionaries(database, snapshot.dictionaries ?? []);
      insertPayloadRows(database, "templates", snapshot.templates ?? [], "id");
      insertSettings(database, snapshot);
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("initialized", "true");
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("saved_at", new Date().toISOString());
    });
    transaction(state);
  };

  const saveAnkiExportState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM cards").run();
      database.prepare("DELETE FROM known_terms").run();
      insertPayloadRows(database, "cards", snapshot.cards ?? [], "id");
      insertKnownTerms(database, snapshot.knownTerms ?? [], snapshot.knownTermMeta ?? {});
      saveSettings(database, snapshot, ["anki", "ml"]);
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("saved_at", new Date().toISOString());
    });
    transaction(state);
  };

  const saveDocumentsState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM documents").run();
      database.prepare("DELETE FROM trash_documents").run();
      insertDocuments(database, "documents", snapshot.documents ?? []);
      insertDocuments(database, "trash_documents", snapshot.trash?.documents ?? []);
      insertProgress(database, snapshot.progress ?? {}, { replace: true });
      saveSettings(database, snapshot, ["ml"]);
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveProgress = (documentId, payload) => {
    const database = open();
    const transaction = database.transaction(() => {
      upsertProgress(database, documentId, payload);
      writeSavedAt(database);
    });
    transaction();
  };

  const saveKnownTermsState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM known_terms").run();
      database.prepare("DELETE FROM trash_known_terms").run();
      insertKnownTerms(database, snapshot.knownTerms ?? [], snapshot.knownTermMeta ?? {});
      insertTrashKnownTerms(database, snapshot.trash?.knownTerms ?? []);
      saveSettings(database, snapshot, ["ml"]);
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveDictionariesState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM dictionaries").run();
      insertDictionaries(database, snapshot.dictionaries ?? []);
      saveSettings(database, snapshot, ["dictionarySettings", "ml"]);
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveTemplatesState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM templates").run();
      insertPayloadRows(database, "templates", snapshot.templates ?? [], "id");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveSettingsState = (state, keys = []) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      saveSettings(database, snapshot, keys);
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveCardsAndKnownTermsState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM cards").run();
      database.prepare("DELETE FROM known_terms").run();
      database.prepare("DELETE FROM trash_known_terms").run();
      insertPayloadRows(database, "cards", snapshot.cards ?? [], "id");
      insertKnownTerms(database, snapshot.knownTerms ?? [], snapshot.knownTermMeta ?? {});
      insertTrashKnownTerms(database, snapshot.trash?.knownTerms ?? []);
      saveSettings(database, snapshot, ["anki", "ml"]);
      writeSavedAt(database);
    });
    transaction(state);
  };

  function close() {
    db?.close();
    db = null;
  }

  return {
    open,
    hasState,
    loadState,
    saveState,
    saveAnkiExportState,
    saveDocumentsState,
    saveProgress,
    saveKnownTermsState,
    saveDictionariesState,
    saveTemplatesState,
    saveSettingsState,
    saveCardsAndKnownTermsState,
    close,
    dbPath
  };
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      type TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      text TEXT NOT NULL,
      chapters_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trash_documents (
      id TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      type TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_path TEXT NOT NULL,
      source_path TEXT NOT NULL,
      text TEXT NOT NULL,
      chapters_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      document_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS known_terms (
      term TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      meta_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trash_known_terms (
      term TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      entry_json TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dictionaries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      order_index INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_tombstones (
      document_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'deleted',
      origin_device_id TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS anki_export_journal (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function clearTables(database) {
  for (const table of [
    "documents",
    "trash_documents",
    "reading_progress",
    "known_terms",
    "trash_known_terms",
    "cards",
    "dictionaries",
    "app_settings",
    "templates"
  ]) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
}

function insertDocuments(database, table, documents = []) {
  const statement = database.prepare(`
    INSERT INTO ${table} (
      id, order_index, title, filename, type, author, cover_path, source_path,
      text, chapters_json, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @orderIndex, @title, @filename, @type, @author, @coverPath, @sourcePath,
      @text, @chaptersJson, @metadataJson, @createdAt, @updatedAt
    )
  `);
  documents.forEach((document, index) => {
    const {
      id,
      title,
      filename,
      type,
      author,
      coverPath,
      sourcePath,
      text,
      chapters,
      createdAt,
      updatedAt,
      ...metadata
    } = document ?? {};
    statement.run({
      id: String(id ?? ""),
      orderIndex: index,
      title: String(title ?? ""),
      filename: String(filename ?? ""),
      type: String(type ?? ""),
      author: String(author ?? ""),
      coverPath: String(coverPath ?? ""),
      sourcePath: String(sourcePath ?? ""),
      text: String(text ?? ""),
      chaptersJson: stringifyJson(Array.isArray(chapters) ? chapters : []),
      metadataJson: stringifyJson(metadata),
      createdAt: String(createdAt ?? new Date(0).toISOString()),
      updatedAt: String(updatedAt ?? createdAt ?? new Date(0).toISOString())
    });
  });
}

function rowToDocument(row) {
  return {
    ...parseJson(row.metadata_json, {}),
    id: row.id,
    title: row.title,
    filename: row.filename,
    type: row.type,
    author: row.author,
    coverPath: row.cover_path,
    sourcePath: row.source_path,
    text: row.text,
    chapters: parseJson(row.chapters_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function insertProgress(database, progress = {}, options = {}) {
  if (options.replace) database.prepare("DELETE FROM reading_progress").run();
  for (const [documentId, payload] of Object.entries(progress)) {
    upsertProgress(database, documentId, payload);
  }
}

function upsertProgress(database, documentId, payload = {}) {
  database.prepare(`
    INSERT INTO reading_progress (document_id, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(String(documentId), stringifyJson(payload ?? {}), String(payload?.updatedAt ?? new Date().toISOString()));
}

function insertKnownTerms(database, terms = [], metadata = {}) {
  const statement = database.prepare("INSERT INTO known_terms (term, order_index, meta_json, updated_at) VALUES (?, ?, ?, ?)");
  terms.forEach((term, index) => {
    const meta = metadata?.[term] ?? {};
    statement.run(String(term), index, stringifyJson(meta), String(meta.updatedAt ?? meta.addedAt ?? new Date().toISOString()));
  });
}

function insertTrashKnownTerms(database, entries = []) {
  const statement = database.prepare("INSERT INTO trash_known_terms (term, order_index, entry_json, deleted_at) VALUES (?, ?, ?, ?)");
  entries.forEach((entry, index) => {
    const term = typeof entry === "string" ? entry : entry?.term;
    if (!term) return;
    const deletedAt = typeof entry === "object" ? entry.deletedAt ?? new Date().toISOString() : new Date().toISOString();
    statement.run(String(term), index, stringifyJson(entry), String(deletedAt));
  });
}

function insertPayloadRows(database, table, rows = [], idField = "id") {
  const statement = database.prepare(`INSERT INTO ${table} (id, order_index, payload_json, updated_at) VALUES (?, ?, ?, ?)`);
  rows.forEach((row, index) => {
    const id = row?.[idField] || row?.id || `${table}-${index}`;
    statement.run(String(id), index, stringifyJson(row), String(row?.updatedAt ?? row?.createdAt ?? new Date().toISOString()));
  });
}

function insertDictionaries(database, dictionaries = []) {
  const statement = database.prepare("INSERT INTO dictionaries (id, type, name, filename, sort_order, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  dictionaries.forEach((dictionary, index) => {
    statement.run(
      String(dictionary?.id ?? `dictionary-${index}`),
      String(dictionary?.type ?? "term"),
      String(dictionary?.name ?? ""),
      String(dictionary?.filename ?? ""),
      Number(dictionary?.sortOrder ?? index) || 0,
      stringifyJson(dictionary),
      String(dictionary?.updatedAt ?? dictionary?.importedAt ?? new Date().toISOString())
    );
  });
}

function insertSettings(database, state = {}) {
  const settings = {
    dictionarySettings: state.dictionarySettings ?? {},
    reader: state.reader ?? {},
    media: state.media ?? {},
    ai: state.ai ?? {},
    sync: state.sync ?? {},
    ml: state.ml ?? {},
    anki: state.anki ?? {}
  };
  const statement = database.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)");
  const updatedAt = new Date().toISOString();
  for (const [key, value] of Object.entries(settings)) statement.run(key, stringifyJson(value), updatedAt);
}

function saveSettings(database, state = {}, keys = []) {
  const settings = {
    dictionarySettings: state.dictionarySettings ?? {},
    reader: state.reader ?? {},
    media: state.media ?? {},
    ai: state.ai ?? {},
    sync: state.sync ?? {},
    ml: state.ml ?? {},
    anki: state.anki ?? {}
  };
  const selected = keys.length > 0 ? keys : Object.keys(settings);
  const statement = database.prepare("INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)");
  const updatedAt = new Date().toISOString();
  for (const key of selected) {
    if (!Object.hasOwn(settings, key)) continue;
    statement.run(key, stringifyJson(settings[key]), updatedAt);
  }
}

function writeSavedAt(database) {
  database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("saved_at", new Date().toISOString());
  database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("initialized", "true");
  database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
}

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
