
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
  
