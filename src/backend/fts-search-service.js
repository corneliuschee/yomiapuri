import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATUS_KEY = "fts5-v2";
const CHUNKS_TABLE = "search_chunks_v2";
const FTS_TABLE = "search_chunks_fts_v2";
const DEFAULT_TOKENIZER_MODE = "kuromoji-dictionary-aware-v1";

export function createFtsSearchService({
  dbPath,
  getState,
  analyzeText,
  normalizeJapaneseTerm = defaultNormalize,
  hasJapaneseText = defaultHasJapaneseText,
  tokenizerVersion = "",
  normalizerVersion = "",
  dictionarySignature = () => ""
}) {
  let db;
  let ftsAvailable = false;

  function open() {
    if (db) return db;
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    ensureSchema(db);
    return db;
  }

  function ensureSchema(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        chapter_id TEXT NOT NULL DEFAULT '',
        chapter_title TEXT NOT NULL DEFAULT '',
        page INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT 'sentence',
        raw_text TEXT NOT NULL DEFAULT '',
        normalized_text TEXT NOT NULL DEFAULT '',
        terms_text TEXT NOT NULL DEFAULT '',
        readings_text TEXT NOT NULL DEFAULT '',
        title_text TEXT NOT NULL DEFAULT '',
        known_coverage REAL NOT NULL DEFAULT 0,
        terms_json TEXT NOT NULL DEFAULT '[]',
        dictionary_forms_json TEXT NOT NULL DEFAULT '[]',
        dictionary_matches_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL DEFAULT '',
        tokenizer_version TEXT NOT NULL DEFAULT '',
        normalizer_version TEXT NOT NULL DEFAULT '',
        dictionary_signature TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_search_chunks_v2_id ON ${CHUNKS_TABLE}(id);
      CREATE INDEX IF NOT EXISTS idx_search_chunks_v2_document ON ${CHUNKS_TABLE}(document_id);
      CREATE INDEX IF NOT EXISTS idx_search_chunks_v2_page ON ${CHUNKS_TABLE}(document_id, page);
      CREATE TABLE IF NOT EXISTS search_index_status (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT ''
      );
    `);
    ensureFtsTable(database);
  }

  function ensureFtsTable(database) {
    try {
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
          chunkId UNINDEXED,
          rawText,
          termsText,
          readingsText,
          titleText,
          tokenize = 'unicode61'
        );
      `);
      const columns = database.prepare(`PRAGMA table_info(${FTS_TABLE})`).all();
      if (!columns.some((column) => column.name === "chunkId")) {
        database.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
        database.exec(`
          CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(
            chunkId UNINDEXED,
            rawText,
            termsText,
            readingsText,
            titleText,
            tokenize = 'unicode61'
          );
        `);
      }
      ftsAvailable = true;
    } catch {
      ftsAvailable = false;
    }
  }

  async function rebuild(chunks = [], options = {}) {
    const database = open();
    if (!ftsAvailable) {
      const unavailable = {
        ready: false,
        stale: true,
        chunks: 0,
        tokenizerMode: DEFAULT_TOKENIZER_MODE,
        error: "SQLite FTS5 is not available in this runtime."
      };
      writeStatus(database, unavailable);
      return unavailable;
    }

    const activeIds = activeDocumentIds();
    const signatureValue = signature();
    const rowsById = new Map();
    let skipped = 0;

    const existingStates = new Map();
    const existingFtsStates = new Set();
    const allIds = chunks.map(chunk => chunkIdFor(chunk));
    
    const DB_BATCH_LIMIT = 500; 
    for (let i = 0; i < allIds.length; i += DB_BATCH_LIMIT) {
      const batchIds = allIds.slice(i, i + DB_BATCH_LIMIT);
      const placeholders = batchIds.map(() => '?').join(',');
      
      const chunkRows = database.prepare(
        `SELECT id, raw_text, source_hash, tokenizer_version, normalizer_version, dictionary_signature 
         FROM ${CHUNKS_TABLE} WHERE id IN (${placeholders})`
      ).all(...batchIds);
      
      for (const row of chunkRows) existingStates.set(row.id, row);
      
      const ftsRows = database.prepare(
        `SELECT chunkId FROM ${FTS_TABLE} WHERE chunkId IN (${placeholders})`
      ).all(...batchIds);
      
      for (const row of ftsRows) existingFtsStates.add(row.chunkId);
    }

    const chunksToProcess = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!activeIds.has(String(chunk.documentId ?? ""))) continue;
      
      const id = allIds[i];
      const existing = existingStates.get(id);
      const hasFts = existingFtsStates.has(id);
      
      const isUnchanged = existing
        && hasFts
        && existing.raw_text === String(chunk.text ?? "")
        && existing.tokenizer_version === tokenizerVersion
        && existing.normalizer_version === normalizerVersion
        && existing.dictionary_signature === signatureValue;

      if (isUnchanged || (options.existingOnly === true && (!existing || !hasFts))) {
        skipped += 1;
        continue;
      }
      
      chunksToProcess.push(chunk);
    }

    const ASYNC_BATCH_SIZE = 25; 
    for (let i = 0; i < chunksToProcess.length; i += ASYNC_BATCH_SIZE) {
      const batch = chunksToProcess.slice(i, i + ASYNC_BATCH_SIZE);
      
      const builtRows = await Promise.all(batch.map(c => ftsRowForChunk(c, options)));
      
      for (const row of builtRows) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
    }

    const rows = [...rowsById.values()];

    const insertChunk = database.prepare(`
      INSERT INTO ${CHUNKS_TABLE} (
        id, document_id, title, chapter_id, chapter_title, page, type,
        raw_text, normalized_text, terms_text, readings_text, title_text,
        known_coverage, terms_json, dictionary_forms_json, dictionary_matches_json,
        source_hash, tokenizer_version, normalizer_version, dictionary_signature, updated_at
      ) VALUES (
        @id, @documentId, @title, @chapterId, @chapterTitle, @page, @type,
        @rawText, @normalizedText, @termsText, @readingsText, @titleText,
        @knownCoverage, @termsJson, @dictionaryFormsJson, @dictionaryMatchesJson,
        @sourceHash, @tokenizerVersion, @normalizerVersion, @dictionarySignature, @updatedAt
      )
    `);
    const updateChunk = database.prepare(`
      UPDATE ${CHUNKS_TABLE} SET
        document_id = @documentId,
        title = @title,
        chapter_id = @chapterId,
        chapter_title = @chapterTitle,
        page = @page,
        type = @type,
        raw_text = @rawText,
        normalized_text = @normalizedText,
        terms_text = @termsText,
        readings_text = @readingsText,
        title_text = @titleText,
        known_coverage = @knownCoverage,
        terms_json = @termsJson,
        dictionary_forms_json = @dictionaryFormsJson,
        dictionary_matches_json = @dictionaryMatchesJson,
        source_hash = @sourceHash,
        tokenizer_version = @tokenizerVersion,
        normalizer_version = @normalizerVersion,
        dictionary_signature = @dictionarySignature,
        updated_at = @updatedAt
      WHERE id = @id
    `);
    const insertFts = database.prepare(`
      INSERT INTO ${FTS_TABLE} (chunkId, rawText, termsText, readingsText, titleText)
      VALUES (@id, @rawText, @termsText, @readingsText, @titleText)
    `);
    const deleteFts = database.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunkId = ?`);
    const deleteChunk = database.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE id = ?`);
    const idsByPruneDocument = pruneIdSets(rows, options.pruneDocuments);
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    const txn = database.transaction(() => {
      for (const row of rows) {
        const payload = { ...row, updatedAt: now };
        const existing = existingStates.get(row.id);
        const unchanged = existing
          && existingFtsStates.has(row.id)
          && existing.source_hash === row.sourceHash
          && existing.tokenizer_version === row.tokenizerVersion
          && existing.normalizer_version === row.normalizerVersion
          && existing.dictionary_signature === row.dictionarySignature;
        if (unchanged) {
          continue;
        }
        let updateResult;
        try {
          updateResult = updateChunk.run(payload);
          deleteFts.run(row.id);
          if (updateResult.changes === 0) {
            deleteChunk.run(row.id);
            insertChunk.run(payload);
          }
          insertFts.run(payload);
        } catch (error) {
          throw new Error(`FTS chunk write failed for id=${row.id} doc=${row.documentId} page=${row.page} type=${row.type}: ${error.message}`);
        }
        if (updateResult.changes > 0 || existing) updated += 1;
        else inserted += 1;
      }
      for (const [documentId, keepIds] of idsByPruneDocument.entries()) {
        const obsoleteRows = database.prepare(`
          SELECT id FROM ${CHUNKS_TABLE}
          WHERE document_id = ?
        `).all(documentId);
        for (const obsolete of obsoleteRows) {
          if (keepIds.has(obsolete.id)) continue;
          deleteFts.run(obsolete.id);
          const result = deleteChunk.run(obsolete.id);
          deleted += result.changes;
        }
      }
      writeStatus(database, {
        ready: true,
        stale: false,
        chunks: countActiveChunks(database),
        inserted,
        updated,
        deleted,
        skipped,
        rebuiltAt: now,
        tokenizerMode: DEFAULT_TOKENIZER_MODE,
        tokenizerVersion,
        normalizerVersion,
        dictionarySignature: signature(),
        error: ""
      });
    });
    txn();
    return status();
  }

  async function ftsRowForChunk(chunk = {}, options = {}) {
    const rawText = String(chunk.text ?? "");
    const title = String(chunk.title ?? "");
    const chapterTitle = String(chunk.chapterTitle ?? "");
    const normalizedText = normalizeText(rawText);
    const titleText = uniqueText([title, chapterTitle]);
    const payload = await payloadForText(rawText, chunk, { analyze: options.analyze !== false });
    return {
      id: chunkIdFor(chunk),
      documentId: String(chunk.documentId ?? ""),
      title,
      chapterId: String(chunk.chapterId ?? ""),
      chapterTitle,
      page: Number.isFinite(Number(chunk.page)) ? Number(chunk.page) : 0,
      type: String(chunk.type ?? "sentence"),
      rawText,
      normalizedText,
      termsText: payload.termsText,
      readingsText: payload.readingsText,
      titleText,
      knownCoverage: Number(chunk.knownCoverage) || 0,
      termsJson: JSON.stringify(uniqueValues([...(chunk.terms ?? []), ...payload.terms]).slice(0, 80)),
      dictionaryFormsJson: JSON.stringify(uniqueValues([...(chunk.dictionaryForms ?? []), ...payload.dictionaryForms]).slice(0, 80)),
      dictionaryMatchesJson: JSON.stringify(uniqueValues(chunk.dictionaryMatches ?? []).slice(0, 40)),
      sourceHash: sourceHash(`${rawText}\u0001${payload.termsText}\u0001${payload.readingsText}`),
      tokenizerVersion,
      normalizerVersion,
      dictionarySignature: signature()
    };
  }

  async function payloadForText(text = "", chunk = {}, options = {}) {
    const terms = [];
    const readings = [];
    const dictionaryForms = [];
    for (const value of [
      text,
      chunk.title,
      chunk.chapterTitle,
      ...(chunk.terms ?? []),
      ...(chunk.dictionaryForms ?? []),
      ...(chunk.dictionaryMatches ?? [])
    ]) {
      addTerm(terms, value);
    }
    for (const item of chunk.authorRubyReadings ?? []) {
      addTerm(terms, item.surface);
      addReading(readings, item.reading);
    }
    for (const marker of rubyMarkers(text)) {
      addTerm(terms, marker.surface);
      addReading(readings, marker.reading);
    }

    try {
      if (options.analyze === false) throw new Error("Analysis disabled for fast FTS rebuild.");
      const analysis = await analyzeText(text);
      for (const token of analysis.tokens ?? []) {
        const tokenTerms = [
          token.surface,
          token.base,
          token.dictionaryForm,
          token.normalized,
          ...(Array.isArray(token.lookupTerms) ? token.lookupTerms : []),
          ...(Array.isArray(token.variants) ? token.variants : [])
        ];
        for (const value of tokenTerms) addTerm(terms, value);
        const dictionaryForm = normalizeValue(token.dictionaryForm || token.base || token.surface);
        if (dictionaryForm) dictionaryForms.push(dictionaryForm);
        for (const value of [
          token.reading,
          token.dictionaryReading,
          token.displayReading,
          token.authorReading
        ]) addReading(readings, value);
      }
    } catch {
      // The raw substring path still works if token analysis fails.
    }

    for (const match of String(text ?? "").normalize("NFKC").matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
      addTerm(terms, match[0]);
    }

    return {
      terms: uniqueValues(terms),
      dictionaryForms: uniqueValues(dictionaryForms),
      termsText: uniqueText(terms),
      readingsText: uniqueText(readings)
    };
  }

  async function queryPlan(query = "") {
    const raw = String(query ?? "").normalize("NFKC").trim();
    const terms = [];
    const readings = [];
    addTerm(terms, raw);
    for (const term of splitQueryTerms(raw)) addTerm(terms, term);
    for (const marker of rubyMarkers(raw)) {
      addTerm(terms, marker.surface);
      addReading(readings, marker.reading);
    }
    for (const match of raw.matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
      addTerm(terms, match[0]);
    }
    return {
      raw,
      normalizedRaw: normalizeText(raw),
      terms: uniqueValues(terms),
      readings: uniqueValues(readings),
      match: buildFtsMatch([...terms, ...readings])
    };
  }

  async function search(query = "", options = {}) {
    const database = open();
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const plan = await queryPlan(query);
    if (!plan.normalizedRaw && plan.terms.length === 0) return { query: "", results: [], status: status() };
    const activeIds = activeDocumentIds();
    if (activeIds.size === 0) return { query: plan.raw, results: [], status: status() };

    const exactRows = exactSearch(database, plan, { ...options, limit: limit * 2, activeIds });
    if (exactRows.length >= limit) {
      return {
        query: plan.raw,
        queryPlan: plan,
        results: exactRows
          .sort((a, b) => b.lexicalScore - a.lexicalScore)
          .slice(0, limit),
        status: status()
      };
    }
    if (hasJapaneseText(plan.raw)) {
      return {
        query: plan.raw,
        queryPlan: plan,
        results: exactRows,
        status: status()
      };
    }
    const bm25Rows = plan.match ? bm25Search(database, plan, { ...options, limit: limit * 4, activeIds }) : [];
    const merged = mergeFtsRows(exactRows, bm25Rows)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, limit);
    return { query: plan.raw, queryPlan: plan, results: merged, status: status() };
  }

  function exactSearch(database, plan, options) {
    const japaneseQuery = hasJapaneseText(plan.raw);
    const clauses = japaneseQuery
      ? [
          "instr(c.raw_text, @rawNeedle) > 0",
          "instr(c.normalized_text, @rawNeedle) > 0",
          "instr(c.terms_text, @rawNeedle) > 0",
          "instr(c.readings_text, @rawNeedle) > 0"
        ]
      : ["c.normalized_text LIKE @likeRaw ESCAPE '\\'"];
    const params = japaneseQuery
      ? { rawNeedle: plan.normalizedRaw, limit: options.limit }
      : { likeRaw: `%${escapeLike(plan.normalizedRaw)}%`, limit: options.limit };
    let index = 0;
    for (const term of (japaneseQuery ? [] : plan.terms.slice(0, 16))) {
      const normalized = normalizeText(term);
      if (!normalized || normalized === plan.normalizedRaw) continue;
      index += 1;
      clauses.push(`c.normalized_text LIKE @like${index} ESCAPE '\\'`);
      params[`like${index}`] = `%${escapeLike(normalized)}%`;
    }
    const where = scopedWhere(options, params);
    const sql = `
      SELECT c.*
        FROM ${CHUNKS_TABLE} c
      WHERE ${where.sql} AND (${clauses.join(" OR ")})
      ORDER BY c.document_id, c.page, c.type
      LIMIT @limit
    `;
    return database.prepare(sql).all(params).map((row) => toSearchRow(row, {
      exactScore: 1,
      lexicalScore: 50 + Math.min(25, plan.normalizedRaw.length)
    }));
  }

  function bm25Search(database, plan, options) {
    const params = { match: plan.match, limit: options.limit };
    const where = scopedWhere(options, params);
    const sql = `
      SELECT c.*, bm25(${FTS_TABLE}, 5.0, 3.0, 2.0, 1.5) AS bm25_score
      FROM ${FTS_TABLE}
      JOIN ${CHUNKS_TABLE} c ON c.id = ${FTS_TABLE}.chunkId
      WHERE ${FTS_TABLE} MATCH @match AND ${where.sql}
      ORDER BY bm25_score ASC
      LIMIT @limit
    `;
    try {
      return database.prepare(sql).all(params).map((row, index) => toSearchRow(row, {
        bm25Score: Number(row.bm25_score),
        lexicalScore: 20 / (index + 1)
      }));
    } catch {
      return [];
    }
  }

  function scopedWhere(options, params) {
    const clauses = [];
    const activeIds = [...(options.activeIds ?? activeDocumentIds())];
    if (activeIds.length === 0) clauses.push("0");
    else {
      clauses.push(`c.document_id IN (${activeIds.map((_, index) => `@active${index}`).join(", ")})`);
      activeIds.forEach((id, index) => {
        params[`active${index}`] = id;
      });
    }
    if (options.documentId) {
      clauses.push("c.document_id = @documentId");
      params.documentId = String(options.documentId);
    }
    return { sql: clauses.join(" AND ") || "1" };
  }

  function toSearchRow(row = {}, scores = {}) {
    return {
      id: row.id,
      documentId: row.document_id,
      title: row.title,
      chapterId: row.chapter_id,
      chapterTitle: row.chapter_title,
      page: Number(row.page) || 0,
      text: row.raw_text,
      type: row.type,
      knownCoverage: Number(row.known_coverage) || 0,
      terms: parseJsonArray(row.terms_json),
      dictionaryForms: parseJsonArray(row.dictionary_forms_json),
      dictionaryMatches: parseJsonArray(row.dictionary_matches_json),
      lexicalScore: Number(scores.lexicalScore) || 0,
      exactScore: Number(scores.exactScore) || 0,
      bm25Score: Number.isFinite(Number(scores.bm25Score)) ? Number(scores.bm25Score) : null,
      source: scores.exactScore ? "fts-exact" : "fts-bm25"
    };
  }

  function mergeFtsRows(exactRows = [], bm25Rows = []) {
    const byId = new Map();
    for (const row of [...bm25Rows, ...exactRows]) {
      const existing = byId.get(row.id);
      if (!existing) {
        byId.set(row.id, row);
        continue;
      }
      byId.set(row.id, {
        ...existing,
        ...row,
        lexicalScore: Math.max(Number(existing.lexicalScore) || 0, Number(row.lexicalScore) || 0),
        exactScore: Math.max(Number(existing.exactScore) || 0, Number(row.exactScore) || 0),
        bm25Score: existing.bm25Score ?? row.bm25Score,
        source: existing.exactScore || row.exactScore ? "fts-exact" : "fts-bm25"
      });
    }
    return [...byId.values()];
  }

  function deleteDocument(documentId = "") {
    const normalizedDocumentId = String(documentId ?? "");
    if (!normalizedDocumentId) return { deleted: 0 };
    const database = open();
    const chunkIds = [...new Set(database.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE document_id = ?`).all(normalizedDocumentId).map((row) => row.id))];
    if (chunkIds.length === 0) return { deleted: 0 };
    const txn = database.transaction(() => {
      const deleteFts = database.prepare(`DELETE FROM ${FTS_TABLE} WHERE chunkId = ?`);
      const deleteChunk = database.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE id = ?`);
      for (const id of chunkIds) {
        deleteFts.run(id);
        deleteChunk.run(id);
      }
      writeStatus(database, { ...status(), chunks: Math.max(0, countChunks(database)), updatedAt: new Date().toISOString() });
    });
    txn();
    return { deleted: chunkIds.length };
  }

  function markStale(reason = "Search index is stale.") {
    const database = open();
    writeStatus(database, { ...status(), ready: false, stale: true, error: reason });
  }

  function status() {
    const database = open();
    const raw = database.prepare("SELECT value_json FROM search_index_status WHERE key = ?").get(STATUS_KEY);
    const stored = raw ? safeJson(raw.value_json, {}) : {};
    return {
      provider: "sqlite-fts5",
      ready: Boolean(stored.ready) && ftsAvailable,
      stale: Boolean(stored.stale),
      chunks: countActiveChunks(database),
      cachedChunks: countChunks(database),
      inserted: Number(stored.inserted) || 0,
      updated: Number(stored.updated) || 0,
      deleted: Number(stored.deleted) || 0,
      skipped: Number(stored.skipped) || 0,
      rebuiltAt: stored.rebuiltAt || "",
      updatedAt: stored.updatedAt || stored.rebuiltAt || "",
      tokenizerMode: stored.tokenizerMode || DEFAULT_TOKENIZER_MODE,
      tokenizerVersion: stored.tokenizerVersion || tokenizerVersion,
      normalizerVersion: stored.normalizerVersion || normalizerVersion,
      dictionarySignature: stored.dictionarySignature || "",
      error: ftsAvailable ? (stored.error || "") : "SQLite FTS5 is not available in this runtime."
    };
  }

  function countChunks(database) {
    try {
      return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${CHUNKS_TABLE}`).get()?.count) || 0;
    } catch {
      return 0;
    }
  }

  function countActiveChunks(database) {
    const ids = [...activeDocumentIds()];
    if (ids.length === 0) return 0;
    try {
      const placeholders = ids.map((_, index) => `@id${index}`).join(", ");
      const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
      return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${CHUNKS_TABLE} WHERE document_id IN (${placeholders})`).get(params)?.count) || 0;
    } catch {
      return 0;
    }
  }

  function documentAnalytics(known = new Set(), helpers = {}) {
    const database = open();
    const activeIds = [...activeDocumentIds()];
    const result = new Map();
    if (activeIds.length === 0) return result;
    const normalize = typeof helpers.normalizeJapaneseTerm === "function" ? helpers.normalizeJapaneseTerm : defaultNormalize;
    const hasJapanese = typeof helpers.hasJapaneseText === "function" ? helpers.hasJapaneseText : defaultHasJapaneseText;
    const placeholders = activeIds.map((_, index) => `@id${index}`).join(", ");
    const params = Object.fromEntries(activeIds.map((id, index) => [`id${index}`, id]));
    const rows = database.prepare(`
      SELECT document_id, known_coverage, terms_json, dictionary_forms_json
        FROM ${CHUNKS_TABLE}
      WHERE document_id IN (${placeholders})
    `).all(params);

    for (const row of rows) {
      const documentId = String(row.document_id ?? "");
      if (!documentId) continue;
      const entry = result.get(documentId) ?? {
        chunks: 0,
        knownTokens: 0,
        unknownTokens: 0,
        unknownTerms: new Set(),
        fallbackCoverageSum: 0,
        fallbackRows: 0
      };
      const dictionaryForms = parseJsonArray(row.dictionary_forms_json);
      const forms = uniqueValues(dictionaryForms.length > 0 ? dictionaryForms : parseJsonArray(row.terms_json))
        .map((term) => normalize(term))
        .filter((term) => term && hasJapanese(term) && term.length <= 24);

      if (forms.length === 0) {
        entry.fallbackCoverageSum += Number(row.known_coverage) || 0;
        entry.fallbackRows += 1;
        entry.chunks += 1;
        result.set(documentId, entry);
        continue;
      }

      for (const term of forms) {
        if (known.has(term)) entry.knownTokens += 1;
        else {
          entry.unknownTokens += 1;
          entry.unknownTerms.add(term);
        }
      }
      entry.chunks += 1;
      result.set(documentId, entry);
    }

    for (const [documentId, entry] of result.entries()) {
      const total = entry.knownTokens + entry.unknownTokens;
      const coverage = total
        ? Math.round((entry.knownTokens / total) * 100)
        : entry.fallbackRows
          ? Math.round(entry.fallbackCoverageSum / entry.fallbackRows)
          : 0;
      result.set(documentId, {
        source: "fts",
        chunks: entry.chunks,
        coverage,
        knownTokens: entry.knownTokens,
        unknownTokens: entry.unknownTokens,
        uniqueUnknown: entry.unknownTerms.size
      });
    }
    return result;
  }

  function writeStatus(database, value) {
    database.prepare(`
      INSERT INTO search_index_status (key, value_json, updated_at)
      VALUES (@key, @valueJson, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run({
      key: STATUS_KEY,
      valueJson: JSON.stringify(value),
      updatedAt: new Date().toISOString()
    });
  }

  function activeDocumentIds() {
    return new Set((getState()?.documents ?? []).map((document) => String(document.id ?? "")).filter(Boolean));
  }

  function signature() {
    return typeof dictionarySignature === "function" ? String(dictionarySignature() ?? "") : String(dictionarySignature ?? "");
  }

  function close() {
    if (!db) return;
    db.close();
    db = null;
  }

  return { rebuild, search, queryPlan, deleteDocument, markStale, status, documentAnalytics, payloadForText, close };
}

function pruneIdSets(rows = [], documentIds = []) {
  const targets = new Set((documentIds ?? []).map(String).filter(Boolean));
  const result = new Map();
  for (const documentId of targets) result.set(documentId, new Set());
  if (result.size === 0) return result;
  for (const row of rows) {
    const documentId = String(row.documentId ?? "");
    if (!result.has(documentId)) continue;
    result.get(documentId).add(String(row.id ?? ""));
  }
  return result;
}

export function escapeFtsTerm(value = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (!normalized) return "";
  return `"${normalized.replace(/"/g, '""')}"`;
}

function buildFtsMatch(values = []) {
  const escaped = uniqueValues(values)
    .filter((value) => value.length >= 2 || /[\u3400-\u9fff]/u.test(value))
    .slice(0, 24)
    .map(escapeFtsTerm)
    .filter(Boolean);
  return escaped.join(" OR ");
}

function addTerm(target, value) {
  const normalized = normalizeValue(value);
  if (!normalized) return;
  target.push(normalized);
}

function addReading(target, value) {
  const normalized = normalizeValue(value);
  if (!normalized) return;
  target.push(katakanaToHiragana(normalized));
}

function normalizeValue(value = "") {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeText(value = "") {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueText(values = []) {
  return uniqueValues(values).join(" ");
}

function parseJsonArray(value = "") {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeLike(value = "") {
  return String(value ?? "").replace(/[\\%_]/g, (match) => `\\${match}`);
}

function splitQueryTerms(query = "") {
  const terms = new Set();
  const normalized = String(query ?? "").normalize("NFKC");
  for (const match of normalized.matchAll(/[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) terms.add(match[0]);
  return [...terms];
}

function rubyMarkers(text = "") {
  const markers = [];
  for (const match of String(text ?? "").matchAll(/\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g)) {
    markers.push({
      surface: decodeMarker(match[1]),
      reading: decodeMarker(match[2])
    });
  }
  return markers;
}

function decodeMarker(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function katakanaToHiragana(value = "") {
  return String(value ?? "").replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

function sourceHash(value = "") {
  return createHash("sha1").update(String(value)).digest("hex");
}

function chunkIdFor(chunk = {}) {
  const explicit = String(chunk.id ?? "").trim();
  if (explicit) return explicit;
  return sourceHash(`${chunk.documentId ?? ""}\u0001${chunk.chapterId ?? ""}\u0001${chunk.page ?? ""}\u0001${chunk.type ?? ""}\u0001${chunk.text ?? ""}`);
}

async function ensureDirectoryForDb(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
}

function defaultNormalize(value = "") {
  return String(value ?? "").normalize("NFKC").trim();
}

function defaultHasJapaneseText(value = "") {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value ?? ""));
}

export async function ensureFtsDatabaseDirectory(dbPath) {
  await ensureDirectoryForDb(dbPath);
}
