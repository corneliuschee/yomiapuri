import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 2;
const REQUIRED_TABLES = [
  "schema_meta",
  "migration_runs",
  "store_revisions",
  "documents",
  "document_bodies",
  "document_pages",
  "trash_documents",
  "reading_progress",
  "known_terms",
  "trash_known_terms",
  "cards",
  "dictionaries",
  "dictionary_entries",
  "dictionary_entry_content",
  "dictionary_frequencies",
  "app_settings",
  "templates",
  "document_tombstones",
  "anki_export_journal"
];
const REQUIRED_INDEXES = [
  "idx_dictionary_entries_lookup_term",
  "idx_dictionary_entries_lookup_reading",
  "idx_dictionary_frequencies_lookup_term",
  "idx_dictionary_frequencies_lookup_reading",
  "idx_document_pages_document_page"
];
const DICTIONARY_CONTENT_CACHE_LIMIT = 500;
const dictionaryContentCache = new Map();

export function createSqliteStateStore({ dbPath }) {
  let db;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    prepareMigrationFiles(dbPath);
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    validateDatabase(db);
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
    const dictionaries = database.prepare(`
      SELECT id, type, name, filename, sort_order, language, format, enabled_for_lookup,
        selected_for_wordbank, imported_at, validation_status, entries_count, frequency_count, updated_at
      FROM dictionaries
      ORDER BY sort_order ASC, rowid ASC
    `).all().map(rowToDictionaryMetadata);
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
      const dictionaries = snapshot.dictionaries ?? [];
      const hasDictionaryPayload = dictionaries.some((dictionary) =>
        (dictionary?.entries?.length ?? 0) > 0 || (dictionary?.frequencyEntries?.length ?? 0) > 0);
      clearTables(database, { preserveDictionaries: dictionaries.length > 0 && !hasDictionaryPayload });
      insertDocuments(database, "documents", snapshot.documents ?? []);
      insertDocuments(database, "trash_documents", snapshot.trash?.documents ?? []);
      insertProgress(database, snapshot.progress ?? {});
      insertKnownTerms(database, snapshot.knownTerms ?? [], snapshot.knownTermMeta ?? {});
      insertTrashKnownTerms(database, snapshot.trash?.knownTerms ?? []);
      insertPayloadRows(database, "cards", snapshot.cards ?? [], "id");
      if (hasDictionaryPayload) insertDictionaries(database, dictionaries);
      else updateDictionaries(database, dictionaries);
      insertPayloadRows(database, "templates", snapshot.templates ?? [], "id");
      insertSettings(database, snapshot);
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("initialized", "true");
      database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("saved_at", new Date().toISOString());
      bumpRevision(database, "all");
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
      bumpRevision(database, "cards");
      bumpRevision(database, "known_terms");
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
      bumpRevision(database, "documents");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveProgress = (documentId, payload) => {
    const database = open();
    const transaction = database.transaction(() => {
      upsertProgress(database, documentId, payload);
      bumpRevision(database, "reading_progress");
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
      bumpRevision(database, "known_terms");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveKnownTermsAdded = (terms = [], metadata = {}, state = {}) => {
    const database = open();
    const transaction = database.transaction(() => {
      insertKnownTermsAdded(database, terms, metadata);
      if (state) saveSettings(database, state, ["ml"]);
      bumpRevision(database, "known_terms");
      writeSavedAt(database);
    });
    transaction();
  };

  const saveKnownTermsDeleted = (terms = [], trashEntries = [], state = {}) => {
    const database = open();
    const transaction = database.transaction(() => {
      deleteKnownTermsRows(database, terms);
      insertTrashKnownTermsDelta(database, terms, trashEntries);
      if (state) saveSettings(database, state, ["ml"]);
      bumpRevision(database, "known_terms");
      writeSavedAt(database);
    });
    transaction();
  };

  const saveDictionariesState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      updateDictionaries(database, snapshot.dictionaries ?? []);
      saveSettings(database, snapshot, ["dictionarySettings", "ml"]);
      bumpRevision(database, "dictionaries");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveTemplatesState = (state) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      database.prepare("DELETE FROM templates").run();
      insertPayloadRows(database, "templates", snapshot.templates ?? [], "id");
      bumpRevision(database, "templates");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const saveSettingsState = (state, keys = []) => {
    const database = open();
    const transaction = database.transaction((snapshot) => {
      saveSettings(database, snapshot, keys);
      for (const key of keys) bumpRevision(database, `settings:${key}`);
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
      bumpRevision(database, "cards");
      bumpRevision(database, "known_terms");
      writeSavedAt(database);
    });
    transaction(state);
  };

  const lookupDictionaryEntries = (dictionaryIds = [], term = "", options = {}) => {
    const database = open();
    return lookupDictionaryEntriesSql(database, dictionaryIds, term, options);
  };

  const lookupDictionaryEntriesBatch = (dictionaryId = "", terms = [], options = {}) => {
    const database = open();
    return lookupDictionaryEntriesBatchSql(database, dictionaryId, terms, options);
  };

  const lookupDictionaryFrequencies = (dictionaryIds = [], term = "", options = {}) => {
    const database = open();
    return lookupDictionaryFrequenciesSql(database, dictionaryIds, term, options);
  };

  const revisions = (options = {}) => {
    if (options.readOnly) return readOnlyRevisions(dbPath);
    const database = open();
    return Object.fromEntries(database.prepare("SELECT domain, revision FROM store_revisions").all()
      .map((row) => [row.domain, Number(row.revision) || 0]));
  };

  const dictionaryIndexStats = () => {
    const database = open();
    return {
      dictionaries: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionaries").get()?.count ?? 0),
      entries: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries").get()?.count ?? 0),
      contents: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entry_content").get()?.count ?? 0),
      frequencies: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_frequencies").get()?.count ?? 0)
    };
  };

  const loadDocumentBody = (documentId, options = {}) => {
    const database = open();
    return loadDocumentBodySql(database, documentId, options);
  };

  const loadDocumentPageWindow = (documentId, pageIndex = 0, options = {}) => {
    const database = open();
    return loadDocumentPageWindowSql(database, documentId, pageIndex, options);
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
    saveKnownTermsAdded,
    saveKnownTermsDeleted,
    saveDictionariesState,
    saveTemplatesState,
    saveSettingsState,
    saveCardsAndKnownTermsState,
    lookupDictionaryEntries,
    lookupDictionaryEntriesBatch,
    lookupDictionaryFrequencies,
    dictionaryIndexStats,
    revisions,
    loadDocumentBody,
    loadDocumentPageWindow,
    close,
    dbPath
  };
}

function prepareMigrationFiles(dbPath) {
  const nextPath = `${dbPath}.next`;
  if (fs.existsSync(nextPath)) {
    throw new Error(`Found unfinished SQLite migration file: ${nextPath}. Refusing to start until it is reviewed or removed.`);
  }
  if (!fs.existsSync(dbPath)) return;
  const currentVersion = readSchemaVersion(dbPath);
  if (currentVersion === SCHEMA_VERSION) return;
  const prevPath = `${dbPath}.prev`;
  fs.copyFileSync(dbPath, prevPath);
}

function readSchemaVersion(filePath) {
  let readonly;
  try {
    readonly = new Database(filePath, { readonly: true, fileMustExist: true });
    const hasMeta = readonly.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
    if (!hasMeta) return 0;
    return Number(readonly.prepare("SELECT value FROM schema_meta WHERE key = ?").get("schema_version")?.value ?? 0);
  } catch {
    return 0;
  } finally {
    readonly?.close();
  }
}

function readOnlyRevisions(filePath) {
  let readonly;
  try {
    readonly = new Database(filePath, { readonly: true, fileMustExist: true });
    readonly.pragma("busy_timeout = 5000");
    const hasRevisions = readonly.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_revisions'").get();
    if (!hasRevisions) return {};
    return Object.fromEntries(readonly.prepare("SELECT domain, revision FROM store_revisions").all()
      .map((row) => [row.domain, Number(row.revision) || 0]));
  } catch {
    return {};
  } finally {
    readonly?.close();
  }
}

function ensureSchema(database) {
  const startedAt = new Date().toISOString();
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migration_runs (
      id TEXT PRIMARY KEY,
      from_version INTEGER NOT NULL,
      to_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS store_revisions (
      domain TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS document_bodies (
      document_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      chapters_json TEXT NOT NULL,
      text_length INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_pages (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      chapter_id TEXT NOT NULL DEFAULT '',
      chapter_title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_document_pages_document_page ON document_pages(document_id, page_index);

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

    CREATE TABLE IF NOT EXISTS trash_document_bodies (
      document_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      chapters_json TEXT NOT NULL,
      text_length INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id TEXT PRIMARY KEY,
      dictionary_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      term TEXT NOT NULL,
      reading TEXT NOT NULL DEFAULT '',
      content_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(dictionary_id) REFERENCES dictionaries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_lookup_term ON dictionary_entries(dictionary_id, term, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_lookup_reading ON dictionary_entries(dictionary_id, reading, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_term_global ON dictionary_entries(term, dictionary_id);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_reading_global ON dictionary_entries(reading, dictionary_id);

    CREATE TABLE IF NOT EXISTS dictionary_entry_content (
      id TEXT PRIMARY KEY,
      dictionary_id TEXT NOT NULL,
      definitions_json TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(dictionary_id) REFERENCES dictionaries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dictionary_frequencies (
      id TEXT PRIMARY KEY,
      dictionary_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      term TEXT NOT NULL,
      reading TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',
      display_value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(dictionary_id) REFERENCES dictionaries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_lookup_term ON dictionary_frequencies(dictionary_id, term, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_lookup_reading ON dictionary_frequencies(dictionary_id, reading, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_term_global ON dictionary_frequencies(term, dictionary_id);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_reading_global ON dictionary_frequencies(reading, dictionary_id);
  `);
  ensureColumn(database, "dictionaries", "language", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(database, "dictionaries", "format", "TEXT NOT NULL DEFAULT 'legacy'");
  ensureColumn(database, "dictionaries", "enabled_for_lookup", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "dictionaries", "selected_for_wordbank", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "dictionaries", "imported_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "dictionaries", "validation_status", "TEXT NOT NULL DEFAULT 'valid'");
  ensureColumn(database, "dictionaries", "entries_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "dictionaries", "frequency_count", "INTEGER NOT NULL DEFAULT 0");
  const previousVersion = Number(database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("schema_version")?.value ?? 0);
  const inProgress = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("migration_in_progress")?.value;
  const migrationId = `${previousVersion}->${SCHEMA_VERSION}:${startedAt}`;
  if (previousVersion !== SCHEMA_VERSION) {
    database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("migration_in_progress", "true");
    database.prepare(`
      INSERT OR REPLACE INTO migration_runs (id, from_version, to_version, status, started_at)
      VALUES (?, ?, ?, 'running', ?)
    `).run(migrationId, previousVersion, SCHEMA_VERSION, startedAt);
  }
  database.exec(`
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

    CREATE TABLE IF NOT EXISTS known_term_tombstones (
      term TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'deleted',
      origin_device_id TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS card_tombstones (
      card_id TEXT PRIMARY KEY,
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
  backfillDocumentBodies(database);
  if (previousVersion !== SCHEMA_VERSION) {
    const finishedAt = new Date().toISOString();
    database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
    database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("migration_in_progress", "false");
    database.prepare("UPDATE migration_runs SET status = 'complete', finished_at = ? WHERE id = ?").run(finishedAt, migrationId);
  } else if (inProgress === "true") {
    database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("migration_in_progress", "false");
    database.prepare(`
      INSERT OR REPLACE INTO migration_runs (id, from_version, to_version, status, started_at, finished_at)
      VALUES (?, ?, ?, 'recovered', ?, ?)
    `).run(`${SCHEMA_VERSION}->${SCHEMA_VERSION}:recovered:${startedAt}`, SCHEMA_VERSION, SCHEMA_VERSION, startedAt, new Date().toISOString());
  }
}

function clearTables(database, options = {}) {
  const tables = [
    "dictionary_entries",
    "dictionary_entry_content",
    "dictionary_frequencies",
    "document_pages",
    "document_bodies",
    "trash_document_bodies",
    "documents",
    "trash_documents",
    "reading_progress",
    "known_terms",
    "trash_known_terms",
    "cards",
    "dictionaries",
    "app_settings",
    "templates"
  ];
  const filteredTables = options.preserveDictionaries
    ? tables.filter((table) => !table.startsWith("dictionary_") && table !== "dictionaries")
    : tables;
  for (const table of filteredTables) {
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
    insertDocumentBody(database, table, {
      id: String(id ?? ""),
      text: String(text ?? ""),
      chapters: Array.isArray(chapters) ? chapters : [],
      updatedAt: String(updatedAt ?? createdAt ?? new Date(0).toISOString())
    });
  });
}

function insertDocumentBody(database, table, document = {}) {
  const bodyTable = table === "trash_documents" ? "trash_document_bodies" : "document_bodies";
  const text = String(document.text ?? "");
  const chaptersJson = stringifyJson(Array.isArray(document.chapters) ? document.chapters : []);
  const sourceHash = hashString(`${text}\u0000${chaptersJson}`);
  database.prepare(`
    INSERT OR REPLACE INTO ${bodyTable} (document_id, text, chapters_json, text_length, source_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(document.id ?? ""),
    text,
    chaptersJson,
    text.length,
    sourceHash,
    String(document.updatedAt ?? new Date().toISOString())
  );
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

function insertKnownTermsAdded(database, terms = [], metadata = {}) {
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : []).map(String).filter(Boolean))];
  if (normalizedTerms.length === 0) return;
  const maxOrder = Number(database.prepare("SELECT COALESCE(MAX(order_index), -1) AS maxOrder FROM known_terms").get()?.maxOrder ?? -1);
  const statement = database.prepare(`
    INSERT INTO known_terms (term, order_index, meta_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(term) DO UPDATE SET
      meta_json = excluded.meta_json,
      updated_at = excluded.updated_at
  `);
  const deleteTrash = database.prepare("DELETE FROM trash_known_terms WHERE term = ?");
  normalizedTerms.forEach((term, index) => {
    const meta = metadata?.[term] ?? {};
    statement.run(term, maxOrder + index + 1, stringifyJson(meta), String(meta.updatedAt ?? meta.addedAt ?? new Date().toISOString()));
    deleteTrash.run(term);
  });
}

function deleteKnownTermsRows(database, terms = []) {
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : []).map(String).filter(Boolean))];
  if (normalizedTerms.length === 0) return;
  const statement = database.prepare("DELETE FROM known_terms WHERE term = ?");
  for (const term of normalizedTerms) statement.run(term);
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

function updateDictionaries(database, dictionaries = []) {
  dictionaryContentCache.clear();
  const rows = Array.isArray(dictionaries) ? dictionaries : [];
  const bulkIndexing = dictionaryPayloadRowCount(rows) > 50000;
  const ids = [...new Set(rows.map((dictionary, index) => String(dictionary?.id ?? `dictionary-${index}`)).filter(Boolean))];
  if (ids.length === 0) {
    database.prepare("DELETE FROM dictionaries").run();
    return;
  }
  if (bulkIndexing) dropDictionaryLookupIndexes(database);
  database.prepare(`DELETE FROM dictionaries WHERE id NOT IN (${ids.map(() => "?").join(", ")})`).run(...ids);

  const existingPayload = database.prepare("SELECT payload_json FROM dictionaries WHERE id = ?");
  const upsertDictionary = database.prepare(`
    INSERT INTO dictionaries (
      id, type, name, filename, sort_order, language, format, enabled_for_lookup,
      selected_for_wordbank, imported_at, validation_status, entries_count, frequency_count,
      payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      filename = excluded.filename,
      sort_order = excluded.sort_order,
      language = excluded.language,
      format = excluded.format,
      enabled_for_lookup = excluded.enabled_for_lookup,
      selected_for_wordbank = excluded.selected_for_wordbank,
      imported_at = excluded.imported_at,
      validation_status = excluded.validation_status,
      entries_count = excluded.entries_count,
      frequency_count = excluded.frequency_count,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  const insertEntry = database.prepare(`
    INSERT OR REPLACE INTO dictionary_entries (id, dictionary_id, sequence, term, reading, content_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContent = database.prepare(`
    INSERT OR REPLACE INTO dictionary_entry_content (id, dictionary_id, definitions_json, details_json, tags_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFrequency = database.prepare(`
    INSERT OR REPLACE INTO dictionary_frequencies (id, dictionary_id, sequence, term, reading, value, display_value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    rows.forEach((dictionary, index) => {
    const dictionaryId = String(dictionary?.id ?? `dictionary-${index}`);
    const updatedAt = String(dictionary?.updatedAt ?? dictionary?.importedAt ?? new Date().toISOString());
    const hasEntries = (dictionary?.entries?.length ?? 0) > 0 || (dictionary?.frequencyEntries?.length ?? 0) > 0;
    const payloadJson = hasEntries
      ? stringifyJson(dictionaryMetadataPayload(dictionary))
      : existingPayload.get(dictionaryId)?.payload_json ?? stringifyJson(dictionaryMetadataPayload(dictionary));
    upsertDictionary.run(
      dictionaryId,
      String(dictionary?.type ?? "term"),
      String(dictionary?.name ?? ""),
      String(dictionary?.filename ?? ""),
      Number(dictionary?.sortOrder ?? index) || 0,
      String(dictionary?.language ?? "unknown"),
      String(dictionary?.format ?? "legacy"),
      dictionary?.enabledForLookup === false ? 0 : 1,
      dictionary?.selectedForWordBank === true ? 1 : 0,
      String(dictionary?.importedAt ?? ""),
      String(dictionary?.validationStatus ?? "valid"),
      Number(dictionary?.entriesCount ?? dictionary?.entries?.length ?? 0) || 0,
      Number(dictionary?.frequencyCount ?? dictionary?.frequencyEntries?.length ?? 0) || 0,
      payloadJson,
      updatedAt
    );
    if (!hasEntries) return;
    database.prepare("DELETE FROM dictionary_entries WHERE dictionary_id = ?").run(dictionaryId);
    database.prepare("DELETE FROM dictionary_entry_content WHERE dictionary_id = ?").run(dictionaryId);
    database.prepare("DELETE FROM dictionary_frequencies WHERE dictionary_id = ?").run(dictionaryId);
    for (const [entryIndex, entry] of (dictionary?.entries ?? []).entries()) {
      const term = String(entry?.term ?? "");
      if (!term) continue;
      const contentId = `${dictionaryId}:entry:${entryIndex}`;
      insertEntry.run(`${dictionaryId}:lookup:${entryIndex}`, dictionaryId, entryIndex, term, String(entry?.reading ?? ""), contentId, updatedAt);
      insertContent.run(
        contentId,
        dictionaryId,
        stringifyJson(Array.isArray(entry?.definitions) ? entry.definitions : []),
        stringifyJson(Array.isArray(entry?.details) ? entry.details : []),
        stringifyJson(Array.isArray(entry?.tags) ? entry.tags : []),
        updatedAt
      );
    }
    for (const [entryIndex, entry] of (dictionary?.frequencyEntries ?? []).entries()) {
      const term = String(entry?.term ?? "");
      const displayValue = String(entry?.displayValue ?? entry?.value ?? "");
      if (!term || !displayValue) continue;
      insertFrequency.run(
        `${dictionaryId}:frequency:${entryIndex}`,
        dictionaryId,
        entryIndex,
        term,
        String(entry?.reading ?? ""),
        String(entry?.value ?? displayValue),
        displayValue,
        updatedAt
      );
    }
    });
  } finally {
    if (bulkIndexing) createDictionaryLookupIndexes(database);
  }
}

function insertDictionaries(database, dictionaries = []) {
  dictionaryContentCache.clear();
  const bulkIndexing = dictionaryPayloadRowCount(dictionaries) > 50000;
  if (bulkIndexing) dropDictionaryLookupIndexes(database);
  const statement = database.prepare(`
    INSERT OR REPLACE INTO dictionaries (
      id, type, name, filename, sort_order, language, format, enabled_for_lookup,
      selected_for_wordbank, imported_at, validation_status, entries_count, frequency_count,
      payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEntry = database.prepare(`
    INSERT OR REPLACE INTO dictionary_entries (id, dictionary_id, sequence, term, reading, content_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContent = database.prepare(`
    INSERT OR REPLACE INTO dictionary_entry_content (id, dictionary_id, definitions_json, details_json, tags_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertFrequency = database.prepare(`
    INSERT OR REPLACE INTO dictionary_frequencies (id, dictionary_id, sequence, term, reading, value, display_value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    dictionaries.forEach((dictionary, index) => {
    const dictionaryId = String(dictionary?.id ?? `dictionary-${index}`);
    const updatedAt = String(dictionary?.updatedAt ?? dictionary?.importedAt ?? new Date().toISOString());
    statement.run(
      dictionaryId,
      String(dictionary?.type ?? "term"),
      String(dictionary?.name ?? ""),
      String(dictionary?.filename ?? ""),
      Number(dictionary?.sortOrder ?? index) || 0,
      String(dictionary?.language ?? "unknown"),
      String(dictionary?.format ?? "legacy"),
      dictionary?.enabledForLookup === false ? 0 : 1,
      dictionary?.selectedForWordBank === true ? 1 : 0,
      String(dictionary?.importedAt ?? ""),
      String(dictionary?.validationStatus ?? "valid"),
      Number(dictionary?.entriesCount ?? dictionary?.entries?.length ?? 0) || 0,
      Number(dictionary?.frequencyCount ?? dictionary?.frequencyEntries?.length ?? 0) || 0,
      stringifyJson(dictionaryMetadataPayload(dictionary)),
      updatedAt
    );
    for (const [entryIndex, entry] of (dictionary?.entries ?? []).entries()) {
      const term = String(entry?.term ?? "");
      if (!term) continue;
      const contentId = `${dictionaryId}:entry:${entryIndex}`;
      insertEntry.run(
        `${dictionaryId}:lookup:${entryIndex}`,
        dictionaryId,
        entryIndex,
        term,
        String(entry?.reading ?? ""),
        contentId,
        updatedAt
      );
      insertContent.run(
        contentId,
        dictionaryId,
        stringifyJson(Array.isArray(entry?.definitions) ? entry.definitions : []),
        stringifyJson(Array.isArray(entry?.details) ? entry.details : []),
        stringifyJson(Array.isArray(entry?.tags) ? entry.tags : []),
        updatedAt
      );
    }
    for (const [entryIndex, entry] of (dictionary?.frequencyEntries ?? []).entries()) {
      const term = String(entry?.term ?? "");
      const displayValue = String(entry?.displayValue ?? entry?.value ?? "");
      if (!term || !displayValue) continue;
      insertFrequency.run(
        `${dictionaryId}:frequency:${entryIndex}`,
        dictionaryId,
        entryIndex,
        term,
        String(entry?.reading ?? ""),
        String(entry?.value ?? displayValue),
        displayValue,
        updatedAt
      );
    }
    });
  } finally {
    if (bulkIndexing) createDictionaryLookupIndexes(database);
  }
}

function dictionaryMetadataPayload(dictionary = {}) {
  const {
    termEntries,
    frequencyEntries,
    entries,
    terms,
    index,
    frequencyIndex,
    ...metadata
  } = dictionary ?? {};
  return metadata;
}

function dictionaryPayloadRowCount(dictionaries = []) {
  return (Array.isArray(dictionaries) ? dictionaries : []).reduce((total, dictionary) =>
    total + Number(dictionary?.entries?.length ?? 0) + Number(dictionary?.frequencyEntries?.length ?? 0), 0);
}

function dropDictionaryLookupIndexes(database) {
  database.exec(`
    DROP INDEX IF EXISTS idx_dictionary_entries_lookup_term;
    DROP INDEX IF EXISTS idx_dictionary_entries_lookup_reading;
    DROP INDEX IF EXISTS idx_dictionary_entries_term_global;
    DROP INDEX IF EXISTS idx_dictionary_entries_reading_global;
    DROP INDEX IF EXISTS idx_dictionary_frequencies_lookup_term;
    DROP INDEX IF EXISTS idx_dictionary_frequencies_lookup_reading;
    DROP INDEX IF EXISTS idx_dictionary_frequencies_term_global;
    DROP INDEX IF EXISTS idx_dictionary_frequencies_reading_global;
  `);
}

function createDictionaryLookupIndexes(database) {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_lookup_term ON dictionary_entries(dictionary_id, term, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_lookup_reading ON dictionary_entries(dictionary_id, reading, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_term_global ON dictionary_entries(term, dictionary_id);
    CREATE INDEX IF NOT EXISTS idx_dictionary_entries_reading_global ON dictionary_entries(reading, dictionary_id);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_lookup_term ON dictionary_frequencies(dictionary_id, term, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_lookup_reading ON dictionary_frequencies(dictionary_id, reading, sequence);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_term_global ON dictionary_frequencies(term, dictionary_id);
    CREATE INDEX IF NOT EXISTS idx_dictionary_frequencies_reading_global ON dictionary_frequencies(reading, dictionary_id);
  `);
}

function insertTrashKnownTermsDelta(database, terms = [], entries = []) {
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : []).map(String).filter(Boolean))];
  if (normalizedTerms.length === 0) return;
  database.prepare("UPDATE trash_known_terms SET order_index = order_index + ?").run(normalizedTerms.length);
  const entryByTerm = new Map((Array.isArray(entries) ? entries : [])
    .map((entry) => [typeof entry === "string" ? entry : entry?.term, entry])
    .filter(([term]) => term));
  const statement = database.prepare(`
    INSERT INTO trash_known_terms (term, order_index, entry_json, deleted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(term) DO UPDATE SET
      order_index = excluded.order_index,
      entry_json = excluded.entry_json,
      deleted_at = excluded.deleted_at
  `);
  normalizedTerms.forEach((term, index) => {
    const entry = entryByTerm.get(term) ?? { term, deletedAt: new Date().toISOString() };
    const deletedAt = typeof entry === "object" ? entry.deletedAt ?? new Date().toISOString() : new Date().toISOString();
    statement.run(term, index, stringifyJson(entry), String(deletedAt));
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

function validateDatabase(database) {
  const migrationInProgress = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("migration_in_progress")?.value;
  if (migrationInProgress === "true") {
    throw new Error("SQLite migration is marked as incomplete. Restore the previous backup before opening the app.");
  }
  const tableRows = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name));
  const missingTables = REQUIRED_TABLES.filter((table) => !tableRows.has(table));
  if (missingTables.length > 0) throw new Error(`SQLite schema is missing required table(s): ${missingTables.join(", ")}`);
  const indexRows = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
  const missingIndexes = REQUIRED_INDEXES.filter((index) => !indexRows.has(index));
  if (missingIndexes.length > 0) throw new Error(`SQLite schema is missing required index(es): ${missingIndexes.join(", ")}`);

  const schemaVersion = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("schema_version")?.value ?? "";
  const integritySignature = `${SCHEMA_VERSION}:${schemaVersion}`;
  const checkedSignature = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("integrity_checked_signature")?.value ?? "";
  if (checkedSignature === integritySignature) return;

  const quick = database.prepare("PRAGMA quick_check").get();
  const quickValue = Object.values(quick ?? {})[0];
  if (quickValue !== "ok") throw new Error(`SQLite quick_check failed: ${quickValue || "unknown error"}`);
  const foreignRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignRows.length > 0) throw new Error(`SQLite foreign_key_check failed for ${foreignRows.length} row(s).`);
  database.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run("integrity_checked_signature", integritySignature);
}

function migrateDictionaryPayloads(database) {
  const rowCount = database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries").get()?.count ?? 0;
  if (rowCount > 0) return;
  const rows = database.prepare("SELECT payload_json FROM dictionaries ORDER BY sort_order ASC, rowid ASC").all();
  const dictionaries = rows
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean)
    .filter((dictionary) => (dictionary.entries?.length ?? 0) > 0 || (dictionary.frequencyEntries?.length ?? 0) > 0);
  if (dictionaries.length === 0) return;
  database.transaction((items) => insertDictionaries(database, items))(dictionaries);
}

function backfillDocumentBodies(database) {
  const rows = database.prepare("SELECT * FROM documents").all();
  const existing = new Set(database.prepare("SELECT document_id FROM document_bodies").all().map((row) => row.document_id));
  for (const row of rows) {
    if (existing.has(row.id)) continue;
    insertDocumentBody(database, "documents", {
      id: row.id,
      text: row.text,
      chapters: parseJson(row.chapters_json, []),
      updatedAt: row.updated_at
    });
  }
  const trashRows = database.prepare("SELECT * FROM trash_documents").all();
  const existingTrash = new Set(database.prepare("SELECT document_id FROM trash_document_bodies").all().map((row) => row.document_id));
  for (const row of trashRows) {
    if (existingTrash.has(row.id)) continue;
    insertDocumentBody(database, "trash_documents", {
      id: row.id,
      text: row.text,
      chapters: parseJson(row.chapters_json, []),
      updatedAt: row.updated_at
    });
  }
}

function bumpRevision(database, domain) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO store_revisions (domain, revision, updated_at)
    VALUES (?, 1, ?)
    ON CONFLICT(domain) DO UPDATE SET
      revision = store_revisions.revision + 1,
      updated_at = excluded.updated_at
  `).run(String(domain), now);
}

function lookupDictionaryEntriesSql(database, dictionaryIds = [], term = "", options = {}) {
  const ids = [...new Set((Array.isArray(dictionaryIds) ? dictionaryIds : []).map(String).filter(Boolean))];
  const normalized = String(term ?? "");
  if (ids.length === 0 || !normalized) return [];
  const limit = Math.max(1, Math.min(Number(options.limit ?? 24) || 24, 100));
  const prefix = Boolean(options.prefix);
  const rows = [];
  const seen = new Set();
  for (const dictionaryId of ids) {
    if (rows.length >= limit) break;
    const exactRows = prefix
      ? lookupDictionaryEntryRowsByPrefix(database, dictionaryId, normalized)
      : lookupDictionaryEntryRowsByExactMatch(database, dictionaryId, normalized);
    for (const row of exactRows) {
      const key = [row.dictionary_id, row.term, row.reading, row.content_id].join("\u0001");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      if (rows.length >= limit) break;
    }
  }
  return hydrateDictionaryEntryRows(database, rows);
}

// Cache compiled statements outside the functions so they only compile ONCE on startup
let stmtExactTerm = null;
let stmtExactReading = null;
let stmtPrefixTerm = null;
let stmtPrefixReading = null;

function lookupDictionaryEntryRowsByExactMatch(database, dictionaryId = "", term = "") {
  const id = String(dictionaryId ?? "");
  const normalized = String(term ?? "");
  if (!id || !normalized) return [];

  // Compile once, reuse indefinitely. Added LIMIT 10 to prevent JS memory flooding.
  if (!stmtExactTerm) {
    stmtExactTerm = database.prepare(`
      SELECT e.dictionary_id, e.sequence, e.term, e.reading, e.content_id, d.name AS dictionary, d.type, d.sort_order, d.language
      FROM dictionary_entries e JOIN dictionaries d ON d.id = e.dictionary_id
      WHERE e.dictionary_id = ? AND e.term = ?
      ORDER BY d.sort_order ASC, e.sequence ASC
      LIMIT 10
    `);
    stmtExactReading = database.prepare(`
      SELECT e.dictionary_id, e.sequence, e.term, e.reading, e.content_id, d.name AS dictionary, d.type, d.sort_order, d.language
      FROM dictionary_entries e JOIN dictionaries d ON d.id = e.dictionary_id
      WHERE e.dictionary_id = ? AND e.reading = ?
      ORDER BY d.sort_order ASC, e.sequence ASC
      LIMIT 10
    `);
  }

  // Executes two lightning-fast index lookups and merges them
  return stmtExactTerm.all(id, normalized).concat(stmtExactReading.all(id, normalized));
}

function lookupDictionaryEntryRowsByPrefix(database, dictionaryId = "", term = "") {
  const id = String(dictionaryId ?? "");
  const normalized = String(term ?? "");
  if (!id || !normalized) return [];
  const upper = prefixUpperBound(normalized);

  // Added LIMIT 10 to prevent massive prefix wildcard flooding
  if (!stmtPrefixTerm) {
    stmtPrefixTerm = database.prepare(`
      SELECT e.dictionary_id, e.sequence, e.term, e.reading, e.content_id, d.name AS dictionary, d.type, d.sort_order, d.language
      FROM dictionary_entries e JOIN dictionaries d ON d.id = e.dictionary_id
      WHERE e.dictionary_id = ? AND e.term >= ? AND e.term < ?
      ORDER BY d.sort_order ASC, e.sequence ASC
      LIMIT 10
    `);
    stmtPrefixReading = database.prepare(`
      SELECT e.dictionary_id, e.sequence, e.term, e.reading, e.content_id, d.name AS dictionary, d.type, d.sort_order, d.language
      FROM dictionary_entries e JOIN dictionaries d ON d.id = e.dictionary_id
      WHERE e.dictionary_id = ? AND e.reading >= ? AND e.reading < ?
      ORDER BY d.sort_order ASC, e.sequence ASC
      LIMIT 10
    `);
  }

  return stmtPrefixTerm.all(id, normalized, upper).concat(stmtPrefixReading.all(id, normalized, upper));
}

function lookupDictionaryEntriesBatchSql(database, dictionaryId = "", terms = [], options = {}) {
  const id = String(dictionaryId ?? "");
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : [])
    .map((term) => String(term ?? ""))
    .filter(Boolean))];
  if (!id || normalizedTerms.length === 0) return new Map();
  const limitPerTerm = Math.max(1, Math.min(Number(options.limitPerTerm ?? 3) || 3, 12));
  const byTerm = new Map(normalizedTerms.map((term) => [term, []]));
  const chunkSize = 400;
  for (let index = 0; index < normalizedTerms.length; index += chunkSize) {
    const chunk = normalizedTerms.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database.prepare(`
      SELECT e.dictionary_id, e.sequence, e.term, e.reading, e.content_id, d.name AS dictionary,
        d.type, d.sort_order, d.language
      FROM dictionary_entries e
      JOIN dictionaries d ON d.id = e.dictionary_id
      WHERE e.dictionary_id = ? AND (e.term IN (${placeholders}) OR e.reading IN (${placeholders}))
      ORDER BY e.sequence ASC
    `).all(id, ...chunk, ...chunk);
    for (const entry of hydrateDictionaryEntryRows(database, rows)) {
      const keys = [];
      if (byTerm.has(entry.term)) keys.push(entry.term);
      if (byTerm.has(entry.reading)) keys.push(entry.reading);
      for (const key of keys) {
        const list = byTerm.get(key);
        if (list.length < limitPerTerm) list.push(entry);
      }
    }
  }
  return byTerm;
}

function lookupDictionaryFrequenciesSql(database, dictionaryIds = [], term = "", options = {}) {
  const ids = [...new Set((Array.isArray(dictionaryIds) ? dictionaryIds : []).map(String).filter(Boolean))];
  const normalized = String(term ?? "");
  if (ids.length === 0 || !normalized) return [];
  const limit = Math.max(1, Math.min(Number(options.limit ?? 24) || 24, 100));
  const idPlaceholders = ids.map(() => "?").join(", ");
  const orderClause = sqlDictionaryOrder(ids, "f.dictionary_id");
  const rows = database.prepare(`
    SELECT f.dictionary_id, f.sequence, f.term, f.reading, f.value, f.display_value,
      d.name AS dictionary, d.sort_order, d.language
    FROM dictionary_frequencies f
    JOIN dictionaries d ON d.id = f.dictionary_id
    WHERE f.dictionary_id IN (${idPlaceholders}) AND (f.term = ? OR f.reading = ?)
    ORDER BY ${orderClause}, f.sequence ASC
    LIMIT ?
  `).all(...ids, normalized, normalized, limit);
  return rows.map((row) => {
    return {
      dictionary: row.dictionary,
      dictionaryId: row.dictionary_id,
      language: row.language || "unknown",
      term: row.term,
      reading: row.reading,
      value: row.value,
      displayValue: row.display_value
    };
  });
}

function loadDocumentBodySql(database, documentId = "", options = {}) {
  const table = options.trash ? "trash_document_bodies" : "document_bodies";
  const row = database.prepare(`
    SELECT document_id, text, chapters_json, text_length, source_hash, updated_at
    FROM ${table}
    WHERE document_id = ?
    LIMIT 1
  `).get(String(documentId ?? ""));
  if (!row) return null;
  return {
    documentId: row.document_id,
    text: row.text,
    chapters: parseJson(row.chapters_json, []),
    textLength: Number(row.text_length) || 0,
    sourceHash: row.source_hash,
    updatedAt: row.updated_at
  };
}

function rowToDictionaryMetadata(row) {
  return {
    id: row.id,
    type: row.type || "term",
    name: row.name || "",
    filename: row.filename || "",
    sortOrder: Number(row.sort_order) || 0,
    language: row.language || "unknown",
    format: row.format || "legacy",
    enabledForLookup: row.enabled_for_lookup !== 0,
    selectedForWordBank: row.selected_for_wordbank === 1,
    importedAt: row.imported_at || "",
    validationStatus: row.validation_status || "valid",
    entriesCount: Number(row.entries_count) || 0,
    frequencyCount: Number(row.frequency_count) || 0,
    updatedAt: row.updated_at || ""
  };
}

function ensureColumn(database, table, column, definition) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (columns.has(column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function loadDocumentPageWindowSql(database, documentId = "", pageIndex = 0, options = {}) {
  const radius = Math.max(0, Math.min(Number(options.radius ?? 1) || 0, 10));
  const center = Math.max(0, Number(pageIndex) || 0);
  const start = Math.max(0, center - radius);
  const end = center + radius;
  return database.prepare(`
    SELECT id, document_id, page_index, chapter_id, chapter_title, text, html, source_hash, updated_at
    FROM document_pages
    WHERE document_id = ? AND page_index BETWEEN ? AND ?
    ORDER BY page_index ASC
  `).all(String(documentId ?? ""), start, end).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    pageIndex: Number(row.page_index) || 0,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    text: row.text,
    html: row.html,
    sourceHash: row.source_hash,
    updatedAt: row.updated_at
  }));
}

function hydrateDictionaryEntryRows(database, rows = []) {
  if (rows.length === 0) return [];
  const contentIds = [...new Set(rows.map((row) => row.content_id).filter(Boolean))];
  const contentById = new Map();
  const missingContentIds = [];
  for (const id of contentIds) {
    if (dictionaryContentCache.has(id)) contentById.set(id, dictionaryContentCache.get(id));
    else missingContentIds.push(id);
  }
  if (missingContentIds.length > 0) {
    const placeholders = missingContentIds.map(() => "?").join(", ");
    for (const row of database.prepare(`
      SELECT id, definitions_json, details_json, tags_json
      FROM dictionary_entry_content
      WHERE id IN (${placeholders})
    `).all(...missingContentIds)) {
      const content = {
        definitions: parseJson(row.definitions_json, []),
        details: parseJson(row.details_json, []),
        tags: parseJson(row.tags_json, [])
      };
      contentById.set(row.id, content);
      dictionaryContentCache.set(row.id, content);
      if (dictionaryContentCache.size > DICTIONARY_CONTENT_CACHE_LIMIT) {
        dictionaryContentCache.delete(dictionaryContentCache.keys().next().value);
      }
    }
  }
  return rows.map((row) => {
    const content = contentById.get(row.content_id) ?? {};
    return {
      term: row.term,
      reading: row.reading,
      definitions: content.definitions ?? [],
      details: content.details ?? [],
      tags: content.tags ?? [],
      dictionary: row.dictionary,
      dictionaryId: row.dictionary_id,
      language: row.language || "unknown",
      sortOrder: Number(row.sort_order) || 0
    };
  });
}

function sqlDictionaryOrder(ids = [], column = "e.dictionary_id") {
  return `CASE ${ids.map((id, index) => `WHEN ${column} = '${sqlLiteral(id)}' THEN ${index}`).join(" ")} ELSE ${ids.length} END`;
}

function sqlLiteral(value = "") {
  return String(value).replaceAll("'", "''");
}

function prefixUpperBound(value = "") {
  return `${String(value)}\uffff`;
}

function hashString(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
