import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const BOOK_BUCKET = "book-files";
const SYNC_TABLES = [
  "profiles",
  "devices",
  "documents",
  "document_files",
  "reading_progress",
  "reader_annotations",
  "known_terms",
  "cards",
  "app_settings",
  "learning_events",
  "sync_state"
];

export function defaultSyncSettings() {
  return {
    enabled: false,
    supabaseUrl: process.env.SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "",
    userId: "",
    userEmail: "",
    accessToken: "",
    refreshToken: "",
    deviceId: "",
    deviceName: defaultDeviceName(),
    lastSyncAt: "",
    lastPushAt: "",
    lastPullAt: "",
    lastError: "",
    status: "disabled"
  };
}

export function normalizeSyncSettings(settings = {}) {
  return {
    ...defaultSyncSettings(),
    ...settings,
    enabled: Boolean(settings.enabled),
    deviceId: settings.deviceId || randomUUID(),
    deviceName: String(settings.deviceName || defaultDeviceName()).trim() || defaultDeviceName(),
    supabaseUrl: String(settings.supabaseUrl || process.env.SUPABASE_URL || "").trim(),
    supabaseAnonKey: String(settings.supabaseAnonKey || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim()
  };
}

export function publicSyncSettings(settings = {}) {
  const normalized = normalizeSyncSettings(settings);
  return {
    enabled: normalized.enabled,
    configured: Boolean(normalized.supabaseUrl && normalized.supabaseAnonKey),
    hasUrl: Boolean(normalized.supabaseUrl),
    hasAnonKey: Boolean(normalized.supabaseAnonKey),
    supabaseUrl: normalized.supabaseUrl,
    userId: normalized.userId,
    userEmail: normalized.userEmail,
    signedIn: Boolean(normalized.accessToken && normalized.userId),
    deviceId: normalized.deviceId,
    deviceName: normalized.deviceName,
    lastSyncAt: normalized.lastSyncAt,
    lastPushAt: normalized.lastPushAt,
    lastPullAt: normalized.lastPullAt,
    lastError: normalized.lastError,
    status: normalized.status
  };
}

export function createSyncService({
  getState,
  saveState,
  mediaDir,
  eventLog,
  clearDocumentCache = () => {},
  createClient = createSupabaseClient,
  platform = process.platform
}) {
  function settings() {
    const state = getState();
    state.sync = normalizeSyncSettings(state.sync);
    return state.sync;
  }

  function publicStatus(extra = {}) {
    return { ...publicSyncSettings(settings()), ...extra };
  }

  async function updateSettings(patch = {}) {
    const state = getState();
    state.sync = normalizeSyncSettings({
      ...state.sync,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(patch.supabaseUrl !== undefined ? { supabaseUrl: patch.supabaseUrl } : {}),
      ...(patch.supabaseAnonKey !== undefined ? { supabaseAnonKey: patch.supabaseAnonKey } : {}),
      ...(patch.deviceName !== undefined ? { deviceName: patch.deviceName } : {})
    });
    await saveState();
    return publicStatus();
  }

  async function signIn({ email = "", password = "", supabaseUrl = "", supabaseAnonKey = "" } = {}) {
    await updateSettings({
      enabled: true,
      ...(supabaseUrl ? { supabaseUrl } : {}),
      ...(supabaseAnonKey ? { supabaseAnonKey } : {})
    });
    const client = await authedClient({ allowMissingSession: true });
    const { data, error } = await client.auth.signInWithPassword({
      email: String(email).trim(),
      password: String(password)
    });
    if (error) throw syncError(error.message || "Supabase sign-in failed.");
    const state = getState();
    state.sync = normalizeSyncSettings({
      ...state.sync,
      enabled: true,
      userId: data.user?.id ?? "",
      userEmail: data.user?.email ?? email,
      accessToken: data.session?.access_token ?? "",
      refreshToken: data.session?.refresh_token ?? "",
      lastError: "",
      status: "signed-in"
    });
    await saveState();
    await registerDevice();
    return publicStatus();
  }

  async function signOut() {
    const state = getState();
    try {
      const client = await authedClient({ allowMissingSession: true });
      await client.auth.signOut();
    } catch {
      // Local sign-out should still clear tokens if Supabase is unavailable.
    }
    state.sync = normalizeSyncSettings({
      ...state.sync,
      enabled: false,
      userId: "",
      userEmail: "",
      accessToken: "",
      refreshToken: "",
      status: "disabled",
      lastError: ""
    });
    await saveState();
    return publicStatus();
  }

  async function push() {
    const client = await authedClient();
    const state = getState();
    const sync = settings();
    const now = new Date().toISOString();
    const payload = await buildPushPayload(state, sync, mediaDir, eventLog);

    await upsertRows(client, "profiles", [{ id: sync.userId, email: sync.userEmail, updated_at: now }]);
    await upsertRows(client, "devices", [{
      user_id: sync.userId,
      device_id: sync.deviceId,
      name: sync.deviceName,
      platform,
      last_seen_at: now
    }], "user_id,device_id");
    const purged = await purgeRemoteDeletedDocuments(client, sync.userId);
    await maybeUploadDocumentFiles(client, payload.documentFiles);
    await upsertRows(client, "document_files", payload.documentFiles.map(({ bytes, local_path, ...row }) => row), "user_id,file_hash");
    await upsertRows(client, "documents", payload.documents, "user_id,id");
    await upsertRows(client, "reading_progress", payload.progress, "user_id,document_id");
    await upsertRows(client, "reader_annotations", payload.annotations, "user_id,document_id,kind");
    await upsertRows(client, "known_terms", payload.knownTerms, "user_id,term");
    await upsertRows(client, "cards", payload.cards, "user_id,id");
    await upsertRows(client, "app_settings", payload.settings, "user_id,key");
    await upsertRows(client, "learning_events", payload.events, "user_id,id");
    await upsertRows(client, "sync_state", [{
      user_id: sync.userId,
      device_id: sync.deviceId,
      last_push_at: now,
      last_pull_at: sync.lastPullAt || null,
      updated_at: now
    }], "user_id,device_id");

    state.sync = normalizeSyncSettings({
      ...state.sync,
      lastPushAt: now,
      lastSyncAt: now,
      lastError: "",
      status: "synced"
    });
    await saveState();
    return publicStatus({
      pushed: {
        documents: payload.documents.length,
        files: payload.documentFiles.length,
        purgedDeletedBooks: purged.documents,
        progress: payload.progress.length,
        annotations: payload.annotations.length,
        knownTerms: payload.knownTerms.length,
        cards: payload.cards.length,
        events: payload.events.length
      }
    });
  }

  async function pull() {
    const client = await authedClient();
    const state = getState();
    const sync = settings();
    const now = new Date().toISOString();
    const remote = {};
    for (const table of SYNC_TABLES.filter((table) => table !== "profiles" && table !== "devices" && table !== "sync_state")) {
      remote[table] = await selectRows(client, table, sync.userId);
    }
    const restoredFiles = await restoreRemoteMediaFiles(client, remote.document_files ?? [], mediaDir);
    applyRemoteRows(state, remote);
    state.sync = normalizeSyncSettings({
      ...state.sync,
      lastPullAt: now,
      lastSyncAt: now,
      lastError: "",
      status: "synced"
    });
    markVectorIndexStale(state);
    clearDocumentCache();
    await saveState();
    await importRemoteEvents(eventLog, remote.learning_events ?? []);
    return publicStatus({
      pulled: {
        documents: remote.documents?.length ?? 0,
        files: restoredFiles,
        progress: remote.reading_progress?.length ?? 0,
        annotations: remote.reader_annotations?.length ?? 0,
        knownTerms: remote.known_terms?.length ?? 0,
        cards: remote.cards?.length ?? 0,
        events: remote.learning_events?.length ?? 0
      }
    });
  }

  async function syncNow() {
    await push();
    return pull();
  }

  async function cleanupDeletedRemoteItems() {
    const client = await authedClient();
    const state = getState();
    const sync = settings();
    const purged = await purgeRemoteDeletedDocuments(client, sync.userId);
    const now = new Date().toISOString();
    state.sync = normalizeSyncSettings({
      ...state.sync,
      lastSyncAt: now,
      lastError: "",
      status: "synced"
    });
    await saveState();
    return publicStatus({ purged });
  }

  async function registerDevice() {
    const client = await authedClient();
    const sync = settings();
    await upsertRows(client, "devices", [{
      user_id: sync.userId,
      device_id: sync.deviceId,
      name: sync.deviceName,
      platform,
      last_seen_at: new Date().toISOString()
    }], "user_id,device_id");
  }

  async function authedClient({ allowMissingSession = false } = {}) {
    const sync = settings();
    if (!sync.supabaseUrl || !sync.supabaseAnonKey) throw syncError("Supabase URL and publishable key are required.");
    const client = createClient(sync.supabaseUrl, sync.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    if (sync.accessToken && sync.refreshToken) {
      const { data, error } = await client.auth.setSession({
        access_token: sync.accessToken,
        refresh_token: sync.refreshToken
      });
      if (error) throw syncError(error.message || "Supabase session expired. Sign in again.");
      if (data.session?.access_token && data.session.access_token !== sync.accessToken) {
        const state = getState();
        state.sync = normalizeSyncSettings({
          ...state.sync,
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token ?? sync.refreshToken,
          userId: data.user?.id ?? sync.userId,
          userEmail: data.user?.email ?? sync.userEmail
        });
        await saveState();
      }
    } else if (!allowMissingSession) {
      throw syncError("Sign in to Supabase before syncing.");
    }
    return client;
  }

  return { status: publicStatus, updateSettings, signIn, signOut, push, pull, syncNow, cleanupDeletedRemoteItems };
}

export async function buildPushPayload(state, sync, mediaDir, eventLog) {
  const documents = [];
  const documentFiles = [];
  const activeDocuments = (state.documents ?? []).map((document, index) => ({ document, orderIndex: index, deleted: false }));

  for (const item of activeDocuments) {
    const { document, orderIndex } = item;
    const fileRecords = await documentFileRecordsForDocument(sync.userId, document, mediaDir);
    documentFiles.push(...fileRecords);
    const sourceFileRecord = fileRecords.find((record) => record.local_path === document.sourcePath);
    documents.push({
      user_id: sync.userId,
      id: document.id,
      title: document.title ?? "",
      filename: document.filename ?? "",
      type: document.type ?? "",
      order_index: orderIndex,
      cover_path: document.coverPath ?? "",
      source_path: document.sourcePath ?? "",
      file_hash: sourceFileRecord?.file_hash ?? contentHash(document.text ?? document.id),
      content: {
        text: document.text ?? "",
        chapters: document.chapters ?? []
      },
      created_at: document.createdAt ?? new Date().toISOString(),
      updated_at: document.updatedAt ?? document.createdAt ?? new Date().toISOString()
    });
  }

  const activeDocumentIds = new Set(activeDocuments.map(({ document }) => document.id).filter(Boolean));
  const progress = Object.entries(state.progress ?? {}).filter(([documentId]) => activeDocumentIds.has(documentId)).map(([documentId, value]) => ({
    user_id: sync.userId,
    document_id: documentId,
    page: Number(value.page) || 0,
    chapter_id: value.chapterId ?? "",
    mode: value.mode === "paged" ? "paged" : "scroll",
    percentage: Number(value.percentage) || 0,
    scroll_top: Number(value.scrollTop) || 0,
    zoom: Number(value.zoom) || 100,
    updated_at: value.updatedAt ?? new Date().toISOString()
  }));

  const annotations = Object.entries(state.progress ?? {}).filter(([documentId]) => activeDocumentIds.has(documentId)).map(([documentId, value]) => ({
    user_id: sync.userId,
    document_id: documentId,
    kind: "reader_state",
    payload: {
      highlights: value.highlights ?? { pages: {}, scrollHtml: "" },
      bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks : []
    },
    updated_at: value.updatedAt ?? new Date().toISOString()
  }));

  const activeTerms = (state.knownTerms ?? []).map((term) => ({
    user_id: sync.userId,
    term,
    meta: state.knownTermMeta?.[term] ?? {},
    deleted_at: null,
    updated_at: state.knownTermMeta?.[term]?.addedAt ?? new Date().toISOString()
  }));
  const trashTerms = (state.trash?.knownTerms ?? []).map((entry) => {
    const term = typeof entry === "string" ? entry : entry?.term;
    return {
      user_id: sync.userId,
      term,
      meta: typeof entry === "object" ? entry.meta ?? {} : {},
      deleted_at: typeof entry === "object" ? entry.deletedAt ?? new Date().toISOString() : new Date().toISOString(),
      updated_at: typeof entry === "object" ? entry.deletedAt ?? new Date().toISOString() : new Date().toISOString()
    };
  }).filter((entry) => entry.term);

  const cards = (state.cards ?? []).map((card) => ({
    user_id: sync.userId,
    id: card.id || String(card.ankiNoteId || contentHash(JSON.stringify(card))),
    document_id: card.documentId ?? "",
    expression: card.expression ?? "",
    dictionary_form: card.dictionaryForm ?? card.expression ?? "",
    anki_note_id: Number.isFinite(Number(card.ankiNoteId)) ? Number(card.ankiNoteId) : null,
    payload: card,
    created_at: card.createdAt ?? new Date().toISOString(),
    updated_at: card.updatedAt ?? card.createdAt ?? new Date().toISOString()
  }));

  const settings = [
    { key: "anki", value: sanitizeAnkiSettings(state.anki) },
    { key: "media", value: state.media ?? {} },
    { key: "dictionarySettings", value: state.dictionarySettings ?? {} },
    { key: "templates", value: state.templates ?? [] },
    { key: "dictionariesMetadata", value: (state.dictionaries ?? []).map(dictionaryMetadataForSync) }
  ].map((entry) => ({
    user_id: sync.userId,
    key: entry.key,
    value: entry.value,
    updated_at: new Date().toISOString()
  }));

  const events = (await eventLog.readAll?.(2000) ?? []).map((event) => ({
    user_id: sync.userId,
    id: event.id,
    type: event.type,
    payload: event.payload ?? {},
    created_at: event.createdAt ?? new Date().toISOString()
  }));

  const knownTerms = dedupeRowsByFields([...activeTerms, ...trashTerms], ["user_id", "term"]);

  return { documents, documentFiles: dedupeRowsByFields(documentFiles, ["user_id", "storage_path"]), progress, annotations, knownTerms, cards, settings, events };
}

function applyRemoteRows(state, remote) {
  applyDocuments(state, remote.documents ?? []);
  applyProgress(state, remote.reading_progress ?? [], remote.reader_annotations ?? []);
  applyKnownTerms(state, remote.known_terms ?? []);
  applyCards(state, remote.cards ?? []);
  applySettings(state, remote.app_settings ?? []);
}

function applyDocuments(state, rows) {
  if (rows.length === 0) return;
  const active = [];
  for (const row of rows.sort((a, b) => Number(a.order_index) - Number(b.order_index))) {
    if (row.deleted_at) continue;
    const document = {
      id: row.id,
      title: row.title,
      filename: row.filename,
      type: row.type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      coverPath: row.cover_path ?? "",
      sourcePath: row.source_path ?? "",
      text: row.content?.text ?? "",
      chapters: row.content?.chapters ?? []
    };
    active.push(document);
  }
  state.documents = mergeByNewest(state.documents ?? [], active, "id", "updatedAt");
}

function applyProgress(state, progressRows, annotationRows) {
  state.progress ??= {};
  for (const row of progressRows) {
    const current = state.progress[row.document_id] ?? {};
    if (isNewer(row.updated_at, current.updatedAt)) {
      state.progress[row.document_id] = {
        ...current,
        percentage: Number(row.percentage) || 0,
        page: Number(row.page) || 0,
        mode: row.mode === "paged" ? "paged" : "scroll",
        chapterId: row.chapter_id ?? "",
        scrollTop: Number(row.scroll_top) || 0,
        zoom: Number(row.zoom) || 100,
        updatedAt: row.updated_at
      };
    }
  }
  for (const row of annotationRows.filter((item) => item.kind === "reader_state")) {
    const current = state.progress[row.document_id] ?? {};
    if (isNewer(row.updated_at, current.updatedAt)) {
      state.progress[row.document_id] = {
        ...current,
        highlights: row.payload?.highlights ?? current.highlights ?? { pages: {}, scrollHtml: "" },
        bookmarks: Array.isArray(row.payload?.bookmarks) ? row.payload.bookmarks : current.bookmarks ?? [],
        updatedAt: row.updated_at
      };
    }
  }
}

function applyKnownTerms(state, rows) {
  if (rows.length === 0) return;
  const byTerm = new Map();
  for (const row of rows) {
    const existing = byTerm.get(row.term);
    if (!existing || isNewer(row.updated_at, existing.updated_at)) byTerm.set(row.term, row);
  }
  state.knownTerms = [];
  state.knownTermMeta ??= {};
  state.trash ??= { documents: [], knownTerms: [] };
  state.trash.knownTerms = [];
  for (const row of byTerm.values()) {
    if (row.deleted_at) {
      state.trash.knownTerms.push({ term: row.term, meta: row.meta ?? {}, deletedAt: row.deleted_at, reason: "sync" });
      delete state.knownTermMeta[row.term];
    } else {
      state.knownTerms.push(row.term);
      state.knownTermMeta[row.term] = row.meta ?? {};
    }
  }
}

function applyCards(state, rows) {
  const incoming = rows.map((row) => row.payload).filter(Boolean);
  state.cards = mergeByNewest(state.cards ?? [], incoming, (card) => card.id || String(card.ankiNoteId || card.expression), "updatedAt");
}

function applySettings(state, rows) {
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (byKey.anki) state.anki = { ...(state.anki ?? {}), ...byKey.anki };
  if (byKey.media) state.media = { ...(state.media ?? {}), ...byKey.media };
  if (byKey.dictionarySettings) state.dictionarySettings = { ...(state.dictionarySettings ?? {}), ...byKey.dictionarySettings };
  if (Array.isArray(byKey.templates)) state.templates = byKey.templates;
  if (Array.isArray(byKey.dictionariesMetadata)) {
    const metadataById = new Map(byKey.dictionariesMetadata.map((item) => [item.id, item]));
    state.dictionaries = (state.dictionaries ?? []).map((dictionary) => ({
      ...dictionary,
      ...(metadataById.get(dictionary.id) ?? {})
    }));
  }
}

async function upsertRows(client, table, rows, onConflict = "id") {
  const cleanRows = dedupeRowsByFields(rows.filter(Boolean), onConflict.split(",").map((field) => field.trim()));
  if (cleanRows.length === 0) return;
  for (const batch of chunk(cleanRows, 100)) {
    const { error } = await client.from(table).upsert(batch, { onConflict });
    if (error) throw syncError(`${table}: ${error.message}`);
  }
}

async function purgeRemoteDeletedDocuments(client, userId) {
  let data = [];
  const result = await client
    .from("documents")
    .select("id")
    .eq("user_id", userId)
    .not("deleted_at", "is", null);
  if (result.error) {
    if (!isMissingDeletedAtColumn(result.error)) throw syncError(`documents cleanup: ${result.error.message}`);
  } else {
    data = result.data ?? [];
  }

  const documentIds = [...new Set((data ?? []).map((row) => row.id).filter(Boolean))];
  if (documentIds.length === 0) {
    return { documents: 0, progress: 0, annotations: 0, cards: await purgeRemoteOrphanCards(client, userId) };
  }

  let progress = 0;
  let annotations = 0;
  let cards = 0;
  for (const ids of chunk(documentIds, 100)) {
    const progressResult = await client.from("reading_progress").delete().eq("user_id", userId).in("document_id", ids);
    if (progressResult.error) throw syncError(`reading_progress cleanup: ${progressResult.error.message}`);
    progress += progressResult.count ?? ids.length;

    const annotationResult = await client.from("reader_annotations").delete().eq("user_id", userId).in("document_id", ids);
    if (annotationResult.error) throw syncError(`reader_annotations cleanup: ${annotationResult.error.message}`);
    annotations += annotationResult.count ?? ids.length;

    const cardResult = await client.from("cards").delete().eq("user_id", userId).in("document_id", ids);
    if (cardResult.error) throw syncError(`cards cleanup: ${cardResult.error.message}`);
    cards += cardResult.count ?? ids.length;
  }

  const documentResult = await client.from("documents").delete().eq("user_id", userId).in("id", documentIds);
  if (documentResult.error) throw syncError(`documents cleanup: ${documentResult.error.message}`);

  cards += await purgeRemoteOrphanCards(client, userId);
  return { documents: documentResult.count ?? documentIds.length, progress, annotations, cards };
}

async function purgeRemoteOrphanCards(client, userId) {
  const [documents, cards] = await Promise.all([
    selectRows(client, "documents", userId),
    selectRows(client, "cards", userId)
  ]);
  const activeDocumentIds = new Set(documents.filter((document) => !document.deleted_at).map((document) => document.id).filter(Boolean));
  const orphanCardIds = cards
    .filter((card) => card.document_id && !activeDocumentIds.has(card.document_id))
    .map((card) => card.id)
    .filter(Boolean);
  if (orphanCardIds.length === 0) return 0;
  let deleted = 0;
  for (const ids of chunk([...new Set(orphanCardIds)], 100)) {
    const result = await client.from("cards").delete().eq("user_id", userId).in("id", ids);
    if (result.error) throw syncError(`orphan cards cleanup: ${result.error.message}`);
    deleted += result.count ?? ids.length;
  }
  return deleted;
}

function isMissingDeletedAtColumn(error = {}) {
  const message = String(error.message ?? "");
  return error.code === "42703" || /deleted_at.*does not exist|column.*deleted_at/i.test(message);
}

function dedupeRowsByFields(rows = [], fields = []) {
  const byKey = new Map();
  for (const row of rows) {
    const key = fields.map((field) => row?.[field] ?? "").join("\u0000");
    if (!key || fields.some((field) => row?.[field] === undefined || row?.[field] === null || row?.[field] === "")) continue;
    const existing = byKey.get(key);
    if (!existing || isNewer(row.updated_at ?? row.deleted_at ?? row.created_at, existing.updated_at ?? existing.deleted_at ?? existing.created_at)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

async function selectRows(client, table, userId) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await client.from(table).select("*").eq("user_id", userId).range(from, to);
    if (error) throw syncError(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

async function maybeUploadDocumentFiles(client, files = []) {
  const bucket = client.storage?.from?.(BOOK_BUCKET);
  if (!bucket) return;
  for (const file of files) {
    if (!file.bytes) continue;
    const { error } = await bucket.upload(file.storage_path, file.bytes, {
      upsert: false,
      contentType: file.content_type || "application/octet-stream"
    });
    if (error && !/exists|duplicate/i.test(error.message ?? "")) throw syncError(`book upload: ${error.message}`);
  }
}

async function restoreRemoteMediaFiles(client, files = [], mediaDir) {
  const bucket = client.storage?.from?.(BOOK_BUCKET);
  if (!bucket || !mediaDir) return 0;
  let restored = 0;
  for (const file of files) {
    const relativePath = mediaRelativePathFromRecord(file);
    if (!relativePath || !file.storage_path) continue;
    const targetPath = path.join(mediaDir, relativePath);
    if (existsSync(targetPath)) continue;
    const { data, error } = await bucket.download(file.storage_path);
    if (error) throw syncError(`book download: ${error.message}`);
    if (!data) continue;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, await blobToBuffer(data));
    restored += 1;
  }
  return restored;
}

async function blobToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value.arrayBuffer === "function") return Buffer.from(await value.arrayBuffer());
  return Buffer.from(String(value));
}

async function documentFileRecordsForDocument(userId, document, mediaDir) {
  const records = [];
  for (const publicPath of documentMediaPaths(document)) {
    const record = await documentFileRecord(userId, document, mediaDir, publicPath);
    if (record) records.push(record);
  }
  return records;
}

async function documentFileRecord(userId, document, mediaDir, publicPath) {
  const localPath = localMediaPath(mediaDir, publicPath);
  if (!localPath || !existsSync(localPath)) return null;
  const bytes = await fs.readFile(localPath);
  const fileHash = contentHash(bytes);
  const relativePath = mediaRelativePath(publicPath);
  const ext = path.extname(localPath) || path.extname(document.filename || "") || ".bin";
  return {
    user_id: userId,
    file_hash: fileHash,
    filename: relativePath || document.filename || path.basename(localPath),
    storage_path: `${userId}/media/${relativePath || `${fileHash}${ext}`}`,
    content_type: contentTypeForExt(ext),
    size_bytes: bytes.length,
    local_path: publicPath,
    bytes,
    created_at: new Date().toISOString()
  };
}

function localMediaPath(mediaDir, sourcePath = "") {
  if (!sourcePath || !sourcePath.startsWith("/media/")) return "";
  return path.join(mediaDir, sourcePath.replace(/^\/media\//, ""));
}

function mediaRelativePath(sourcePath = "") {
  if (!sourcePath || !sourcePath.startsWith("/media/")) return "";
  return sourcePath.replace(/^\/media\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function mediaRelativePathFromRecord(file = {}) {
  const filename = String(file.filename ?? "");
  if (filename && !path.isAbsolute(filename) && !filename.includes("..")) return filename.replace(/\\/g, "/");
  const storagePath = String(file.storage_path ?? "");
  const match = storagePath.match(/\/media\/(.+)$/);
  return match?.[1] ?? "";
}

function documentMediaPaths(document = {}) {
  const paths = new Set();
  if (document.sourcePath) paths.add(document.sourcePath);
  if (document.coverPath) paths.add(document.coverPath);
  for (const chapter of document.chapters ?? []) collectBlockMediaPaths(chapter.blocks ?? [], paths);
  return [...paths].filter((value) => typeof value === "string" && value.startsWith("/media/"));
}

function collectBlockMediaPaths(blocks = [], paths = new Set()) {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" && block.src) paths.add(block.src);
    if (Array.isArray(block.blocks)) collectBlockMediaPaths(block.blocks, paths);
  }
  return paths;
}

function sanitizeAnkiSettings(anki = {}) {
  const { retentionStats, ...settings } = anki ?? {};
  return settings;
}

function dictionaryMetadataForSync(dictionary = {}) {
  const { entries, frequencyEntries, termEntries, terms, index, frequencyIndex, ...metadata } = dictionary;
  return metadata;
}

function mergeByNewest(current = [], incoming = [], keyOrFn = "id", timeField = "updatedAt") {
  const keyFn = typeof keyOrFn === "function" ? keyOrFn : (item) => item?.[keyOrFn];
  const map = new Map();
  for (const item of current) if (keyFn(item)) map.set(keyFn(item), item);
  for (const item of incoming) {
    const key = keyFn(item);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || isNewer(item?.[timeField] ?? item?.createdAt, existing?.[timeField] ?? existing?.createdAt)) map.set(key, item);
  }
  return [...map.values()];
}

function isNewer(incoming = "", current = "") {
  if (!current) return true;
  return Date.parse(incoming || 0) >= Date.parse(current || 0);
}

function chunk(values = [], size = 100) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contentTypeForExt(ext = "") {
  const normalized = ext.toLowerCase();
  if (normalized === ".pdf") return "application/pdf";
  if (normalized === ".epub") return "application/epub+zip";
  if (normalized === ".txt") return "text/plain; charset=utf-8";
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".png") return "image/png";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function markVectorIndexStale(state) {
  state.ml ??= {};
  state.ml.indexStale = true;
  state.ml.indexStaleReason = "Synced source data changed. Rebuild the local index.";
}

async function importRemoteEvents(eventLog, rows = []) {
  if (typeof eventLog.appendImported !== "function") return;
  for (const row of rows) {
    await eventLog.appendImported({
      id: row.id,
      type: row.type,
      payload: row.payload ?? {},
      createdAt: row.created_at
    });
  }
}

function syncError(message) {
  const error = new Error(message || "Supabase sync failed.");
  error.status = 422;
  return error;
}

function defaultDeviceName() {
  return `${process.env.COMPUTERNAME || process.env.HOSTNAME || "Local device"}`;
}
