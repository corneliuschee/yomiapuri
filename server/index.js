import AdmZip from "adm-zip";
import express from "express";
import fs from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import pdfParse from "pdf-parse";
import kuromoji from "kuromoji";
import { createHash } from "node:crypto";
import { createAnkiService } from "./anki-service.js";
import { createAnkiLauncher, detectAnkiExecutablePath } from "./anki-launcher.js";
import { createAiService, defaultAiSettings, normalizeAiSettings } from "./ai-service.js";
import { createDictionaryService, repairDictionaryState } from "./dictionary-service.js";
import { createRuntimeEmbeddingProvider, defaultMlSettings, EMBEDDING_MODELS, normalizeMlSettings, publicMlSettings } from "./embedding-providers.js";
import { createJsonStateStore } from "./json-state-store.js";
import { createLearningEventLog } from "./learning-events.js";
import { createFtsSearchService } from "./fts-search-service.js";
import { createHashEmbeddingProvider, createMlService } from "./ml-service.js";
import { createLocalMediaProvider, defaultMediaSettings, normalizeMediaSettings } from "./media-providers.js";
import { createSqliteStateStore } from "./sqlite-state-store.js";
import { createSyncService, defaultSyncSettings, normalizeSyncSettings, publicSyncSettings } from "./sync-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
loadDotEnv(path.join(rootDir, ".env"));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const mediaDir = path.join(dataDir, "media");
const eventsPath = path.join(dataDir, "events.jsonl");
const vectorDir = path.join(dataDir, "vector-index");
const documentCacheDir = path.join(dataDir, "document-cache");
const dbPath = path.join(dataDir, "state.json");
const dbTmpPath = path.join(dataDir, "state.json.tmp");
const dictionaryDbPath = path.join(dataDir, "dictionaries.json");
const dictionaryDbTmpPath = path.join(dataDir, "dictionaries.json.tmp");
const sqliteDbPath = path.join(dataDir, "yomiapuri.sqlite");
const backupDir = path.join(dataDir, "backups");
const publicDir = path.join(rootDir, "public");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
const DOCUMENT_CACHE_VERSION = 1;
const TOKENIZER_VERSION = "kuromoji-ipadic-v1";
const NORMALIZER_VERSION = "dictionary-aware-v1";
const READER_LAYOUT_VERSION = 1;

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use("/media", express.static(mediaDir));
app.get("/vendor/pdfjs/", (req, res) => res.redirect("/"));
app.use("/vendor/pdfjs", express.static(path.join(rootDir, "node_modules", "pdf-parse", "lib", "pdf.js", "v1.10.100", "build")));
app.use(express.static(publicDir));

const detectedAnkiExecutablePath = detectAnkiExecutablePath();

function loadDotEnv(envPath) {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && (process.env[key] === undefined || process.env[key] === "")) process.env[key] = value;
  }
}

const initialState = {
  documents: [],
  knownTerms: [],
  knownTermMeta: {},
  trash: {
    documents: [],
    knownTerms: []
  },
  dictionaries: [],
  dictionarySettings: {
    prefixWildcardSearch: false
  },
  reader: {
    hideInferredReadableFurigana: false
  },
  media: defaultMediaSettings(),
  ai: defaultAiSettings(),
  sync: defaultSyncSettings(),
  ml: defaultMlSettings(),
  progress: {},
  cards: [],
  anki: {
    connectUrl: "http://127.0.0.1:8765",
    deckName: "",
    modelName: "",
    fieldMap: {
      Expression: "Expression",
      Reading: "Reading",
      Sentence: "Sentence",
      Meaning: "Meaning",
      Audio: "Audio",
      Image: "Image",
      Source: "Source"
    },
    modelFieldMaps: {},
    retentionStats: null,
    instantExport: false,
    autoLaunchAnki: true,
    ankiExecutablePath: detectedAnkiExecutablePath,
    ankiExecutablePathDetected: Boolean(detectedAnkiExecutablePath)
  },
  templates: [
    {
      id: "default-template",
      name: "Default Sentence Mining",
      fields: ["Expression", "Reading", "Sentence", "Meaning", "Audio", "Image", "Source"]
    }
  ]
};

let state = structuredClone(initialState);
let tokenizerPromise;
let saveStateQueue = Promise.resolve();
const documentResponseCache = new Map();
let learnedVariantCacheKey = "";
let learnedVariantCache = null;
let readabilityContextCacheKey = "";
let readabilityContextCacheExpires = 0;
let readabilityContextCache = null;
const normalizationDictionaryCache = new Map();
const readerTokenCache = new Map();
let normalizationDictionarySignatureCache = "";
const wordBankMeaningCache = new Map();
const sqliteStateStore = createSqliteStateStore({ dbPath: sqliteDbPath });

await ensureStorage();
await loadState();

const stateStore = createJsonStateStore({
  getState: () => state,
  setState: (nextState) => {
    state = nextState;
  },
  saveState
});
const mediaProvider = createLocalMediaProvider({
  getSettings: () => state.media,
  mediaDir,
  pythonPath: path.join(rootDir, ".venv-liquidai", "Scripts", "python.exe"),
  liquidAiScriptPath: path.join(rootDir, "scripts", "liquidai_tts_server.py"),
  hfHome: path.join(dataDir, "huggingface")
});
const aiService = createAiService({
  getSettings: () => state.ai,
  saveSettings: async (settings) => {
    state.ai = normalizeAiSettings(settings);
    await saveState();
  },
  runtimeCommand: String(process.env.LOCAL_TRANSLATION_COMMAND ?? "").trim()
});
const dictionaryService = createDictionaryService({
  store: stateStore,
  normalizeJapaneseTerm,
  repairMojibake,
  crypto
});
const eventLog = createLearningEventLog({ eventsPath });
const embeddingProvider = createRuntimeEmbeddingProvider({
  getState: () => state,
  rootDir,
  dataDir,
  hashProvider: createHashEmbeddingProvider()
});
const ftsSearchService = createFtsSearchService({
  dbPath: sqliteDbPath,
  getState: () => state,
  analyzeText,
  normalizeJapaneseTerm,
  hasJapaneseText,
  tokenizerVersion: TOKENIZER_VERSION,
  normalizerVersion: NORMALIZER_VERSION,
  dictionarySignature: dictionaryNormalizationSignature
});
const syncService = createSyncService({
  getState: () => state,
  saveState,
  mediaDir,
  eventLog,
  clearDocumentCache
});
const mlService = createMlService({
  getState: () => state,
  vectorDir,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch: ftsSearchService,
  embeddingProvider
});
const ankiLauncher = createAnkiLauncher();
const ankiService = createAnkiService({
  store: stateStore,
  mediaProvider,
  lookupDictionary,
  normalizeJapaneseTerm,
  extractTermsFromNotes,
  mergeKnownTerms,
  clearDocumentCache,
  crypto,
  ankiLauncher,
  renderSentenceHtml: renderAnkiSentenceHtml
});

function ensureStorage() {
  return Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(mediaDir, { recursive: true }),
    fs.mkdir(vectorDir, { recursive: true }),
    fs.mkdir(documentCacheDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true })
  ]);
}

async function loadState() {
  const sqliteState = sqliteStateStore.loadState();
  if (sqliteState) {
    state = { ...structuredClone(initialState), ...sqliteState };
    const repaired = await repairLoadedState();
    if (repaired) await saveState();
    return;
  }

  if (!existsSync(dbPath)) {
    await saveState();
    return;
  }

  const raw = await fs.readFile(dbPath, "utf8");
  const migratedDictionaries = !existsSync(dictionaryDbPath) && await migrateDictionariesFromRawState(raw);
  const loadedState = parseStateJson(raw);
  const externalDictionaries = await loadExternalDictionaries();
  state = { ...structuredClone(initialState), ...loadedState };
  if (externalDictionaries) state.dictionaries = externalDictionaries;
  else if (Array.isArray(loadedState.dictionaries) && loadedState.dictionaries.length > 0) {
    state.dictionaries = loadedState.dictionaries;
  }
  await backupJsonStateFiles();
  await repairLoadedState(Boolean(migratedDictionaries));
  await saveState();
}

async function repairLoadedState(initialRepaired = false) {
  let repaired = Boolean(initialRepaired);
  state.knownTermMeta ??= {};
  state.anki = {
    ...structuredClone(initialState.anki),
    ...(state.anki ?? {}),
    fieldMap: { ...initialState.anki.fieldMap, ...(state.anki?.fieldMap ?? {}) },
    modelFieldMaps: state.anki?.modelFieldMaps ?? {}
  };
  state.trash = {
    documents: [],
    knownTerms: [],
    ...(state.trash ?? {})
  };
  state.reader = {
    ...structuredClone(initialState.reader),
    ...(state.reader ?? {})
  };
  state.media = normalizeMediaSettings(state.media);
  state.ai = normalizeAiSettings(state.ai);
  state.sync = normalizeSyncSettings(state.sync);
  state.ml = normalizeMlSettings(state.ml);
  if (repairDictionaryState(state, { normalizeJapaneseTerm })) repaired = true;
  const legacyBaseTime = Date.parse("2020-01-01T00:00:00.000Z");
  for (const [index, term] of state.knownTerms.entries()) {
    const normalized = normalizeJapaneseTerm(term);
    if (!state.knownTermMeta[normalized]) {
      state.knownTermMeta[normalized] = { addedAt: new Date(legacyBaseTime + index).toISOString() };
      repaired = true;
    }
  }
  for (const document of state.documents) {
    const title = repairMojibake(document.title);
    const filename = repairMojibake(document.filename);
    if (title !== document.title) {
      document.title = title;
      repaired = true;
    }
    if (filename !== document.filename) {
      document.filename = filename;
      repaired = true;
    }
    if (document.type === "pdf" && !document.coverPath) {
      document.coverPath = await writePdfCover(document.id, document.title || title, document.filename || filename);
      repaired = true;
    }
    if (document.type === "pdf" && !document.sourcePath) {
      const pdfPath = `/media/pdf-files/${document.id}/original.pdf`;
      if (existsSync(path.join(mediaDir, "pdf-files", document.id, "original.pdf"))) {
        document.sourcePath = pdfPath;
        repaired = true;
      }
    }
  }
  for (const document of state.trash.documents) {
    const title = repairMojibake(document.title);
    const filename = repairMojibake(document.filename);
    if (title !== document.title) {
      document.title = title;
      repaired = true;
    }
    if (filename !== document.filename) {
      document.filename = filename;
      repaired = true;
    }
  }
  return repaired;
}

async function saveState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveState(state);
    });
  return saveStateQueue;
}

async function saveAnkiExportState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      if (typeof sqliteStateStore.saveAnkiExportState === "function") {
        sqliteStateStore.saveAnkiExportState(state);
      } else {
        sqliteStateStore.saveState(state);
      }
    });
  return saveStateQueue;
}

function mainStateSnapshot() {
  return {
    ...state,
    sync: normalizeSyncSettings(state.sync),
    dictionaries: state.dictionaries.map(dictionaryPublicStorageRecord)
  };
}

function dictionaryPublicStorageRecord(dictionary = {}) {
  const {
    termEntries,
    frequencyEntries,
    entries,
    terms,
    index,
    frequencyIndex,
    ...metadata
  } = dictionary;
  return metadata;
}

async function loadExternalDictionaries() {
  if (!existsSync(dictionaryDbPath)) return null;
  const raw = await fs.readFile(dictionaryDbPath, "utf8");
  const parsed = parseStateJson(raw);
  return Array.isArray(parsed) ? parsed : parsed.dictionaries ?? [];
}

async function migrateDictionariesFromRawState(raw = "") {
  const range = jsonPropertyValueRange(raw, "dictionaries");
  if (!range) return false;
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(dictionaryDbTmpPath, { encoding: "utf8" });
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.write("{\"dictionaries\":");
    writeRawRange(stream, raw, range.start, range.end)
      .then(() => stream.end("}"))
      .catch((error) => {
        stream.destroy(error);
        reject(error);
      });
  });
  await replaceStateFile(dictionaryDbTmpPath, dictionaryDbPath);
  return true;
}

async function writeRawRange(stream, raw, start, end) {
  const chunkSize = 1024 * 1024;
  for (let index = start; index < end; index += chunkSize) {
    await writeChunk(stream, raw.slice(index, Math.min(end, index + chunkSize)));
  }
}

function jsonPropertyValueRange(raw = "", property = "") {
  const propertyNeedle = JSON.stringify(property);
  const propertyIndex = raw.indexOf(propertyNeedle);
  if (propertyIndex === -1) return null;
  const colonIndex = raw.indexOf(":", propertyIndex + propertyNeedle.length);
  if (colonIndex === -1) return null;
  let start = colonIndex + 1;
  while (/\s/.test(raw[start] ?? "")) start += 1;
  const opener = raw[start];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : "";
  if (!closer) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

async function saveDictionariesState(dictionaries = state.dictionaries) {
  state.dictionaries = dictionaries;
  await saveState();
}

async function backupJsonStateFiles() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [
    [dbPath, path.join(backupDir, `state-before-sqlite-${timestamp}.json`)],
    [dictionaryDbPath, path.join(backupDir, `dictionaries-before-sqlite-${timestamp}.json`)]
  ];
  for (const [source, target] of backups) {
    if (!existsSync(source) || existsSync(target)) continue;
    await fs.copyFile(source, target);
  }
}

async function replaceStateFile(sourcePath, targetPath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 5) {
        await fs.copyFile(sourcePath, targetPath);
        await fs.rm(sourcePath, { force: true }).catch(() => {});
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

async function writeStateJson(filePath, value) {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  await new Promise(async (resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    try {
      await writeJsonValue(stream, value);
      stream.end();
    } catch (error) {
      stream.destroy(error);
      reject(error);
    }
  });
}

async function writeJsonValue(stream, value) {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    await writeChunk(stream, JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    await writeChunk(stream, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) await writeChunk(stream, ",");
      await writeJsonValue(stream, value[index] === undefined ? null : value[index]);
    }
    await writeChunk(stream, "]");
    return;
  }
  if (typeof value === "object") {
    await writeChunk(stream, "{");
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && typeof entryValue !== "function");
    for (let index = 0; index < entries.length; index += 1) {
      const [key, entryValue] = entries[index];
      if (index > 0) await writeChunk(stream, ",");
      await writeChunk(stream, `${JSON.stringify(key)}:`);
      await writeJsonValue(stream, entryValue);
    }
    await writeChunk(stream, "}");
    return;
  }
  await writeChunk(stream, "null");
}

function writeChunk(stream, chunk) {
  return new Promise((resolve) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    stream.once("drain", resolve);
  });
}

function parseStateJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const repaired = firstJsonObject(raw);
    if (!repaired) throw error;
    return JSON.parse(repaired);
  }
}

function firstJsonObject(raw) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(0, index + 1);
    }
  }
  return "";
}

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(rootDir, "node_modules", "kuromoji", "dict") }).build((error, tokenizer) => {
        if (error) reject(error);
        else resolve(tokenizer);
      });
    });
  }
  return tokenizerPromise;
}

function hasKanji(value = "") {
  return /[\u3400-\u9fff]/u.test(value);
}

function hasJapaneseText(value = "") {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

function katakanaToHiragana(value = "") {
  return value.replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

function normalizeJapaneseTerm(value = "") {
  return value.normalize("NFKC").trim();
}

function htmlToText(value = "") {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<ruby[\s\S]*?<\/ruby>/gi, (match) => match.replace(/<rt[\s\S]*?<\/rt>/gi, ""))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageHtmlToCandidateText(value = "") {
  return htmlToText(String(value)
    .replace(/<div\b[^>]*class=["'][^"']*\breader-page-title\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<header\b[^>]*class=["'][^"']*\breader-chapter-heading\b[^"']*["'][^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, ""));
}

function decodeHtmlEntities(value = "") {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeUploadName(value = "") {
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  const originalLooksBroken = /Ã|Â|ã|ï¿½|\uFFFD/.test(value);
  const decodedLooksJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(decoded);
  return originalLooksBroken || decodedLooksJapanese ? decoded : value;
}

function repairMojibake(value = "") {
  if (!value) return "";
  const latin1Decoded = Buffer.from(value, "latin1").toString("utf8");
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(latin1Decoded) && /Ã|Â|ã|ï|ð|�|\uFFFD/.test(value)) return latin1Decoded;
  return value.replace(/\uFFFD/g, "").trim();
}

function safeAssetName(value = "") {
  return path.basename(value).replace(/[^\w.-]+/g, "_") || `${crypto.randomUUID()}.bin`;
}

function documentCacheKey(document) {
  return [
    document.id,
    document.updatedAt ?? document.createdAt ?? "",
    dictionaryNormalizationSignature(),
    state.reader?.hideInferredReadableFurigana ? "hide-inferred" : "show-inferred",
    state.knownTerms.length,
    state.knownTerms.join("\u0001"),
    state.dictionaries.length
  ].join("\u0002");
}

function clearDocumentCache() {
  documentResponseCache.clear();
}

function invalidateReadabilityContext() {
  readabilityContextCacheKey = "";
  readabilityContextCacheExpires = 0;
  readabilityContextCache = null;
}

function invalidateWordBankMeaningCache(dictionaryId = "") {
  if (dictionaryId) wordBankMeaningCache.delete(dictionaryId);
  else wordBankMeaningCache.clear();
}

function markMlIndexStale(reason = "Source data changed. Rebuild the local index.") {
  state.ml ??= {};
  state.ml.indexStale = true;
  state.ml.indexStaleReason = reason;
  try {
    ftsSearchService?.markStale?.(reason);
  } catch {
    // FTS is a derived cache; stale marking should never block app writes.
  }
}

function markMlIndexFresh() {
  state.ml ??= {};
  state.ml.indexStale = false;
  state.ml.indexStaleReason = "";
}

async function deleteDocumentVectorsFromMlIndex(documentId = "") {
  try {
    const result = await mlService.deleteDocumentVectors(documentId);
    if (result.deleted > 0) {
      markMlIndexStale("Book vectors were removed. Rebuild the local semantic index after restoring books.");
    }
    return result;
  } catch (error) {
    markMlIndexStale(`Book vector cleanup failed: ${error.message}`);
    return { deleted: 0, error: error.message };
  }
}

function documentCachePath(documentId = "") {
  return path.join(documentCacheDir, safeAssetName(documentId || "unknown"));
}

function documentCacheManifestPath(documentId = "") {
  return path.join(documentCachePath(documentId), "manifest.json");
}

function documentTokenCacheDir(documentId = "") {
  return path.join(documentCachePath(documentId), "tokens");
}

function documentSourceSignature(document = {}) {
  return createHash("sha256")
    .update(document.id ?? "")
    .update("\u0000")
    .update(document.updatedAt ?? document.createdAt ?? "")
    .update("\u0000")
    .update(document.title ?? "")
    .update("\u0000")
    .update(document.author ?? "")
    .update("\u0000")
    .update(document.text ?? "")
    .update("\u0000")
    .update(JSON.stringify((document.chapters ?? []).map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      href: chapter.href,
      blocks: chapter.blocks
    }))))
    .digest("hex");
}

function currentDocumentCacheManifest(document = {}) {
  return {
    documentId: document.id,
    cacheVersion: DOCUMENT_CACHE_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    layoutVersion: READER_LAYOUT_VERSION,
    sourceHash: documentSourceSignature(document),
    dictionarySignature: dictionaryNormalizationSignature()
  };
}

async function readDocumentCacheManifest(documentId = "") {
  try {
    const raw = await fs.readFile(documentCacheManifestPath(documentId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function documentCacheState(document = {}, manifest = null) {
  const current = currentDocumentCacheManifest(document);
  if (!manifest) return { state: "full-stale", current, reason: "No local ingestion cache." };
  const fullStale = manifest.cacheVersion !== current.cacheVersion ||
    manifest.tokenizerVersion !== current.tokenizerVersion ||
    manifest.normalizerVersion !== current.normalizerVersion ||
    manifest.layoutVersion !== current.layoutVersion ||
    manifest.sourceHash !== current.sourceHash;
  if (fullStale) return { state: "full-stale", current, reason: "Book source, tokenizer, normalizer, or layout version changed." };
  if (manifest.dictionarySignature !== current.dictionarySignature) {
    return { state: "dictionary-stale", current, reason: "Dictionary normalization changed." };
  }
  return { state: "valid", current, reason: "" };
}

async function writeDocumentCacheManifest(document = {}, currentManifest) {
  const cachePath = documentCachePath(document.id);
  await fs.mkdir(cachePath, { recursive: true });
  await fs.writeFile(documentCacheManifestPath(document.id), JSON.stringify({
    ...currentManifest,
    builtAt: new Date().toISOString()
  }, null, 2), "utf8");
}

async function clearDocumentIngestionCache(documentId = "") {
  await fs.rm(documentCachePath(documentId), { recursive: true, force: true });
}

function tokenCachePathForKey(cacheDir = "", key = "") {
  return path.join(cacheDir, `${key}.json`);
}

async function readPersistentReaderTokens(cacheDir = "", key = "") {
  if (!cacheDir || !key) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(tokenCachePathForKey(cacheDir, key), "utf8"));
    return Array.isArray(parsed.tokens) ? parsed.tokens : null;
  } catch {
    return null;
  }
}

async function writePersistentReaderTokens(cacheDir = "", key = "", tokens = []) {
  if (!cacheDir || !key || !Array.isArray(tokens)) return;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(tokenCachePathForKey(cacheDir, key), JSON.stringify({
    key,
    tokenizerVersion: TOKENIZER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    dictionarySignature: dictionaryNormalizationSignature(),
    tokens
  }), "utf8");
}

function documentTextCacheBlocks(document = {}) {
  const blocks = [];
  const chapters = fallbackChapters(document);
  for (const chapter of chapters) {
    for (const block of flattenTextBlocks(chapter.blocks ?? [])) {
      const text = String(block.text ?? "").trim();
      if (text && hasJapaneseText(text)) blocks.push(text);
    }
  }
  return blocks;
}

function flattenTextBlocks(blocks = []) {
  const values = [];
  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === "string") {
      values.push({ type: "text", text: block });
      continue;
    }
    if (block.type === "text" || block.type === "link") values.push(block);
    if (block.type === "page") values.push(...flattenTextBlocks(block.blocks ?? []));
  }
  return values;
}

async function ensureDocumentIngestionCache(document = {}, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const manifest = await readDocumentCacheManifest(document.id);
  const cacheState = documentCacheState(document, manifest);
  const cacheDir = documentTokenCacheDir(document.id);
  const shouldBuild = cacheState.state !== "valid" || options.force === true;
  if (!shouldBuild) return { ...cacheState, rebuilt: false, cacheDir };
  if (cacheState.state === "dictionary-stale" && options.force !== true && options.rebuildDictionaryStale !== true) {
    markMlIndexStale("Dictionary normalization changed. Rebuild the local semantic index when convenient.");
    await saveState();
    return { ...cacheState, rebuilt: false, deferred: true, cacheDir };
  }

  onProgress({
    phase: cacheState.state,
    label: cacheState.state === "dictionary-stale" ? "Refreshing dictionary-aware tokens..." : "Building local book cache...",
    current: 0,
    total: 1
  });

  if (cacheState.state === "full-stale" || options.force === true) await clearDocumentIngestionCache(document.id);
  else await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const blocks = documentTextCacheBlocks(document);
  const total = Math.max(1, blocks.length);
  for (const [index, text] of blocks.entries()) {
    onProgress({
      phase: cacheState.state,
      label: `Re-indexing text tokens: ${index + 1}/${total}`,
      current: index + 1,
      total
    });
    await analyzeReaderTokenStream(text, {
      cacheDir,
      authorRubyProtectedTerms: authorRubyProtectedTermsFromText(text)
    });
  }

  await writeDocumentCacheManifest(document, cacheState.current);
  if (cacheState.state === "dictionary-stale") {
    markMlIndexStale("Dictionary normalization changed. Rebuild the local semantic index when convenient.");
    await saveState();
  } else if (cacheState.state === "full-stale" || options.force === true) {
    markMlIndexStale("Document ingestion cache changed. Rebuild the local semantic index.");
    await saveState();
  }
  return { ...cacheState, rebuilt: true, cacheDir };
}

function renderImageFigure(src = "", alt = "") {
  return `<figure class="book-image book-image-page"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"></figure>`;
}

function renderPdfPageFigure(block) {
  if (!block.pdfSrc) return "";
  const pageNumber = Number(block.pageNumber) || 1;
  const extractedText = escapeHtml(blocksToText(block.blocks ?? []));
  return `<section class="pdf-page-block pdf-page-render" data-pdf-src="${escapeHtml(block.pdfSrc)}" data-pdf-page="${escapeHtml(String(pageNumber))}">
    <div class="pdf-canvas-wrap">
      <canvas class="pdf-canvas" aria-label="PDF page ${escapeHtml(String(pageNumber))}"></canvas>
      <div class="pdf-text-layer" aria-hidden="true"></div>
      <div class="pdf-link-layer" aria-hidden="false"></div>
    </div>
    <div class="pdf-extracted-text">${extractedText}</div>
  </section>`;
}

function imageOrderValue(value = "") {
  const coverBias = /cover/i.test(value) ? -100000 : 0;
  const number = Number(value.match(/(?:image|cover)0*(\d+)/i)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return coverBias + number;
}

async function frontImagePaths(document) {
  if (document.type === "pdf" && document.sourcePath) return [];

  const referenced = new Set();
  for (const chapter of document.chapters ?? []) {
    for (const block of chapter.blocks ?? []) {
      if (block.type === "image" && block.src) referenced.add(block.src);
    }
  }

  const paths = [];
  if (document.coverPath && !referenced.has(document.coverPath)) paths.push(document.coverPath);

  const assetDir = path.join(mediaDir, "epub-assets", document.id);
  if (!existsSync(assetDir)) return paths;

  const filenames = await fs.readdir(assetDir);
  const missingImages = filenames
    .filter((filename) => /\.(avif|gif|jpe?g|png|webp)$/i.test(filename))
    .map((filename) => `/media/epub-assets/${document.id}/${filename}`)
    .filter((publicPath) => publicPath !== document.coverPath && !referenced.has(publicPath))
    .sort((a, b) => imageOrderValue(a) - imageOrderValue(b) || a.localeCompare(b));

  return [...paths, ...missingImages];
}

function getXmlAttr(value, attrName) {
  return value.match(new RegExp(`${attrName}=["']([^"']+)["']`, "i"))?.[1] ?? "";
}

function getXmlText(value, tagName) {
  return decodeHtmlEntities(value.match(new RegExp(`<[^>]*${tagName}[^>]*>([\\s\\S]*?)<\\/[^>]*${tagName}>`, "i"))?.[1]?.replace(/<[^>]+>/g, "")?.trim() ?? "");
}

function resolveZipPath(basePath, relativePath) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePath), relativePath)).replace(/^\/+/, "");
}

function stripFragment(value = "") {
  return value.split("#")[0];
}

function normalizeHrefForCompare(value = "") {
  return path.posix.normalize(stripFragment(value)).replace(/^\/+/, "");
}

function inferImageMime(filename = "") {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

function parseNavPoints(xml = "", opfPath = "") {
  const navPoints = [];
  for (const match of xml.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/gi)) {
    const item = match[0];
    const label = getXmlText(item, "text") || getXmlText(item, "navLabel");
    const contentTag = item.match(/<content\b[^>]*>/i)?.[0] ?? "";
    const src = getXmlAttr(contentTag, "src");
    if (!src) continue;
    navPoints.push({
      title: repairMojibake(label || "Chapter"),
      href: resolveZipPath(opfPath, stripFragment(src))
    });
  }
  return navPoints;
}

function parseNavDocument(html = "", navPath = "") {
  const navMatch = html.match(/<nav\b[^>]*(?:epub:type|type)=["'][^"']*(toc|contents)[^"']*["'][^>]*>[\s\S]*?<\/nav>/i);
  const nav = navMatch?.[0] ?? "";
  if (!nav) return [];
  const items = [];
  for (const match of nav.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1];
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    if (!href) continue;
    items.push({
      title: repairMojibake(title || "Chapter"),
      href: resolveZipPath(navPath, stripFragment(href))
    });
  }
  return items;
}

function nearestTocTitle(tocItems = [], entryName = "", fallback = "") {
  const normalizedEntry = normalizeHrefForCompare(entryName);
  const exact = tocItems.find((item) => normalizeHrefForCompare(item.href) === normalizedEntry);
  if (exact?.title) return exact.title;
  return fallback;
}

function splitSentences(value = "") {
  const sentences = [];
  let sentence = "";
  let quoteDepth = 0;

  for (const char of value) {
    sentence += char;
    if (char === "\u300c") quoteDepth += 1;
    if (char === "\u300d") quoteDepth = Math.max(0, quoteDepth - 1);
    if (quoteDepth === 0 && /[\u3002\uff01\uff1f!?]/u.test(char)) {
      sentences.push(sentence.trim());
      sentence = "";
    }
  }

  if (sentence.trim()) sentences.push(sentence.trim());
  return sentences.filter(Boolean);
}

function normalizeTitleForCompare(value = "") {
  return normalizeJapaneseTerm(value)
    .replace(/\s+/g, "")
    .replace(/[‐-‒–—―ー－]/gu, "")
    .replace(/[「」『』【】（）()［\]\[\]・.,，、。!！?？]/gu, "");
}

function stripChapterTitlePrefix(text = "", title = "") {
  if (!text.trim() || !title.trim()) return text;
  const compactText = normalizeTitleForCompare(text);
  const compactTitle = normalizeTitleForCompare(title);
  const titleWithoutAscii = compactTitle.replace(/[a-z0-9]+/giu, "");
  const matchesTitle = compactText.startsWith(compactTitle) || (titleWithoutAscii.length >= 6 && compactText.startsWith(titleWithoutAscii));
  if (!matchesTitle) return text;

  let consumed = 0;
  let normalized = "";
  const target = compactText.startsWith(compactTitle) ? compactTitle : titleWithoutAscii;
  for (const char of text) {
    consumed += char.length;
    normalized = normalizeTitleForCompare(text.slice(0, consumed));
    if (normalized.length >= target.length) break;
  }
  let stripped = text.slice(consumed).replace(/^[\s:：,，、。‐-‒–—―ー－]+/u, "").trim();
  if (target === titleWithoutAscii) stripped = stripped.replace(/^[a-z0-9 .'’]+[‐-‒–—―ー－]+/iu, "").trim();
  return stripped;
}

function stripChapterTitleFromBlocks(blocks = [], title = "") {
  if (!title) return blocks;
  const compactTitle = normalizeTitleForCompare(title);
  const titleWithoutAscii = compactTitle.replace(/[a-z0-9]+/giu, "");
  let stripped = false;
  let pending = [];
  const output = [];

  const flushPending = () => {
    output.push(...pending);
    pending = [];
  };

  for (const block of blocks) {
    if (stripped || block.type !== "text" || !block.text?.trim()) {
      flushPending();
      output.push(block);
      continue;
    }

    pending.push(block);
    const pendingText = pending.map((item) => item.text ?? "").join("");
    const compactPending = normalizeTitleForCompare(pendingText);
    const couldBeTitle = compactTitle.startsWith(compactPending) || (titleWithoutAscii.length >= 6 && titleWithoutAscii.startsWith(compactPending));
    const titleMatched = compactPending.startsWith(compactTitle) || (titleWithoutAscii.length >= 6 && compactPending.startsWith(titleWithoutAscii));

    if (titleMatched) {
      const strippedText = stripChapterTitlePrefix(pendingText, title);
      if (strippedText) output.push({ type: "text", text: strippedText });
      pending = [];
      stripped = true;
      continue;
    }

    if (!couldBeTitle) flushPending();
  }

  flushPending();
  return output.filter((block) => block.type !== "text" || block.text?.trim());
}

function chapterHeadingHtml(title = "") {
  const cleaned = repairMojibake(title).trim();
  if (!cleaned) return "";
  const match = cleaned.match(/^(.+?)([‐-‒–—―ー－]\s*[^‐-‒–—―ー－]+[‐-‒–—―ー－]?)$/u);
  const main = match ? match[1].trim() : cleaned;
  const sub = match ? match[2].trim() : "";
  return `<header class="reader-chapter-heading"><h2>${escapeHtml(main)}</h2>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</header>`;
}

function pageChapterTitleHtml(title = "") {
  const cleaned = repairMojibake(title).trim();
  return cleaned ? `<div class="reader-page-title">${escapeHtml(cleaned)}</div>` : "";
}

function wrapReaderPage(pageHtml = "", chapterTitle = "", includeHeading = false) {
  if (/\breader-page-frame\b/.test(pageHtml)) return pageHtml;
  const imageOnly = isImageOnlyPageHtml(pageHtml);
  const body = `${includeHeading && !imageOnly ? chapterHeadingHtml(chapterTitle) : ""}${pageHtml}`;
  return `<section class="reader-page-frame${imageOnly ? " image-only" : ""}">${pageChapterTitleHtml(chapterTitle)}<div class="reader-page-content">${body}</div></section>`;
}

function isImageOnlyPageHtml(pageHtml = "") {
  return /^\s*<figure\b[^>]*class="[^"]*\bbook-image\b[^"]*"[\s\S]*<\/figure>\s*$/i.test(pageHtml);
}

function rubyToMarker(match = "") {
  const reading = decodeHtmlEntities([...match.matchAll(/<rt\b[^>]*>([\s\S]*?)<\/rt>/gi)]
    .map((item) => item[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .join(""));
  const surface = decodeHtmlEntities(match
    .replace(/<rt[\s\S]*?<\/rt>/gi, "")
    .replace(/<rp[\s\S]*?<\/rp>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim());
  if (!surface || !reading) return surface;
  return `[[RUBY:${encodeURIComponent(surface)}|${encodeURIComponent(reading)}]]`;
}

function authorRubyHtml(surface = "", reading = "") {
  return `<ruby class="author-ruby" data-author-ruby="true" data-base="${escapeHtml(surface)}" data-reading="${escapeHtml(reading)}">${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
}

function blocksToText(blocks = []) {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "link") return block.text;
      if (block.type === "page") return blocksToText(block.blocks ?? []);
      return [];
    })
    .join("\n");
}

function parseChapterBlocks(html, entryPath, imageMap) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const withMarkers = body
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<ruby[\s\S]*?<\/ruby>/gi, rubyToMarker)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = decodeHtmlEntities(label.replace(/<[^>]+>/g, "").trim());
      if (!href || !text) return text;
      const resolvedHref = /^https?:\/\//i.test(href) ? href : resolveZipPath(entryPath, href);
      return ` [[LINK:${resolvedHref}|${text}]] `;
    })
    .replace(/<(img|image)\b[^>]*(?:>|\/>)/gi, (tag) => {
      const src = getXmlAttr(tag, "src") || getXmlAttr(tag, "href") || getXmlAttr(tag, "xlink:href");
      const alt = getXmlAttr(tag, "alt");
      if (!src) return "\n";
      const resolved = resolveZipPath(entryPath, src.split("#")[0]);
      return `\n[[IMG:${imageMap.get(resolved) ?? ""}|${alt}]]\n`;
    })
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|section|article|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const blocks = [];
  const pushTextBlocks = (value) => {
    for (const sentence of splitSentences(value.trim())) blocks.push({ type: "text", text: sentence });
  };

  for (const line of decodeHtmlEntities(withMarkers).split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const image = trimmed.match(/^\[\[IMG:([^|]*)\|(.*)\]\]$/);
    if (image) {
      if (image[1]) blocks.push({ type: "image", src: image[1], alt: image[2] });
      continue;
    }
    let lastIndex = 0;
    let hasLink = false;
    for (const match of trimmed.matchAll(/\[\[LINK:([^|]*)\|(.*?)\]\]/g)) {
      hasLink = true;
      pushTextBlocks(trimmed.slice(lastIndex, match.index));
      blocks.push({ type: "link", href: match[1], text: match[2] });
      lastIndex = match.index + match[0].length;
    }
    if (hasLink) pushTextBlocks(trimmed.slice(lastIndex));
    else pushTextBlocks(trimmed);
  }
  return blocks;
}

function extractEpubText(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const byName = new Map(entries.map((entry) => [entry.entryName.replace(/\\/g, "/"), entry]));
  const container = byName.get("META-INF/container.xml")?.getData().toString("utf8");
  const opfPath = container ? getXmlAttr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? "", "full-path") : "";
  const opf = opfPath ? byName.get(opfPath)?.getData().toString("utf8") : "";

  if (opf) {
    const manifest = new Map();
    for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
      const item = match[0];
      const id = getXmlAttr(item, "id");
      const href = getXmlAttr(item, "href");
      const mediaType = getXmlAttr(item, "media-type");
      if (id && href && /xhtml|html/i.test(mediaType)) manifest.set(id, resolveZipPath(opfPath, href));
    }

    const spinePaths = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
      .map((match) => manifest.get(getXmlAttr(match[0], "idref")))
      .filter(Boolean);

    if (spinePaths.length > 0) {
      return spinePaths
        .map((entryName) => byName.get(entryName))
        .filter(Boolean)
        .map((entry) => htmlToText(entry.getData().toString("utf8")))
        .filter(Boolean)
        .join("\n\n");
    }
  }

  return entries
    .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName))
    .map((entry) => htmlToText(entry.getData().toString("utf8")))
    .filter(Boolean)
    .join("\n\n");
}

async function extractEpubDocument(file, documentId) {
  const zip = new AdmZip(file.buffer);
  const entries = zip.getEntries();
  const byName = new Map(entries.map((entry) => [entry.entryName.replace(/\\/g, "/"), entry]));
  const container = byName.get("META-INF/container.xml")?.getData().toString("utf8");
  const opfPath = container ? getXmlAttr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? "", "full-path") : "";
  const opf = opfPath ? byName.get(opfPath)?.getData().toString("utf8") : "";
  const assetDir = path.join(mediaDir, "epub-assets", documentId);
  await fs.mkdir(assetDir, { recursive: true });

  const manifest = new Map();
  const imageMap = new Map();
  const imageManifest = new Map();
  let spinePaths = [];
  let title = "";
  let author = "";
  let coverPath = "";
  let tocItems = [];

  if (opf) {
    title = repairMojibake(getXmlText(opf, "dc:title") || getXmlText(opf, "title"));
    author = repairMojibake(getXmlText(opf, "dc:creator") || getXmlText(opf, "creator"));
    const coverId = getXmlAttr(opf.match(/<meta\b[^>]*name=["']cover["'][^>]*>/i)?.[0] ?? "", "content");
    for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
      const item = match[0];
      const id = getXmlAttr(item, "id");
      const href = getXmlAttr(item, "href");
      const mediaType = getXmlAttr(item, "media-type");
      const properties = getXmlAttr(item, "properties");
      const fullPath = href ? resolveZipPath(opfPath, href) : "";
      if (id && fullPath) manifest.set(id, { path: fullPath, mediaType, properties });
      if (fullPath && /^image\//i.test(mediaType)) {
        const entry = byName.get(fullPath);
        if (!entry) continue;
        const filename = `${crypto.randomUUID()}-${safeAssetName(fullPath)}`;
        await fs.writeFile(path.join(assetDir, filename), entry.getData());
        const publicPath = `/media/epub-assets/${documentId}/${filename}`;
        imageMap.set(fullPath, publicPath);
        if (id) imageManifest.set(id, { path: fullPath, publicPath });
      }
    }

    if (coverId && imageManifest.has(coverId)) {
      coverPath = imageManifest.get(coverId).publicPath;
    } else {
      const coverItem = [...manifest.entries()].find(([id, item]) => /cover/i.test(id) && /^image\//i.test(item.mediaType));
      if (coverItem && imageMap.has(coverItem[1].path)) coverPath = imageMap.get(coverItem[1].path);
    }

    spinePaths = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
      .map((match) => manifest.get(getXmlAttr(match[0], "idref"))?.path)
      .filter(Boolean);

    const manifestHtmlPaths = [...manifest.values()]
      .filter((item) => /xhtml|html/i.test(item.mediaType ?? ""))
      .filter((item) => !/\bnav\b/i.test(item.properties ?? ""))
      .map((item) => item.path)
      .filter(Boolean);
    if (spinePaths.length > 0 && manifestHtmlPaths.length > 0) {
      const firstSpine = spinePaths[0];
      const spineSet = new Set(spinePaths.map(normalizeHrefForCompare));
      const frontMatterPaths = manifestHtmlPaths
        .filter((itemPath) => !spineSet.has(normalizeHrefForCompare(itemPath)))
        .filter((itemPath) => itemPath.localeCompare(firstSpine, undefined, { numeric: true, sensitivity: "base" }) < 0)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      spinePaths = [...frontMatterPaths, ...spinePaths];
    }

    const navItem = [...manifest.values()].find((item) => /\bnav\b/i.test(item.properties ?? "")) ||
      [...manifest.values()].find((item) => /xhtml|html/i.test(item.mediaType ?? "") && /nav|toc/i.test(path.basename(item.path)));
    if (navItem && byName.has(navItem.path)) {
      tocItems = parseNavDocument(byName.get(navItem.path).getData().toString("utf8"), navItem.path);
    }

    if (tocItems.length === 0) {
      const tocId = getXmlAttr(opf.match(/<spine\b[^>]*>/i)?.[0] ?? "", "toc") || "ncx";
      const ncxPath = manifest.get(tocId)?.path || [...manifest.values()].find((item) => /ncx/i.test(item.mediaType ?? "") || /\.ncx$/i.test(item.path))?.path;
      if (ncxPath && byName.has(ncxPath)) tocItems = parseNavPoints(byName.get(ncxPath).getData().toString("utf8"), ncxPath);
    }
  }

  if (spinePaths.length === 0) {
    spinePaths = entries
      .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.entryName))
      .map((entry) => entry.entryName.replace(/\\/g, "/"))
      .sort((a, b) => a.localeCompare(b));
  }

  const spineChapters = spinePaths
    .map((entryName, index) => {
      const entry = byName.get(entryName);
      if (!entry) return null;
      const html = entry.getData().toString("utf8");
      const heading = nearestTocTitle(tocItems, entryName, getXmlText(html, "h1") || getXmlText(html, "h2") || getXmlText(html, "title"));
      const blocks = parseChapterBlocks(html, entryName, imageMap);
      return {
        id: `chapter-${index + 1}`,
        title: heading || `Chapter ${index + 1}`,
        href: entryName,
        blocks
      };
    })
    .filter((chapter) => chapter && chapter.blocks.length > 0);

  let chapters = spineChapters;
  if (tocItems.length > 0) {
    const tocChapterStarts = tocItems
      .map((item) => {
        const index = spineChapters.findIndex((chapter) => normalizeHrefForCompare(chapter.href) === normalizeHrefForCompare(item.href));
        return index >= 0 ? { ...item, index } : null;
      })
      .filter(Boolean)
      .filter((item, index, list) => index === list.findIndex((candidate) => candidate.index === item.index));

    if (tocChapterStarts.length > 0) {
      chapters = tocChapterStarts.map((item, index) => {
        const next = tocChapterStarts[index + 1]?.index ?? spineChapters.length;
        const start = index === 0 ? 0 : item.index;
        const grouped = spineChapters.slice(start, next);
        return {
          id: `chapter-${index + 1}`,
          title: item.title || grouped[0]?.title || `Chapter ${index + 1}`,
          href: item.href,
          blocks: grouped.flatMap((chapter) => chapter.blocks)
        };
      });
    }
  }

  return {
    title,
    author,
    coverPath,
    text: chapters.map((chapter) => blocksToText(chapter.blocks)).filter(Boolean).join("\n\n"),
    chapters
  };
}

function normalizePdfLine(value = "") {
  return repairMojibake(value)
    .normalize("NFKC")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function pdfTextContentToLines(textContent) {
  const rows = new Map();
  for (const item of textContent.items ?? []) {
    const text = normalizePdfLine(item.str ?? "");
    if (!text) continue;
    const y = Math.round(item.transform?.[5] ?? 0);
    const x = Number(item.transform?.[4] ?? 0);
    const row = rows.get(y) ?? [];
    row.push({ x, text });
    rows.set(y, row);
  }

  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join("")
        .trim()
    )
    .filter(Boolean);
}

function pageTextToBlocks(text = "", pageNumber = 1) {
  const blocks = [];
  const lines = text.split(/\n+/).map(normalizePdfLine).filter(Boolean);
  for (const line of lines) {
    const sentences = splitSentences(line);
    for (const sentence of sentences.length > 0 ? sentences : [line]) {
      if (sentence.trim()) blocks.push({ type: "text", text: sentence.trim() });
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: `Page ${pageNumber}: no extractable text found.` });
  }
  return blocks;
}

function inferPdfChapterTitle(text = "", pageNumber = 1) {
  const lines = text.split(/\n+/).map(normalizePdfLine).filter(Boolean).slice(0, 12);
  const chapterPattern = /^(?:第\s*[\d一二三四五六七八九十百千万〇零壱弐参０-９]+\s*[章話節部]|(?:chapter|part|section)\s+[\divxlcdm]+|[\d０-９]+\s*[.．、]\s*\S+)/iu;
  const titleLikePattern = /^[^\s].{1,48}$/u;

  for (const line of lines) {
    if (chapterPattern.test(line)) return line;
  }

  const first = lines[0] ?? "";
  if (pageNumber === 1 && titleLikePattern.test(first)) return first;
  return "";
}

function pdfCoverSvg(title = "PDF", filename = "") {
  const label = escapeHtml(title || "PDF");
  const subLabel = escapeHtml(filename || "Imported PDF");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1040" viewBox="0 0 720 1040">
  <rect width="720" height="1040" fill="#171717"/>
  <rect x="46" y="46" width="628" height="948" rx="18" fill="#202020" stroke="#f97316" stroke-width="8"/>
  <text x="90" y="180" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="700" fill="#f97316">PDF</text>
  <foreignObject x="90" y="270" width="540" height="350">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:'Yu Gothic','Meiryo',Arial,sans-serif;font-size:54px;font-weight:700;line-height:1.16;color:#f5f5f5;word-break:break-word;">${label}</div>
  </foreignObject>
  <foreignObject x="90" y="780" width="540" height="130">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Segoe UI,Arial,sans-serif;font-size:26px;line-height:1.3;color:#a3a3a3;word-break:break-word;">${subLabel}</div>
  </foreignObject>
</svg>`;
}

async function writePdfCover(documentId, title, filename) {
  const assetDir = path.join(mediaDir, "pdf-assets", documentId);
  await fs.mkdir(assetDir, { recursive: true });
  const coverName = "cover.svg";
  await fs.writeFile(path.join(assetDir, coverName), pdfCoverSvg(title, filename), "utf8");
  return `/media/pdf-assets/${documentId}/${coverName}`;
}

async function writePdfSource(documentId, buffer) {
  const assetDir = path.join(mediaDir, "pdf-files", documentId);
  await fs.mkdir(assetDir, { recursive: true });
  const filename = "original.pdf";
  await fs.writeFile(path.join(assetDir, filename), buffer);
  return `/media/pdf-files/${documentId}/${filename}`;
}

async function writeOriginalBookSource(documentId, filename, buffer) {
  const ext = path.extname(filename || "") || ".txt";
  const sourceDir = path.join(mediaDir, "book-files", documentId);
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceName = `original${ext.toLowerCase()}`;
  await fs.writeFile(path.join(sourceDir, sourceName), buffer);
  return `/media/book-files/${documentId}/${sourceName}`;
}

async function extractPdfDocument(file, documentId) {
  const filename = repairMojibake(decodeUploadName(file.originalname));
  const sourcePath = await writePdfSource(documentId, file.buffer);
  const pageTexts = [];
  const parsed = await pdfParse(file.buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false
      });
      const text = pdfTextContentToLines(textContent).join("\n").trim();
      pageTexts.push(text);
      return text;
    }
  });

  const title = repairMojibake(parsed.info?.Title || path.parse(filename).name || "PDF");
  const author = repairMojibake(parsed.info?.Author || parsed.metadata?._metadata?.["dc:creator"] || "");
  const totalPages = Math.max(parsed.numpages ?? 0, pageTexts.length);
  const pages = Array.from({ length: totalPages }, (_, index) => pageTexts[index] ?? "");
  const pageBlocks = pages.map((text, index) => ({
    type: "page",
    pageNumber: index + 1,
    pdfSrc: sourcePath,
    blocks: pageTextToBlocks(text, index + 1)
  }));

  const starts = pageBlocks
    .map((page, index) => ({ index, title: inferPdfChapterTitle(blocksToText(page.blocks), index + 1) }))
    .filter((item) => item.title);
  if (starts.length === 0 || starts[0].index !== 0) starts.unshift({ index: 0, title });

  const chapters = starts.map((start, index) => {
    const next = starts[index + 1]?.index ?? pageBlocks.length;
    return {
      id: `chapter-${index + 1}`,
      title: start.title || `Chapter ${index + 1}`,
      href: start.href ?? "",
      blocks: pageBlocks.slice(start.index, next)
    };
  });

  return {
    title,
    author,
    coverPath: await writePdfCover(documentId, title, filename),
    sourcePath,
    text: chapters.map((chapter) => blocksToText(chapter.blocks)).filter(Boolean).join("\n\n"),
    chapters
  };
}

async function extractDocument(file, documentId) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".pdf") {
    return extractPdfDocument(file, documentId);
  }

  if (ext === ".epub") {
    const imported = await extractEpubDocument(file, documentId);
    return {
      ...imported,
      sourcePath: imported.sourcePath || await writeOriginalBookSource(documentId, decodeUploadName(file.originalname), file.buffer)
    };
  }

  const text = file.buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  return {
    sourcePath: await writeOriginalBookSource(documentId, decodeUploadName(file.originalname), file.buffer),
    text,
    chapters: [{ id: "chapter-1", title: "Document", blocks: splitSentences(text).map((sentence) => ({ type: "text", text: sentence })) }]
  };
}

function parseKnownTerms(buffer) {
  const text = buffer.toString("utf8");
  const values = new Set();

  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[\t,]/).map((cell) => normalizeJapaneseTerm(cell.replace(/^"|"$/g, "")));
    const value = cells.find((cell) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(cell));
    if (value) values.add(value);
  }

  return [...values].sort((a, b) => a.localeCompare(b, "ja"));
}

function mergeKnownTerms(incoming = [], addedAt = new Date().toISOString(), metadataByTerm = {}) {
  state.knownTermMeta ??= {};
  const existing = new Set(state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean));
  const added = [];
  for (const value of incoming.map(normalizeJapaneseTerm).filter(Boolean)) {
    const incomingMeta = metadataByTerm[value] ?? {};
    const existingMeta = state.knownTermMeta[value] ?? {};
    state.knownTermMeta[value] = mergeKnownTermMeta(existingMeta, { addedAt, ...incomingMeta });
    if (!existing.has(value)) {
      existing.add(value);
      added.push(value);
    }
  }
  state.knownTerms = [...state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean), ...added];
  if (added.length > 0) invalidateWordBankMeaningCache();
  return added;
}

function mergeKnownTermMeta(current = {}, incoming = {}) {
  const merged = { ...current };
  if (!merged.addedAt) merged.addedAt = incoming.addedAt ?? new Date().toISOString();
  if (incoming.ankiDeckName) merged.ankiDeckName = incoming.ankiDeckName;
  if (incoming.ankiModelName) merged.ankiModelName = incoming.ankiModelName;
  if (incoming.importedAt) merged.importedAt = incoming.importedAt;
  const noteIds = new Set([...(incoming.ankiNoteIds ?? []), ...(merged.ankiNoteIds ?? [])].map(Number).filter(Number.isFinite));
  if (noteIds.size > 0) merged.ankiNoteIds = [...noteIds];
  return merged;
}

function sortKnownTerms(terms = [], sort = "gojuon") {
  const meta = state.knownTermMeta ?? {};
  const jaCompare = (a, b) => a.localeCompare(b, "ja", { sensitivity: "base" });
  const addedCompare = (a, b) => String(meta[a]?.addedAt ?? "").localeCompare(String(meta[b]?.addedAt ?? ""));
  const values = [...terms];
  if (sort === "gojuon-desc") return values.sort((a, b) => jaCompare(b, a));
  if (sort === "added-desc") return values.sort((a, b) => addedCompare(b, a) || jaCompare(a, b));
  if (sort === "added-asc") return values.sort((a, b) => addedCompare(a, b) || jaCompare(a, b));
  if (sort === "length-desc") return values.sort((a, b) => b.length - a.length || jaCompare(a, b));
  if (sort === "length-asc") return values.sort((a, b) => a.length - b.length || jaCompare(a, b));
  return values.sort(jaCompare);
}

function selectedWordBankDictionaryId() {
  return state.dictionaries.find((dictionary) => dictionary.type === "term" && dictionary.selectedForWordBank)?.id ?? "";
}

function wordBankMeaningCacheSignature(dictionaryId = "") {
  const dictionary = state.dictionaries.find((item) => item.id === dictionaryId && item.type === "term");
  if (!dictionary) return "";
  return createHash("sha1")
    .update(dictionary.id ?? "")
    .update("\u0000")
    .update(dictionary.importedAt ?? "")
    .update("\u0000")
    .update(dictionary.updatedAt ?? "")
    .update("\u0000")
    .update(String(dictionary.entriesCount ?? dictionary.entries?.length ?? 0))
    .update("\u0000")
    .update(String(state.knownTerms.length))
    .update("\u0000")
    .update(state.knownTerms.map(normalizeJapaneseTerm).sort().join("\u0001"))
    .digest("hex");
}

function wordBankMeaningCacheEntry(dictionaryId = "") {
  const signature = wordBankMeaningCacheSignature(dictionaryId);
  if (!signature) return null;
  const cached = wordBankMeaningCache.get(dictionaryId);
  if (!cached || cached.signature !== signature) return null;
  return cached;
}

function lookupCachedWordBankMeaning(term = "", dictionaryId = "") {
  const resolvedDictionaryId = dictionaryId || selectedWordBankDictionaryId();
  const normalized = normalizeJapaneseTerm(term);
  const cache = wordBankMeaningCacheEntry(resolvedDictionaryId);
  if (cache && cache.entries.has(normalized)) return cache.entries.get(normalized);
  const entries = dictionaryService.lookupWordBank(normalized, resolvedDictionaryId);
  if (cache) cache.entries.set(normalized, entries);
  return entries;
}

function wordBankMeaningCacheStatus(dictionaryId = "") {
  const resolvedDictionaryId = dictionaryId || selectedWordBankDictionaryId();
  const dictionary = state.dictionaries.find((item) => item.id === resolvedDictionaryId && item.type === "term");
  if (!dictionary) {
    return {
      dictionaryId: "",
      dictionaryName: "",
      ready: false,
      stale: false,
      cachedTerms: 0,
      totalTerms: state.knownTerms.length,
      builtAt: "",
      message: "Choose a term dictionary."
    };
  }
  const signature = wordBankMeaningCacheSignature(resolvedDictionaryId);
  const cached = wordBankMeaningCache.get(resolvedDictionaryId);
  const ready = Boolean(cached && cached.signature === signature);
  return {
    dictionaryId: resolvedDictionaryId,
    dictionaryName: dictionary.name,
    ready,
    stale: Boolean(cached && cached.signature !== signature),
    cachedTerms: ready ? cached.entries.size : 0,
    totalTerms: state.knownTerms.length,
    builtAt: ready ? cached.builtAt : "",
    message: ready
      ? `${cached.entries.size.toLocaleString()} meanings cached.`
      : "Word Bank meanings have not been rebuilt for this dictionary."
  };
}

async function rebuildWordBankMeaningCache(dictionaryId = "") {
  const resolvedDictionaryId = dictionaryId || selectedWordBankDictionaryId();
  const dictionary = state.dictionaries.find((item) => item.id === resolvedDictionaryId && item.type === "term");
  if (!dictionary) {
    const error = new Error("Choose a term dictionary before rebuilding Word Bank meanings.");
    error.status = 400;
    throw error;
  }
  const signature = wordBankMeaningCacheSignature(resolvedDictionaryId);
  const entries = new Map();
  for (const [index, term] of state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean).entries()) {
    entries.set(term, dictionaryService.lookupWordBank(term, resolvedDictionaryId));
    if (index > 0 && index % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const cache = {
    dictionaryId: resolvedDictionaryId,
    dictionaryName: dictionary.name,
    signature,
    builtAt: new Date().toISOString(),
    entries
  };
  wordBankMeaningCache.set(resolvedDictionaryId, cache);
  while (wordBankMeaningCache.size > 6) wordBankMeaningCache.delete(wordBankMeaningCache.keys().next().value);
  return wordBankMeaningCacheStatus(resolvedDictionaryId);
}

function trashTermValue(entry) {
  return normalizeJapaneseTerm(typeof entry === "string" ? entry : entry?.term ?? "");
}

function trashTermMeta(entry) {
  if (entry && typeof entry === "object" && entry.meta && typeof entry.meta === "object") return entry.meta;
  const addedAt = entry && typeof entry === "object" && entry.addedAt ? entry.addedAt : new Date().toISOString();
  return { addedAt };
}

function moveKnownTermsToTrash(terms = [], reason = "manual") {
  const normalizedTerms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
  const selected = new Set(terms.map(normalizeJapaneseTerm).filter(Boolean));
  const deletedTerms = normalizedTerms.filter((term) => selected.has(term));
  const existingTrash = new Set(state.trash.knownTerms.map((entry) => trashTermValue(entry)).filter(Boolean));
  const deletedAt = new Date().toISOString();
  for (const term of deletedTerms) {
    if (!existingTrash.has(term)) {
      state.trash.knownTerms.unshift({ term, meta: state.knownTermMeta?.[term] ?? {}, deletedAt, reason });
      existingTrash.add(term);
    }
    delete state.knownTermMeta?.[term];
  }
  state.knownTerms = normalizedTerms.filter((term) => !selected.has(term));
  if (deletedTerms.length > 0) invalidateWordBankMeaningCache();
  return deletedTerms;
}

function toPlainGlossary(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toPlainGlossary).filter(Boolean).join("; ");
  if (value && typeof value === "object") {
    if (value.content) return toPlainGlossary(value.content);
    if (value.text) return toPlainGlossary(value.text);
    if (value.glossary) return toPlainGlossary(value.glossary);
    return Object.values(value).map(toPlainGlossary).filter(Boolean).join("; ");
  }
  return "";
}

function isNoisyDictionaryDefinition(value = "") {
  const text = String(value).trim();
  if (!text) return true;
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(text);
  const metadataMarkers = /[★⛬]|;/.test(text);
  const languagePrefix = /^[a-z]{2,3};\s/u.test(text);
  return hasJapanese && (metadataMarkers || languagePrefix);
}

function cleanDictionaryDefinitions(definitions = []) {
  const seen = new Set();
  const cleaned = [];
  for (const value of definitions.map(toPlainGlossary)) {
    const definition = String(value).replace(/\s+/g, " ").trim();
    if (!definition || isNoisyDictionaryDefinition(definition)) continue;
    const key = definition.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(definition);
  }
  return cleaned;
}

function parseDictionaryUpload(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const entries = [];

  if (ext === ".zip") {
    const zip = new AdmZip(file.buffer);
    for (const entry of zip.getEntries()) {
      if (!/term_bank_\d+\.json$/i.test(entry.entryName)) continue;
      const rows = JSON.parse(entry.getData().toString("utf8"));
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        entries.push({
          term: normalizeJapaneseTerm(row[0] ?? ""),
          reading: normalizeJapaneseTerm(row[1] ?? ""),
          definitions: Array.isArray(row[5]) ? row[5].map(toPlainGlossary).filter(Boolean) : [toPlainGlossary(row[5])].filter(Boolean)
        });
      }
    }
    return entries.filter((entry) => entry.term);
  }

  const parsed = JSON.parse(file.buffer.toString("utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.terms ?? parsed.entries ?? [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      entries.push({
        term: normalizeJapaneseTerm(row[0] ?? ""),
        reading: normalizeJapaneseTerm(row[1] ?? ""),
        definitions: Array.isArray(row[5]) ? row[5].map(toPlainGlossary).filter(Boolean) : [toPlainGlossary(row[5])].filter(Boolean)
      });
    } else if (row && typeof row === "object") {
      entries.push({
        term: normalizeJapaneseTerm(row.term ?? row.expression ?? row.word ?? ""),
        reading: normalizeJapaneseTerm(row.reading ?? ""),
        definitions: Array.isArray(row.definitions) ? row.definitions.map(toPlainGlossary).filter(Boolean) : [toPlainGlossary(row.definition ?? row.meaning ?? "")].filter(Boolean)
      });
    }
  }
  return entries.filter((entry) => entry.term);
}

function lookupDictionary(term) {
  return dictionaryService.lookup(term).entries.slice(0, 12);
}

function enrichCandidate(candidate) {
  const matches = lookupDictionary(candidate.dictionaryForm || candidate.expression);
  const best = matches[0];
  return {
    ...candidate,
    reading: candidate.reading || best?.reading || "",
    meaning: best?.definitions?.slice(0, 2).join("; ") || "",
    dictionaryEntries: matches
  };
}

function compactReaderContext(value = "", limit = 5000) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function compactRetrievedSnippet(value = "", limit = 500) {
  const text = compactReaderContext(value, Math.max(limit * 2, limit + 100));
  if (text.length <= limit) return text;
  const boundary = [...text.slice(0, limit + 1).matchAll(/[\u3002\uff01\uff1f!?」』]/g)].at(-1);
  const cut = boundary && boundary.index > Math.floor(limit * 0.35)
    ? boundary.index + boundary[0].length
    : limit;
  return text.slice(0, cut).replace(/[\u300c\u300e\s]+$/g, "").trim();
}

function hasUsableRetrievedSnippet(value = "") {
  const text = compactReaderContext(value, 120);
  const meaningful = text.replace(/[\s\u3000\u300c\u300d\u300e\u300f"'.,;:!?()\[\]{}<>-]/g, "");
  return meaningful.length >= 4 && hasJapaneseText(meaningful);
}

function assistantTermNotes(tokens = []) {
  const notes = [];
  const seen = new Set();
  for (const token of tokens) {
    const term = normalizeJapaneseTerm(token.dictionaryForm || token.base || token.surface || "");
    if (!term || seen.has(term) || !hasJapaneseText(term)) continue;
    seen.add(term);
    const entries = lookupDictionary(term).slice(0, 3);
    if (entries.length === 0) continue;
    const definitions = [...new Set(entries.flatMap((entry) => entry.definitions ?? []).filter(Boolean))].slice(0, 4);
    notes.push({
      term,
      surface: token.surface || term,
      reading: token.dictionaryReading || token.reading || entries[0]?.reading || "",
      definitions,
      dictionaries: [...new Set(entries.map((entry) => entry.dictionary).filter(Boolean))].slice(0, 3)
    });
    if (notes.length >= 10) break;
  }
  return notes;
}

const authorRubyNameNotesCache = new Map();

function assistantNameReadingNotes({ document, question = "", contextText = "", citations = [] } = {}) {
  const documentNotes = authorRubyReadingMapForDocument(document);
  if (documentNotes.size === 0) return [];
  const haystack = normalizeJapaneseTerm([
    question,
    contextText,
    ...citations.map((item) => item?.text ?? "")
  ].join("\n"));
  const notes = [];
  for (const [surface, readings] of documentNotes.entries()) {
    if (haystack && !haystack.includes(surface)) continue;
    const reading = mostCommonReading(readings);
    const romaji = hiraganaToRomaji(reading);
    if (!reading || !romaji) continue;
    notes.push({ surface, reading, romaji });
    if (notes.length >= 12) break;
  }
  return notes;
}

function authorRubyReadingMapForDocument(document = {}) {
  const documentId = String(document?.id ?? "");
  const text = String(document?.text ?? "");
  if (!documentId || !text) return new Map();
  const cacheKey = `${documentId}:${text.length}`;
  if (authorRubyNameNotesCache.has(cacheKey)) return authorRubyNameNotesCache.get(cacheKey);

  const readingsBySurface = new Map();
  const markerPattern = /\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g;
  for (const match of text.matchAll(markerPattern)) {
    const surface = normalizeJapaneseTerm(safeDecodeURIComponent(match[1] ?? ""));
    const reading = katakanaToHiragana(normalizeJapaneseTerm(safeDecodeURIComponent(match[2] ?? "")));
    if (!isAssistantNameReadingCandidate(surface, reading)) continue;
    if (!readingsBySurface.has(surface)) readingsBySurface.set(surface, new Map());
    const readings = readingsBySurface.get(surface);
    readings.set(reading, (readings.get(reading) ?? 0) + 1);
  }

  authorRubyNameNotesCache.set(cacheKey, readingsBySurface);
  if (authorRubyNameNotesCache.size > 12) authorRubyNameNotesCache.delete(authorRubyNameNotesCache.keys().next().value);
  return readingsBySurface;
}

function safeDecodeURIComponent(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value ?? "");
  }
}

function isAssistantNameReadingCandidate(surface = "", reading = "") {
  return Boolean(
    surface &&
    reading &&
    hasKanji(surface) &&
    surface.length <= 6 &&
    reading.length <= 12 &&
    /^[\u3040-\u309fー]+$/u.test(reading)
  );
}

function mostCommonReading(readings = new Map()) {
  return [...readings.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? "";
}

const HIRAGANA_ROMAJI_DIGRAPHS = new Map(Object.entries({
  "\u304d\u3083": "kya", "\u304d\u3085": "kyu", "\u304d\u3087": "kyo",
  "\u304e\u3083": "gya", "\u304e\u3085": "gyu", "\u304e\u3087": "gyo",
  "\u3057\u3083": "sha", "\u3057\u3085": "shu", "\u3057\u3087": "sho",
  "\u3058\u3083": "ja", "\u3058\u3085": "ju", "\u3058\u3087": "jo",
  "\u3061\u3083": "cha", "\u3061\u3085": "chu", "\u3061\u3087": "cho",
  "\u306b\u3083": "nya", "\u306b\u3085": "nyu", "\u306b\u3087": "nyo",
  "\u3072\u3083": "hya", "\u3072\u3085": "hyu", "\u3072\u3087": "hyo",
  "\u3073\u3083": "bya", "\u3073\u3085": "byu", "\u3073\u3087": "byo",
  "\u3074\u3083": "pya", "\u3074\u3085": "pyu", "\u3074\u3087": "pyo",
  "\u307f\u3083": "mya", "\u307f\u3085": "myu", "\u307f\u3087": "myo",
  "\u308a\u3083": "rya", "\u308a\u3085": "ryu", "\u308a\u3087": "ryo"
}));

const HIRAGANA_ROMAJI = new Map(Object.entries({
  "\u3042": "a", "\u3044": "i", "\u3046": "u", "\u3048": "e", "\u304a": "o",
  "\u304b": "ka", "\u304d": "ki", "\u304f": "ku", "\u3051": "ke", "\u3053": "ko",
  "\u3055": "sa", "\u3057": "shi", "\u3059": "su", "\u305b": "se", "\u305d": "so",
  "\u305f": "ta", "\u3061": "chi", "\u3064": "tsu", "\u3066": "te", "\u3068": "to",
  "\u306a": "na", "\u306b": "ni", "\u306c": "nu", "\u306d": "ne", "\u306e": "no",
  "\u306f": "ha", "\u3072": "hi", "\u3075": "fu", "\u3078": "he", "\u307b": "ho",
  "\u307e": "ma", "\u307f": "mi", "\u3080": "mu", "\u3081": "me", "\u3082": "mo",
  "\u3084": "ya", "\u3086": "yu", "\u3088": "yo",
  "\u3089": "ra", "\u308a": "ri", "\u308b": "ru", "\u308c": "re", "\u308d": "ro",
  "\u308f": "wa", "\u3092": "o", "\u3093": "n",
  "\u304c": "ga", "\u304e": "gi", "\u3050": "gu", "\u3052": "ge", "\u3054": "go",
  "\u3056": "za", "\u3058": "ji", "\u305a": "zu", "\u305c": "ze", "\u305e": "zo",
  "\u3060": "da", "\u3062": "ji", "\u3065": "zu", "\u3067": "de", "\u3069": "do",
  "\u3070": "ba", "\u3073": "bi", "\u3076": "bu", "\u3079": "be", "\u307c": "bo",
  "\u3071": "pa", "\u3074": "pi", "\u3077": "pu", "\u307a": "pe", "\u307d": "po",
  "\u3041": "a", "\u3043": "i", "\u3045": "u", "\u3047": "e", "\u3049": "o"
}));

function hiraganaToRomaji(value = "") {
  const chars = [...katakanaToHiragana(String(value ?? "").replace(/ー/g, ""))];
  let output = "";
  let geminate = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === "\u3063") {
      geminate = true;
      continue;
    }
    const pair = `${char}${chars[index + 1] ?? ""}`;
    let roman = HIRAGANA_ROMAJI_DIGRAPHS.get(pair);
    if (roman) index += 1;
    else roman = HIRAGANA_ROMAJI.get(char) ?? "";
    if (!roman) continue;
    if (geminate && /^[bcdfghjklmnpqrstvwxyz]/.test(roman)) roman = `${roman[0]}${roman}`;
    geminate = false;
    output += roman;
  }
  return output ? `${output[0].toUpperCase()}${output.slice(1)}` : "";
}

function assistantResponseText(task, { contextText, question, termNotes, citations, document, translation }) {
  const title = document?.title || "the current book";
  const terms = termNotes.slice(0, 6).map((term) => {
    const meaning = term.definitions?.slice(0, 2).join("; ") || "no dictionary definition";
    return `- ${term.term}${term.reading ? ` (${term.reading})` : ""}: ${meaning}`;
  });
  if (task === "recap") {
    const sentences = splitSentences(contextText).slice(0, 5);
    return [
      `Recap seed for ${title}:`,
      sentences.length ? sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n") : "No readable current-page text was available.",
      citations.length ? "Related local passages are listed below." : "Rebuild the local index to add cross-book citations."
    ].join("\n\n");
  }
  if (task === "translate") {
    if (translation?.available && translation.translatedText) {
      return translation.translatedText;
    }
    return [
      `Local AI is not ready yet. ${translation?.reason || "Configure a local assistant model in Integrations."}`,
      contextText ? `Message text:\n${contextText.slice(0, 900)}` : "Type the text you want translated.",
      terms.length ? `Dictionary anchors:\n${terms.join("\n")}` : "No dictionary anchors were found for this context."
    ].join("\n\n");
  }
  if (task === "ask") {
    return [
      question ? `Question: ${question}` : "Question: current page",
      contextText ? `Current context:\n${contextText.slice(0, 900)}` : "No current page context was available.",
      terms.length ? `Useful terms:\n${terms.join("\n")}` : "No dictionary terms were found.",
      citations.length ? "Relevant indexed passages are listed below." : "No indexed citations were found. Rebuild the local index after importing books."
    ].join("\n\n");
  }
  return [
    "Context explanation:",
    contextText ? contextText.slice(0, 900) : "No readable selected text or page text was available.",
    terms.length ? `Key vocabulary and dictionary meanings:\n${terms.join("\n")}` : "No dictionary-backed vocabulary notes were found.",
    citations.length ? "Related passages from your local library are listed below." : "No related indexed passages were found."
  ].join("\n\n");
}

function isTranslationPrompt(value = "") {
  return /^translate(?:\s+this)?(?:\s+to\s+english)?\s*[:：]/i.test(String(value).trim())
    || /^translate\s+/i.test(String(value).trim());
}

function inferAssistantIntent(value = "") {
  const text = String(value ?? "").trim();
  const lower = text.toLowerCase();
  if (isTranslationPrompt(text)) return "translate";
  if (/\b(recap|summari[sz]e|summary|what happened|so far)\b/.test(lower)) return "recap";
  if (/\b(explain|break down|grammar|conjugat|nuance|why is|what does .* mean|difference between)\b/.test(lower)) return "explain";
  if (looksLikeJapanesePassage(text)) return "translate";
  return "ask";
}

function assistantWantsLocalCitations(value = "") {
  const lower = String(value ?? "").toLowerCase();
  return /\b(citation|citations|source|sources|evidence|quote|quotes|passage|passages|where else|other books?|similar examples?|similar sentences?|cross[- ]book|rag)\b/.test(lower)
    || /他の本|引用|出典|根拠|似た例|似ている文/.test(String(value ?? ""));
}

function assistantWantsExplicitCitations(value = "") {
  const lower = String(value ?? "").toLowerCase();
  return /\b(citation|citations|source|sources|evidence|quote|quotes|passage|passages)\b/.test(lower)
    || /å¼•ç”¨|å‡ºå…¸|æ ¹æ‹ /.test(String(value ?? ""));
}

function assistantWantsLocalRetrieval(value = "") {
  const lower = String(value ?? "").toLowerCase();
  return assistantWantsExplicitCitations(value)
    || /\b(search|find|look for|where else|examples?|other examples?|other books?|my library|app'?s library|this app|local library|library|similar examples?|similar sentences?|cross[- ]book|rag|appears?|occurs?|show me)\b/.test(lower);
}

function assistantWantsExamples(value = "") {
  const lower = String(value ?? "").toLowerCase();
  return /\b(search|find|look for|where else|examples?|other examples?|similar examples?|similar sentences?|show me)\b/.test(lower);
}

const ASSISTANT_REVERSE_DEFINITION_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "among",
  "another",
  "app",
  "book",
  "books",
  "example",
  "examples",
  "find",
  "given",
  "library",
  "local",
  "other",
  "search",
  "sentence",
  "sentences",
  "show",
  "that",
  "this",
  "where",
  "with",
  "your"
]);
const assistantReverseDefinitionCache = new Map();

function assistantRetrievalQuery(question = "", contextText = "", history = []) {
  const previousUser = previousUserMessage(history);
  const current = compactReaderContext(question, 700);
  const previous = compactReaderContext(previousUser, 700);
  const combined = previous && assistantFollowupNeedsPreviousQuestion(current)
    ? `${previous}\n${current}`
    : current;
  const reverseTerms = reverseDictionaryTermsForAssistantQuery(combined);
  const expanded = reverseTerms.length ? `${combined}\n${reverseTerms.join(" ")}` : combined;
  return compactReaderContext(expanded, 900) || contextText.slice(0, 250);
}

function assistantFollowupNeedsPreviousQuestion(value = "") {
  const lower = String(value ?? "").toLowerCase();
  return lower.length < 160 && /\b(this|that|it|app'?s library|this app|library|yes|yeah|among|those|them|previous|above)\b/.test(lower);
}

function reverseDictionaryTermsForAssistantQuery(query = "") {
  const anchors = englishDefinitionAnchors(query);
  if (anchors.length === 0) return [];
  const dictionarySignature = state.dictionaries
    .filter((dictionary) => dictionary.type === "term" && dictionary.enabledForLookup)
    .map((dictionary) => `${dictionary.id}:${dictionary.entries?.length ?? 0}:${dictionary.sortOrder ?? 0}`)
    .join("|");
  const cacheKey = `${dictionarySignature}\u0000${anchors.join("|")}`;
  if (assistantReverseDefinitionCache.has(cacheKey)) return assistantReverseDefinitionCache.get(cacheKey);

  const scored = new Map();
  for (const dictionary of state.dictionaries.filter((item) => item.type === "term" && item.enabledForLookup).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))) {
    for (const entry of dictionary.entries ?? []) {
      const term = normalizeJapaneseTerm(entry.term ?? "");
      if (!term || !hasJapaneseText(term)) continue;
      const definitions = Array.isArray(entry.definitions) ? entry.definitions : [];
      const details = Array.isArray(entry.details) ? entry.details : [];
      const text = [...definitions, ...details].join(" ").toLowerCase();
      if (!text) continue;
      const score = anchors.reduce((total, anchor) => total + (text.includes(anchor) ? 1 : 0), 0);
      if (score <= 0) continue;
      const existing = scored.get(term) ?? 0;
      scored.set(term, Math.max(existing, score));
    }
  }
  const terms = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, 12)
    .map(([term]) => term);
  assistantReverseDefinitionCache.set(cacheKey, terms);
  if (assistantReverseDefinitionCache.size > 50) assistantReverseDefinitionCache.delete(assistantReverseDefinitionCache.keys().next().value);
  return terms;
}

function englishDefinitionAnchors(query = "") {
  return [...new Set(String(query ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])]
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length >= 4 && !ASSISTANT_REVERSE_DEFINITION_STOPWORDS.has(word))
    .slice(0, 4);
}

function looksLikeJapanesePassage(value = "") {
  const text = String(value ?? "").trim();
  if (!hasJapaneseText(text)) return false;
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return japanese >= 4 && japanese >= latin * 2;
}

function translationPromptText(value = "") {
  const text = String(value ?? "").trim();
  const stripped = text
    .replace(/^translate(?:\s+this)?(?:\s+to\s+english)?\s*[:：]?\s*/i, "")
    .trim();
  return stripped || text;
}

function normalizeAssistantHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: compactReaderContext(message?.content, 900)
    }))
    .filter((message) => message.content)
    .slice(-6);
}

function previousUserMessage(history = []) {
  const normalized = normalizeAssistantHistory(history);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index].role === "user") return normalized[index].content;
  }
  return "";
}

function assistantContextMessage({ intent, question, contextText, history = [], termNotes, nameNotes = [], citations, document, page, includeRetrievedContext = false, includeCitations = false, exampleSearch = false }) {
  const lines = [
    "You are running inside Yomiã‚¢ãƒ—ãƒª, a local Japanese reading app.",
    `The app library currently contains ${state.documents.length} imported book${state.documents.length === 1 ? "" : "s"}.`,
    "When the user says my library, this app's library, other books, examples, search, or similar, they mean this local app library and its indexed book text.",
    "If local retrieved context is provided below, you have access to those app search results. Do not claim you cannot access the user's library.",
    `Intent: ${intent}`,
    `Current book: ${document?.title || "unknown"}`,
    `Current page: ${Number(page) + 1 || "unknown"}`
  ];
  const previousUser = previousUserMessage(history);
  if (previousUser && intent !== "translate") {
    lines.push(`Immediate previous user message. Use this first for follow-up references like "the second sentence", "previous sentence", or "that grammar point":\n${compactReaderContext(previousUser, 900)}`);
  }
  if (intent === "translate") {
    lines.push("Translate only the user's requested text. Do not translate unrelated page text.");
  }
  if (intent === "recap") {
    lines.push("Use only already-read or supplied local context. Avoid spoilers.");
  }
  if (exampleSearch) {
    lines.push("The user is asking for examples from the indexed app library. Use only the local retrieved app-library context below. Answer with up to four complete examples copied from that context, then one short reason each is similar. Do not invent dialogue. Do not output a standalone opening quote or incomplete quote as an example. If the retrieved context does not contain a usable match, say: No matching indexed examples were found.");
  }
  if (contextText && intent !== "translate") {
    lines.push(`Reader context:\n${compactReaderContext(contextText, 900)}`);
  }
  if (termNotes.length) {
    lines.push(`Dictionary lookup notes for grounding only. Do not label these as vocabulary anchors in the answer:\n${termNotes.slice(0, 6).map((term) => {
      const meaning = term.definitions?.slice(0, 2).join("; ") || "no dictionary definition";
      return `- ${term.term}${term.reading ? ` (${term.reading})` : ""}: ${meaning}`;
    }).join("\n")}`);
  }
  if (nameNotes.length) {
    lines.push(`Author ruby/name reading notes from the current book. These override common kanji readings when romanizing character names:\n${nameNotes.slice(0, 12).map((note) => {
      return `- ${note.surface}: ${note.reading} -> ${note.romaji}`;
    }).join("\n")}`);
  }
  if (includeRetrievedContext && citations.length) {
    const usableCitations = citations.filter((item) => hasUsableRetrievedSnippet(item.text)).slice(0, 6);
    const snippetLimit = exampleSearch ? 700 : 420;
    if (!usableCitations.length) {
      lines.push("Local retrieved app-library context: no usable indexed matches were found for this query. Say that no matching indexed examples were found instead of claiming you cannot access the library.");
    } else {
      lines.push(`Local retrieved app-library context for grounding. Use these book-text matches to answer search/example/library questions. Do not mention citations, sources, passages, or book/page labels unless the user explicitly asked for them:\n${usableCitations.map((item, index) => {
      const label = `${item.title || "Untitled"}${item.chapterTitle ? `, ${item.chapterTitle}` : ""}${item.page ? `, page ${Number(item.page) + 1}` : ""}`;
      return `${index + 1}. ${label}: ${compactRetrievedSnippet(item.text, snippetLimit)}`;
      }).join("\n")}`);
    }
  } else if (includeRetrievedContext) {
    lines.push("Local retrieved app-library context: no indexed matches were found for this query. Say that no matching indexed examples were found instead of claiming you cannot access the library.");
  }
  return compactReaderContext(lines.join("\n\n"), exampleSearch ? 4200 : 2600);
}

function buildAssistantMessages({ intent, question, contextText, history, termNotes, nameNotes = [], citations, document, page, includeRetrievedContext = false, includeCitations = false, exampleSearch = false }) {
  const messages = [];
  const context = assistantContextMessage({ intent, question, contextText, history, termNotes, nameNotes, citations, document, page, includeRetrievedContext, includeCitations, exampleSearch });
  if (context) messages.push({ role: "user", content: `App-provided context for this turn:\n${context}` });
  messages.push(...normalizeAssistantHistory(history));
  messages.push({ role: "user", content: question });
  return messages;
}

function assistantMaxTokens(intent, contextText = "", options = {}) {
  if (intent === "translate") return Math.max(96, Math.min(768, Math.ceil(String(contextText).length * 1.8) + 64));
  if (options.exampleSearch) return 768;
  if (options.useRagContext) return 640;
  if (intent === "explain") return 448;
  if (intent === "recap") return 512;
  return 512;
}

async function aiRuntimeStatus() {
  const runtimes = await Promise.all(["8093", "8094"].map(aiRuntimeForPort));
  const active = runtimes.filter((runtime) => runtime.running);
  const lastActivity = active
    .map((runtime) => runtime.lastActivity)
    .filter(Boolean)
    .sort()
    .at(-1) ?? "";
  return {
    running: active.length > 0,
    count: active.length,
    runtimes,
    lastActivity,
    idleTimeoutSeconds: Math.max(0, Number(process.env.LLAMA_IDLE_TIMEOUT_SECONDS ?? 600) || 0)
  };
}

async function aiRuntimeForPort(port) {
  const pidPath = path.join(dataDir, "llama", `llama-server-${port}.pid`);
  const activityPath = path.join(dataDir, "llama", `llama-server-${port}.activity`);
  const pid = await readPidFile(pidPath);
  const running = pid > 0 && isPidRunning(pid);
  return {
    port,
    pid,
    running,
    lastActivity: await readActivityTime(activityPath)
  };
}

async function stopAiRuntime() {
  const runtimes = await aiRuntimeStatus();
  let stopped = 0;
  for (const runtime of runtimes.runtimes) {
    if (!runtime.running || !runtime.pid) continue;
    try {
      process.kill(runtime.pid);
      stopped += 1;
    } catch {
      // Process may have exited between status check and kill.
    }
  }
  return stopped;
}

async function readPidFile(pidPath) {
  try {
    const value = Number(String(await fs.readFile(pidPath, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function readActivityTime(activityPath) {
  try {
    return new Date((await fs.stat(activityPath)).mtimeMs).toISOString();
  } catch {
    return "";
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function learnedSet() {
  return new Set(state.knownTerms.map((term) => normalizeJapaneseTerm(term)));
}

async function learnedVariantSet() {
  const key = state.knownTerms.map((term) => normalizeJapaneseTerm(term)).sort().join("\u0000");
  if (learnedVariantCache && learnedVariantCacheKey === key) return learnedVariantCache;
  const known = new Set();
  let tokenizer = null;
  for (const term of state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean)) {
    known.add(term);
    if (!hasJapaneseText(term) || term.length > 80) continue;
    try {
      tokenizer ??= await getTokenizer();
      for (const token of tokenizer.tokenize(term)) {
        const surface = normalizeJapaneseTerm(token.surface_form);
        const base = tokenBase(token);
        if (surface) known.add(surface);
        if (base) known.add(base);
      }
    } catch {
      // Keep direct known terms even if tokenizer setup fails.
    }
  }
  learnedVariantCacheKey = key;
  learnedVariantCache = known;
  return known;
}

function tokenBase(token) {
  const base = token.basic_form && token.basic_form !== "*" ? token.basic_form : token.surface_form;
  return normalizeJapaneseTerm(base);
}

function tokenReading(token) {
  if (!token.reading || token.reading === "*") return "";
  return katakanaToHiragana(token.reading);
}

async function dictionaryLookupTerms(term = "") {
  const normalized = normalizeJapaneseTerm(term);
  const terms = [];
  const addTerm = (value = "", requireJapanese = false) => {
    const cleaned = normalizeJapaneseTerm(value);
    if (cleaned && (!requireJapanese || hasJapaneseText(cleaned)) && !terms.includes(cleaned)) terms.push(cleaned);
  };

  addTerm(normalized);
  if (!normalized || !hasJapaneseText(normalized) || normalized.length > 80) return terms;

  for (const token of await analyzeReaderTokenStream(normalized)) {
    for (const term of tokenLookupVariants(token)) addTerm(term, true);
  }
  return terms;
}

async function lookupDictionaryForms(term = "", options = {}) {
  const terms = await dictionaryLookupTerms(term);
  const entries = [];
  const frequencies = [];
  const seenEntries = new Set();
  const seenFrequencies = new Set();

  for (let index = 0; index < terms.length; index += 1) {
    const lookupTerm = terms[index];
    const result = dictionaryService.lookup(lookupTerm, options);
    for (const entry of result.entries ?? []) {
      for (const redirectTarget of entry.redirectTargets ?? []) {
        if (!terms.includes(redirectTarget)) terms.push(redirectTarget);
      }
      const key = [
        entry.dictionaryId,
        entry.term,
        (entry.definitions ?? []).join("\u0000").toLowerCase()
      ].join("\u0001");
      if (seenEntries.has(key)) {
        const existing = entries.find((candidate) => candidate.__mergeKey === key);
        if (existing) mergeLookupEntry(existing, entry);
        continue;
      }
      seenEntries.add(key);
      entries.push({ ...entry, matchedTerm: lookupTerm, redirectedFrom: lookupTerm === term ? "" : term, __mergeKey: key });
    }
    for (const frequency of result.frequencies ?? []) {
      const key = [
        frequency.dictionaryId,
        frequency.displayValue,
        frequency.value
      ].join("\u0001");
      if (seenFrequencies.has(key)) continue;
      seenFrequencies.add(key);
      frequencies.push({ ...frequency, matchedTerm: lookupTerm });
    }
  }

  const publicEntries = entries
    .map(({ __mergeKey, ...entry }) => entry)
    .sort((a, b) =>
      Number(isRedirectOnlyLookupEntry(a)) - Number(isRedirectOnlyLookupEntry(b)) ||
      Number(isReferenceLookupEntry(a)) - Number(isReferenceLookupEntry(b)) ||
      Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)
    );

  return {
    entries: publicEntries,
    frequencies,
    knownTerm: knownTermLookupMatch(term, terms, publicEntries),
    queryTerms: terms
  };
}

function knownTermLookupMatch(term = "", queryTerms = [], entries = []) {
  const known = learnedSet();
  const candidates = [
    term,
    ...queryTerms,
    ...entries.flatMap((entry) => [
      entry.term,
      entry.matchedTerm,
      ...String(entry.reading || "").split(" / ")
    ])
  ]
    .map(normalizeJapaneseTerm)
    .filter(Boolean);

  const matched = candidates.find((candidate) => known.has(candidate));
  if (!matched) return { exists: false, term: "", hasAnkiNote: false, ankiNoteIds: [] };
  const meta = state.knownTermMeta?.[matched] ?? {};
  const ankiNoteIds = [...new Set((meta.ankiNoteIds ?? []).map(Number).filter(Number.isFinite))];
  return { exists: true, term: matched, hasAnkiNote: ankiNoteIds.length > 0, ankiNoteIds };
}

function isRedirectOnlyLookupEntry(entry) {
  const definitions = entry.definitions ?? [];
  return definitions.length > 0 && definitions.every((definition) => /^redirected from$/i.test(String(definition).trim()));
}

function isReferenceLookupEntry(entry) {
  return (entry.redirectTargets?.length ?? 0) > 0 && (entry.details ?? entry.definitions ?? []).some((line) => /^see:?$/i.test(String(line).replace(/^[•・]\s*/, "").trim()));
}

function mergeLookupEntry(target, source) {
  const readings = new Set(String(target.reading || "").split(" / ").filter(Boolean));
  if (source.reading) readings.add(source.reading);
  target.reading = [...readings].join(" / ");
  target.tags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])];
}

function isLearnedToken(token, known) {
  const surface = normalizeJapaneseTerm(token.surface_form);
  const base = tokenBase(token);
  return known.has(surface) || known.has(base);
}

function isLearnedAnalyzedToken(token, known) {
  return known.has(normalizeJapaneseTerm(token.surface)) || known.has(normalizeJapaneseTerm(token.base));
}

function buildSentenceLookup(text) {
  const sentences = [];
  const regex = /[^。！？!?]+[。！？!?]?/g;
  let match;

  while ((match = regex.exec(text))) {
    const value = match[0].trim();
    if (value) sentences.push({ start: match.index, end: match.index + match[0].length, text: value });
  }

  return sentences;
}

function sentenceForOffset(sentences, offset) {
  return sentences.find((sentence) => sentence.start <= offset && offset <= sentence.end)?.text ?? "";
}

async function analyzeTextLegacy(text = "") {
  if (!hasJapaneseText(text)) return { tokens: [], candidates: [] };

  const tokenizer = await getTokenizer();
  const known = learnedSet();
  const tokens = tokenizer.tokenize(text);
  const sentences = buildSentenceLookup(text);
  let offset = 0;

  const analyzed = tokens.map((token) => {
    const start = text.indexOf(token.surface_form, offset);
    if (start >= 0) offset = start + token.surface_form.length;

    const surface = normalizeJapaneseTerm(token.surface_form);
    const base = tokenBase(token);
    const reading = tokenReading(token);
    const learned = isLearnedToken(token, known);
    const eligible = hasKanji(surface) && !learned && token.pos !== "記号";

    return {
      surface,
      base,
      reading,
      pos: token.pos,
      learned,
      eligible,
      start: start >= 0 ? start : offset,
      sentence: eligible ? sentenceForOffset(sentences, start) : ""
    };
  });

  const candidatesByKey = new Map();
  for (const token of analyzed) {
    if (!token.eligible) continue;
    const key = token.dictionaryForm || token.base || token.surface;
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        expression: token.dictionaryForm || token.base || token.surface,
        surface: token.surface,
        dictionaryForm: token.dictionaryForm || token.base,
        reading: token.dictionaryReading || token.reading,
        partOfSpeech: token.pos,
        readabilityStatus: token.readabilityStatus,
        readabilityScore: token.readabilityScore,
        readabilityReasons: token.readabilityReasons ?? [],
        sentence: token.sentence
      });
    }
  }

  return { tokens: analyzed, candidates: [...candidatesByKey.values()] };
}

async function analyzeText(text = "") {
  if (!hasJapaneseText(text)) return { tokens: [], candidates: [] };

  const tokens = await analyzeReaderTokenStream(text);
  const sentences = buildSentenceLookup(text);
  const analyzed = tokens.map((token) => ({
    ...token,
    sentence: token.eligible ? sentenceForOffset(sentences, token.start ?? 0) : ""
  }));

  const candidatesByKey = new Map();
  for (const token of analyzed) {
    if (!token.eligible) continue;
    const key = token.dictionaryForm || token.base || token.surface;
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        expression: token.dictionaryForm || token.base || token.surface,
        surface: token.surface,
        dictionaryForm: token.dictionaryForm || token.base,
        reading: token.dictionaryReading || token.reading,
        partOfSpeech: token.pos,
        readabilityStatus: token.readabilityStatus,
        readabilityScore: token.readabilityScore,
        readabilityReasons: token.readabilityReasons ?? [],
        sentence: token.sentence
      });
    }
  }

  return { tokens: analyzed, candidates: [...candidatesByKey.values()] };
}

async function analyzeDocument(document) {
  return analyzeText(document.text);
}

function renderRuby(tokens) {
  return tokens
    .map((token) => {
      const reading = primaryReading(token.displayReading || token.reading || token.dictionaryReading || "");
      if (!token.eligible || !reading) return escapeHtml(token.surface);
      return `<ruby data-base="${escapeHtml(token.dictionaryForm || token.base)}" data-reading="${escapeHtml(reading)}">${escapeHtml(token.surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
    })
    .join("");
}

async function renderAnkiSentenceHtml(sentence = "", target = "", context = {}) {
  if (!hasJapaneseText(sentence)) return highlightPlainSentenceTarget(sentence, target);
  const tokens = await analyzeReaderTokenStream(sentence);
  return renderAnkiSentenceTokens(tokens, target, context);
}

function renderAnkiSentenceTokens(tokens = [], target = "", context = {}) {
  const targetIndexes = targetTokenIndexes(tokens, target, context.targets ?? []);
  const fallbackTargetReading = targetIndexes.size === 1 ? primaryReading(context.reading) : "";
  return tokens
    .map((token, index) => {
      const isTarget = targetIndexes.has(index);
      const html = tokenToAnkiHtml(token, true, isTarget ? fallbackTargetReading : "");
      return isTarget ? `<span style="color:#ff5a3d;font-weight:700;">${html}</span>` : html;
    })
    .join("");
}

function targetTokenIndexes(tokens = [], target = "", extraTargets = []) {
  const normalizedTargets = [...new Set([target, ...extraTargets]
    .map((value) => normalizeJapaneseTerm(value))
    .filter((value) => value && hasJapaneseText(value)))];
  const indexes = new Set();
  if (normalizedTargets.length === 0) return indexes;

  for (const normalizedTarget of normalizedTargets) {
    for (let start = 0; start < tokens.length; start += 1) {
      const token = tokens[start];
      if (tokenLookupVariants(token).includes(normalizedTarget)) {
        indexes.add(start);
        continue;
      }

      let joined = "";
      const current = [];
      for (let end = start; end < tokens.length && joined.length < normalizedTarget.length; end += 1) {
        const surface = normalizeJapaneseTerm(tokens[end]?.surface ?? "");
        if (!surface || /[\u3002\u3001\uff01\uff1f!?\s]/u.test(surface)) break;
        joined += surface;
        current.push(end);
        if (joined === normalizedTarget) {
          current.forEach((index) => indexes.add(index));
          break;
        }
      }
    }
  }

  return indexes;
}

function tokenToAnkiHtml(token, forceRuby = false, fallbackReading = "") {
  if (token.html) return token.html;
  const surface = token.surface ?? "";
  const reading = primaryReading(token.displayReading || token.reading) || primaryReading(fallbackReading);
  const shouldShowRuby = Boolean(reading && hasKanji(surface) && (forceRuby || token.eligible));
  if (!shouldShowRuby) return escapeHtml(surface);
  return `<ruby data-base="${escapeHtml(token.dictionaryForm || token.base || surface)}" data-reading="${escapeHtml(reading)}">${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
}

function highlightPlainSentenceTarget(sentence = "", target = "") {
  const source = String(sentence ?? "");
  const needle = String(target ?? "").trim();
  if (!source || !needle) return escapeHtml(source);
  const index = source.indexOf(needle);
  if (index < 0) return escapeHtml(source);
  return [
    escapeHtml(source.slice(0, index)),
    `<span style="color:#ff5a3d;font-weight:700;">${escapeHtml(source.slice(index, index + needle.length))}</span>`,
    escapeHtml(source.slice(index + needle.length))
  ].join("");
}

function renderRubyLines(tokens) {
  const lines = [];
  let line = "";
  let quoteDepth = 0;
  for (const token of tokens) {
    line += tokenToHtml(token);
    for (const char of token.surface) {
      if (char === "「") quoteDepth += 1;
      if (char === "」") quoteDepth = Math.max(0, quoteDepth - 1);
    }
    if (quoteDepth === 0 && /[。！？!?\n]/u.test(token.surface)) {
      if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
      line = "";
    }
  }
  if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
  return lines.join("");
}

function tokenToHtml(token) {
  if (token.html) return token.html;
  const normalizedReading = primaryReading(token.displayReading || token.reading || token.dictionaryReading || "");
  const normalizedBase = token.dictionaryForm || token.base || token.surface;
  const readabilityAttrs = readabilityDataAttributes(token);
  if (!token.eligible || !normalizedReading) {
    if (hasJapaneseText(token.surface) && token.pos !== "\u8a18\u53f7") {
      return `<span class="lookup-token" data-base="${escapeHtml(normalizedBase)}" data-reading="${escapeHtml(normalizedReading)}"${readabilityAttrs}>${escapeHtml(token.surface)}</span>`;
    }
    return escapeHtml(token.surface);
  }
  return `<ruby data-base="${escapeHtml(normalizedBase)}" data-reading="${escapeHtml(normalizedReading)}"${readabilityAttrs}>${escapeHtml(token.surface)}<rt>${escapeHtml(normalizedReading)}</rt></ruby>`;
}

function readabilityDataAttributes(token = {}) {
  const status = token.readabilityStatus || "";
  if (!status) return "";
  const reasons = Array.isArray(token.readabilityReasons) ? token.readabilityReasons.join(", ") : "";
  return [
    ` data-readability-status="${escapeHtml(status)}"`,
    ` data-readability-score="${escapeHtml(String(token.readabilityScore ?? 0))}"`,
    reasons ? ` data-readability-reasons="${escapeHtml(reasons)}"` : ""
  ].join("");
}

function primaryReading(reading = "") {
  return String(reading).split("/")[0].trim();
}

function uniqueNormalizedTerms(values = []) {
  const seen = new Set();
  const terms = [];
  for (const value of values.flat()) {
    const term = normalizeJapaneseTerm(String(value ?? ""));
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function tokenLookupVariants(token = {}) {
  return uniqueNormalizedTerms([
    token.surface,
    token.base,
    token.dictionaryForm,
    token.displayReading,
    token.dictionaryReading,
    token.lookupTerms ?? []
  ]).filter((term) => hasJapaneseText(term));
}

function isBoundaryToken(token = {}) {
  return !token.surface || /[\u3002\u3001\uff01\uff1f!?\s]/u.test(token.surface);
}

function dictionaryNormalizationSignature() {
  const signature = createHash("sha1")
    .update(JSON.stringify((state.dictionaries ?? []).map((dictionary) => ({
      id: dictionary.id,
      type: dictionary.type,
      enabledForLookup: dictionary.enabledForLookup,
      sortOrder: dictionary.sortOrder,
      entriesCount: dictionary.entriesCount ?? dictionary.entries?.length ?? 0,
      importedAt: dictionary.importedAt ?? "",
      updatedAt: dictionary.updatedAt ?? ""
    }))))
    .digest("hex");
  if (signature !== normalizationDictionarySignatureCache) {
    normalizationDictionaryCache.clear();
    readerTokenCache.clear();
    normalizationDictionarySignatureCache = signature;
  }
  return signature;
}

function readerTokenCacheKey(text = "", authorRubyProtectedTerms = new Set()) {
  return createHash("sha1")
    .update(dictionaryNormalizationSignature())
    .update("\u0000")
    .update([...authorRubyProtectedTerms].sort().join("\u0001"))
    .update("\u0000")
    .update(text)
    .digest("hex");
}

function rememberReaderTokens(key, tokens) {
  readerTokenCache.set(key, tokens);
  if (readerTokenCache.size > 1500) {
    const firstKey = readerTokenCache.keys().next().value;
    if (firstKey) readerTokenCache.delete(firstKey);
  }
}

function exactDictionaryEntry(term = "") {
  const normalized = normalizeJapaneseTerm(term);
  if (!normalized) return null;
  dictionaryNormalizationSignature();
  if (normalizationDictionaryCache.has(normalized)) return normalizationDictionaryCache.get(normalized);
  const entry = dictionaryService.exactTerm(normalized);
  normalizationDictionaryCache.set(normalized, entry ?? null);
  return entry ?? null;
}

function canonicalDictionaryMatch(terms = []) {
  for (const term of uniqueNormalizedTerms(terms)) {
    const entry = exactDictionaryEntry(term);
    if (!entry) continue;
    const redirectEntry = (entry.redirectTargets ?? [])
      .map((target) => exactDictionaryEntry(target))
      .find(Boolean);
    const canonical = redirectEntry ?? entry;
    return {
      matchedInput: term,
      entry,
      canonical,
      term: normalizeJapaneseTerm(canonical.term || entry.term || term),
      reading: primaryReading(canonical.reading || entry.reading || "")
    };
  }
  return null;
}

function learnedByTokenVariants(token = {}, known = learnedSet()) {
  return tokenLookupVariants(token).some((term) => known.has(term));
}

function knownKanjiSet() {
  const kanji = new Set();
  for (const term of state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean)) {
    for (const char of term) {
      if (hasKanji(char)) kanji.add(char);
    }
  }
  return kanji;
}

async function readabilityScoringContext() {
  const key = [
    state.knownTerms.map(normalizeJapaneseTerm).sort().join("\u0000"),
    dictionaryNormalizationSignature(),
    state.cards.length
  ].join("\u0002");
  const now = Date.now();
  if (readabilityContextCache && readabilityContextCacheKey === key && readabilityContextCacheExpires > now) return readabilityContextCache;
  const events = await eventLog.recent(1000).catch(() => []);
  const lookupCounts = new Map();
  const exportCounts = new Map();
  for (const event of events) {
    const term = normalizeJapaneseTerm(event.payload?.term || event.payload?.dictionaryForm || event.payload?.expression || "");
    if (!term) continue;
    if (event.type === "lookup.performed") lookupCounts.set(term, (lookupCounts.get(term) ?? 0) + 1);
    if (event.type === "anki.exported") exportCounts.set(term, (exportCounts.get(term) ?? 0) + 1);
  }
  readabilityContextCacheKey = key;
  readabilityContextCacheExpires = now + 10000;
  readabilityContextCache = {
    knownKanji: knownKanjiSet(),
    lookupCounts,
    exportCounts,
    lookupCache: new Map(),
    hideInferredReadableFurigana: Boolean(state.reader?.hideInferredReadableFurigana)
  };
  return readabilityContextCache;
}

function readabilityLookupForToken(token = {}, context = {}) {
  const variants = tokenLookupVariants(token).filter(Boolean);
  const cacheKey = variants.join("\u0001");
  if (context.lookupCache?.has(cacheKey)) return context.lookupCache.get(cacheKey);
  const merged = { entries: [], frequencies: [] };
  const seenEntries = new Set();
  const seenFrequencies = new Set();
  for (const term of variants) {
    const result = dictionaryService.lookup(term);
    for (const entry of result.entries ?? []) {
      const key = `${entry.dictionaryId}\u0001${entry.term}\u0001${entry.reading}`;
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
      merged.entries.push(entry);
    }
    for (const frequency of result.frequencies ?? []) {
      const key = `${frequency.dictionaryId}\u0001${frequency.displayValue}\u0001${frequency.value}`;
      if (seenFrequencies.has(key)) continue;
      seenFrequencies.add(key);
      merged.frequencies.push(frequency);
    }
  }
  context.lookupCache?.set(cacheKey, merged);
  return merged;
}

function scoreTokenReadability(token = {}, learned = false, context = {}) {
  if (token.authorRuby || token.authorRubyProtected) {
    return { status: "known", score: 100, reasons: ["author ruby"] };
  }
  if (learned) return { status: "known", score: 100, reasons: ["word bank"] };
  const surface = normalizeJapaneseTerm(token.surface ?? "");
  if (!surface || !hasKanji(surface) || token.pos === "\u8a18\u53f7") return { status: "unknown", score: 0, reasons: [] };

  let score = 0;
  const reasons = [];
  const kanji = [...surface].filter((char) => hasKanji(char));
  const knownKanji = kanji.filter((char) => context.knownKanji?.has(char)).length;
  const knownKanjiRatio = kanji.length ? knownKanji / kanji.length : 0;
  if (knownKanjiRatio >= 0.8) {
    score += 35;
    reasons.push("known kanji");
  } else if (knownKanjiRatio >= 0.5) {
    score += 18;
    reasons.push("partial kanji");
  }

  const lookup = readabilityLookupForToken(token, context);
  if ((lookup.entries?.length ?? 0) > 0) {
    score += 12;
    reasons.push("dictionary match");
  }

  const frequencyScore = bestFrequencyReadabilityScore(lookup.frequencies ?? []);
  if (frequencyScore.score > 0) {
    score += frequencyScore.score;
    reasons.push(frequencyScore.reason);
  }
  if (frequencyScore.rare) score -= 10;

  const variants = tokenLookupVariants(token);
  const lookupPenalty = Math.min(20, variants.reduce((total, term) => total + (context.lookupCounts?.get(term) ?? 0), 0) * 10);
  const exportPenalty = Math.min(25, variants.reduce((total, term) => total + (context.exportCounts?.get(term) ?? 0), 0) * 15);
  score -= lookupPenalty + exportPenalty;
  if (lookupPenalty > 0) reasons.push("recent lookup");
  if (exportPenalty > 0) reasons.push("recent export");

  if (token.posDetail1 === "\u56fa\u6709\u540d\u8a5e") {
    score -= 30;
    reasons.push("name uncertainty");
  }

  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    status: bounded >= 85 ? "inferred-readable" : "unknown",
    score: bounded,
    reasons: [...new Set(reasons)].slice(0, 4)
  };
}

function bestFrequencyReadabilityScore(frequencies = []) {
  let best = { score: 0, reason: "", rare: false };
  for (const frequency of frequencies) {
    const display = String(frequency.displayValue ?? frequency.value ?? "");
    const jlpt = display.match(/N([1-5])/i);
    if (jlpt) {
      const level = Number(jlpt[1]);
      const score = level >= 4 ? 40 : level === 3 ? 30 : level === 2 ? 18 : 10;
      if (score > best.score) best = { score, reason: `JLPT N${level}`, rare: false };
    }
    const numbers = [...display.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
    const rank = numbers.length ? Math.min(...numbers) : Number.POSITIVE_INFINITY;
    let score = 0;
    if (rank <= 1000) score = 40;
    else if (rank <= 5000) score = 34;
    else if (rank <= 10000) score = 28;
    else if (rank <= 25000) score = 18;
    else if (rank <= 50000) score = 8;
    if (score > best.score) best = { score, reason: "common frequency", rare: false };
    if (rank > 80000 && best.score === 0) best = { score: 0, reason: "", rare: true };
  }
  return best;
}

function normalizeReaderToken(token = {}, known = learnedSet(), authorRubyProtectedTerms = new Set()) {
  const surface = normalizeJapaneseTerm(token.surface ?? "");
  if (!surface) return token;
  if (token.authorRuby) {
    const lookupTerms = uniqueNormalizedTerms([surface, token.base, token.reading]);
    return {
      ...token,
      surface,
      base: normalizeJapaneseTerm(token.base || surface),
      dictionaryForm: normalizeJapaneseTerm(token.dictionaryForm || token.base || surface),
      displayReading: primaryReading(token.reading),
      dictionaryReading: primaryReading(token.dictionaryReading || token.reading),
      lookupTerms,
      eligible: false,
      learned: true
    };
  }

  const base = normalizeJapaneseTerm(token.base || surface);
  const protectedByAuthorRuby = isAuthorRubyProtectedToken({ ...token, surface, base }, authorRubyProtectedTerms);
  const canonical = canonicalDictionaryMatch([surface, base]);
  const dictionaryForm = canonical?.term || base || surface;
  const dictionaryReading = primaryReading(canonical?.reading || token.dictionaryReading || "");
  const displayReading = protectedByAuthorRuby ? "" : primaryReading(token.displayReading || token.reading || (canonical?.matchedInput === surface ? dictionaryReading : ""));
  const lookupTerms = uniqueNormalizedTerms([
    surface,
    base,
    dictionaryForm,
    canonical?.entry?.term,
    canonical?.canonical?.term,
    canonical?.entry?.redirectTargets ?? [],
    dictionaryReading
  ]);
  const next = {
    ...token,
    surface,
    base: dictionaryForm,
    dictionaryForm,
    reading: displayReading || dictionaryReading,
    displayReading: displayReading || dictionaryReading,
    dictionaryReading,
    lookupTerms
  };
  const learned = protectedByAuthorRuby || learnedByTokenVariants(next, known);
  return {
    ...next,
    authorRubyProtected: protectedByAuthorRuby,
    learned,
    eligible: hasKanji(surface) && !learned && !protectedByAuthorRuby && token.pos !== "\u8a18\u53f7"
  };
}

function mergeDictionaryCompounds(tokens = [], known = learnedSet()) {
  const merged = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.authorRuby || !hasKanji(token.surface)) {
      merged.push(token);
      continue;
    }

    let best = null;
    let surface = "";
    for (let end = index; end < Math.min(tokens.length, index + 5); end += 1) {
      const candidate = tokens[end];
      if (candidate.authorRuby || !candidate.surface || /[。、！？!?\s]/u.test(candidate.surface)) break;
      surface += candidate.surface;
      if (end === index || !hasKanji(surface)) continue;
      const match = bestDictionaryMatch(surface);
      if (match?.reading) best = { end, surface, match };
    }

    if (best) {
      const learned = known.has(best.surface) || known.has(best.match.term);
      merged.push({
        surface: best.surface,
        base: best.match.term || best.surface,
        reading: primaryReading(best.match.reading),
        pos: token.pos,
        posDetail1: token.posDetail1 ?? "",
        posDetail2: token.posDetail2 ?? "",
        posDetail3: token.posDetail3 ?? "",
        learned,
        start: token.start,
        end: tokens[best.end]?.end ?? token.end,
        eligible: hasKanji(best.surface) && !learned
      });
      index = best.end;
      continue;
    }

    merged.push(token);
  }
  return merged;
}

function bestDictionaryMatch(term = "") {
  const matches = lookupDictionary(term);
  return matches.find((entry) => normalizeJapaneseTerm(entry.term) === normalizeJapaneseTerm(term) && entry.reading) ?? matches.find((entry) => entry.reading);
}

function dictionaryAwareTokenStream(tokens = [], known = learnedSet(), authorRubyProtectedTerms = authorRubyProtectedTermsFromTokens(tokens)) {
  const merged = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.authorRuby || !hasKanji(token.surface) || isAuthorRubyProtectedToken(token, authorRubyProtectedTerms)) {
      merged.push(normalizeReaderToken(token, known, authorRubyProtectedTerms));
      continue;
    }

    let best = null;
    let surface = "";
    for (let end = index; end < Math.min(tokens.length, index + 6); end += 1) {
      const candidate = tokens[end];
      if (candidate.authorRuby || isAuthorRubyProtectedToken(candidate, authorRubyProtectedTerms) || isBoundaryToken(candidate)) break;
      surface += candidate.surface;
      if (end === index || !hasKanji(surface)) continue;
      const match = canonicalDictionaryMatch([surface]);
      if (match?.reading) best = { end, surface, match };
    }

    if (best) {
      const dictionaryForm = best.match.term || best.surface;
      const compound = normalizeReaderToken({
        surface: best.surface,
        base: dictionaryForm,
        dictionaryForm,
        reading: primaryReading(best.match.reading),
        displayReading: primaryReading(best.match.reading),
        dictionaryReading: primaryReading(best.match.reading),
        lookupTerms: uniqueNormalizedTerms([best.surface, dictionaryForm, best.match.entry?.term, best.match.canonical?.term]),
        pos: token.pos,
        posDetail1: token.posDetail1 ?? "",
        posDetail2: token.posDetail2 ?? "",
        posDetail3: token.posDetail3 ?? "",
        start: token.start,
        end: tokens[best.end]?.end ?? token.end
      }, known, authorRubyProtectedTerms);
      merged.push(compound);
      index = best.end;
      continue;
    }

    merged.push(normalizeReaderToken(token, known, authorRubyProtectedTerms));
  }
  return merged;
}

function authorRubyProtectedTermsFromTokens(tokens = []) {
  const terms = new Set();
  for (const token of tokens) {
    const surface = normalizeJapaneseTerm(token.surface ?? "");
    if (!token.authorRuby || !surface || !hasKanji(surface)) continue;
    terms.add(surface);
  }
  return terms;
}

function authorRubyProtectedTermsFromText(text = "") {
  const terms = new Set();
  const markerPattern = /\[\[RUBY:([^|]*)\|[^\]]*\]\]/g;
  for (const match of String(text ?? "").matchAll(markerPattern)) {
    const surface = normalizeJapaneseTerm(decodeURIComponent(match[1] ?? ""));
    if (surface && hasKanji(surface)) terms.add(surface);
  }
  return terms;
}

function normalizeAuthorRubyProtectedTerms(terms = new Set()) {
  return new Set([...terms].map(normalizeJapaneseTerm).filter((term) => term && hasKanji(term)));
}

function isAuthorRubyProtectedToken(token = {}, authorRubyProtectedTerms = new Set()) {
  if (!authorRubyProtectedTerms?.size) return false;
  const surface = normalizeJapaneseTerm(token.surface ?? "");
  const base = normalizeJapaneseTerm(token.base ?? "");
  return Boolean((surface && authorRubyProtectedTerms.has(surface)) || (base && authorRubyProtectedTerms.has(base)));
}

function renderRubyPages(tokens, charLimit = 850) {
  const pages = [];
  let html = "";
  let count = 0;

  for (const token of tokens) {
    html += tokenToHtml(token);
    count += token.surface.length;
    const shouldBreak = count >= charLimit && /[。！？!?\n]/u.test(token.surface);
    const hardBreak = count >= charLimit * 1.35;
    if (shouldBreak || hardBreak) {
      pages.push(html);
      html = "";
      count = 0;
    }
  }

  if (html) pages.push(html);
  return pages.length > 0 ? pages : [""];
}

function renderRubyLinePages(tokens, charLimit = 850) {
  const pages = [];
  let page = "";
  let line = "";
  let count = 0;

  for (const token of tokens) {
    line += tokenToHtml(token);
    count += token.surface.length;
    if (/[。！？!?\n]/u.test(token.surface)) {
      page += `<p class="book-line">${line}</p>`;
      line = "";
    }
    if (count >= charLimit && !line) {
      pages.push(page);
      page = "";
      count = 0;
    }
  }
  if (line.trim()) page += `<p class="book-line">${line}</p>`;
  if (page.trim()) pages.push(page);
  return pages.length > 0 ? pages : [""];
}

async function renderTextBlock(text) {
  const normalizedTokens = await analyzeReaderTokenStream(text);
  return normalizedTokens.map(tokenToHtml).join("");
}

async function renderTextLinesBlock(text) {
  if (!hasJapaneseText(text)) return renderPlainTextLines(text);
  const normalizedTokens = await analyzeReaderTokenStream(text);
  const normalizedLines = [];
  let normalizedLine = "";
  for (const token of normalizedTokens) {
    normalizedLine += tokenToHtml(token);
    if (/[\u3002\uff01\uff1f!?\n]/u.test(token.surface)) {
      if (normalizedLine.trim()) normalizedLines.push(`<p class="book-line">${normalizedLine}</p>`);
      normalizedLine = "";
    }
  }
  if (normalizedLine.trim()) normalizedLines.push(`<p class="book-line">${normalizedLine}</p>`);
  return normalizedLines.join("");
}

function renderPlainTextLines(text = "") {
  return text
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="book-line">${escapeHtml(line)}</p>`)
    .join("");
}

async function analyzeReaderTokenStream(text, options = {}) {
  const tokenizer = await getTokenizer();
  const known = await learnedVariantSet();
  const readabilityContext = await readabilityScoringContext();
  const authorRubyProtectedTerms = normalizeAuthorRubyProtectedTerms(options.authorRubyProtectedTerms ?? authorRubyProtectedTermsFromText(text));
  const key = readerTokenCacheKey(text, authorRubyProtectedTerms);
  let normalizedTokens = readerTokenCache.get(key);
  if (!normalizedTokens && options.cacheDir) {
    normalizedTokens = await readPersistentReaderTokens(options.cacheDir, key);
    if (normalizedTokens) rememberReaderTokens(key, normalizedTokens);
  }
  if (!normalizedTokens) {
    normalizedTokens = dictionaryAwareTokenStream(readerRenderTokens(text, tokenizer, new Set()), new Set(), authorRubyProtectedTerms);
    rememberReaderTokens(key, normalizedTokens);
    if (options.cacheDir) await writePersistentReaderTokens(options.cacheDir, key, normalizedTokens);
  }
  return applyLearnedState(normalizedTokens, known, readabilityContext);
}

function applyLearnedState(tokens = [], known = learnedSet(), readabilityContext = {}) {
  return tokens.map((token) => {
    if (token.authorRuby || token.authorRubyProtected) {
      return {
        ...token,
        learned: true,
        eligible: false,
        readabilityStatus: "known",
        readabilityScore: 100,
        readabilityReasons: token.authorRuby ? ["author ruby"] : ["author ruby protected"]
      };
    }
    const learned = learnedByTokenVariants(token, known);
    const readability = scoreTokenReadability(token, learned, readabilityContext);
    const inferredReadable = readability.status === "inferred-readable";
    const eligible = hasKanji(token.surface) &&
      !learned &&
      token.pos !== "\u8a18\u53f7" &&
      !(inferredReadable && readabilityContext.hideInferredReadableFurigana);
    return {
      ...token,
      learned,
      readabilityStatus: readability.status,
      readabilityScore: readability.score,
      readabilityReasons: readability.reasons,
      eligible
    };
  });
}

function readableSuggestionsFromTokens(tokens = [], limit = 20) {
  const byTerm = new Map();
  for (const token of tokens) {
    if (token.authorRuby || token.authorRubyProtected) continue;
    if (token.readabilityStatus !== "inferred-readable") continue;
    const term = normalizeJapaneseTerm(token.dictionaryForm || token.base || token.surface);
    if (!term || byTerm.has(term)) continue;
    byTerm.set(term, {
      expression: term,
      surface: token.surface,
      dictionaryForm: term,
      reading: token.dictionaryReading || token.reading || token.displayReading || "",
      readabilityStatus: token.readabilityStatus,
      readabilityScore: token.readabilityScore ?? 0,
      readabilityReasons: token.readabilityReasons ?? []
    });
  }
  return [...byTerm.values()]
    .sort((a, b) => Number(b.readabilityScore ?? 0) - Number(a.readabilityScore ?? 0) || a.expression.localeCompare(b.expression, "ja"))
    .slice(0, limit);
}

async function readableSuggestionsFromText(text = "", limit = 20) {
  if (!hasJapaneseText(text)) return [];
  const tokens = await analyzeReaderTokenStream(text);
  return readableSuggestionsFromTokens(tokens, limit);
}

async function readabilityForLookupTerm(term = "", lookupResult = {}) {
  const normalized = normalizeJapaneseTerm(term);
  const primaryEntry = lookupResult.entries?.[0];
  const context = await readabilityScoringContext();
  const token = {
    surface: normalized || primaryEntry?.term || "",
    base: primaryEntry?.term || normalized,
    dictionaryForm: primaryEntry?.term || normalized,
    displayReading: primaryEntry?.reading || "",
    dictionaryReading: primaryEntry?.reading || "",
    lookupTerms: uniqueNormalizedTerms([normalized, lookupResult.queryTerms ?? [], primaryEntry?.term, primaryEntry?.reading]),
    pos: "",
    posDetail1: ""
  };
  const known = learnedByTokenVariants(token, await learnedVariantSet());
  const readability = scoreTokenReadability(token, known, context);
  return {
    status: readability.status,
    score: readability.score,
    reasons: readability.reasons
  };
}

async function renderReaderTextLines(text, options = {}) {
  if (!hasJapaneseText(text)) return renderPlainTextLines(text);

  const tokens = await analyzeReaderTokenStream(text, options);

  const lines = [];
  let line = "";
  let quoteDepth = 0;
  for (const token of tokens) {
    if (token.surface.includes("\u300c") && line.trim()) {
      lines.push(`<p class="book-line">${line}</p>`);
      line = "";
    }
    line += tokenToHtml(token);
    let closesQuote = false;
    for (const char of token.surface) {
      if (char === "\u300c") quoteDepth += 1;
      if (char === "\u300d") {
        quoteDepth = Math.max(0, quoteDepth - 1);
        closesQuote = true;
      }
    }
    if (closesQuote && line.trim()) {
      lines.push(`<p class="book-line">${line}</p>`);
      line = "";
      continue;
    }
    if (quoteDepth === 0 && /[\u3002\uff01\uff1f!?\n]/u.test(token.surface)) {
      if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
      line = "";
    }
  }
  if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
  return lines.join("");
}

function readerRenderTokens(text, tokenizer, known) {
  const tokens = [];
  const markerPattern = /\[\[RUBY:([^|]*)\|([^\]]*)\]\]/g;
  let lastIndex = 0;
  const pushTextTokens = (value, absoluteStart) => {
    if (!value) return;
    let offset = 0;
    tokens.push(...tokenizer.tokenize(value).map((token) => {
      const localStart = value.indexOf(token.surface_form, offset);
      if (localStart >= 0) offset = localStart + token.surface_form.length;
      const surface = normalizeJapaneseTerm(token.surface_form);
      const base = tokenBase(token);
      const reading = tokenReading(token);
      const learned = isLearnedToken(token, known);
      const start = localStart >= 0 ? absoluteStart + localStart : absoluteStart + offset;
      return {
        surface,
        base,
        reading,
        pos: token.pos,
        posDetail1: token.pos_detail_1 ?? "",
        posDetail2: token.pos_detail_2 ?? "",
        posDetail3: token.pos_detail_3 ?? "",
        learned,
        start,
        end: start + surface.length,
        eligible: hasKanji(surface) && !learned && token.pos !== "記号"
      };
    }));
  };

  for (const match of text.matchAll(markerPattern)) {
    pushTextTokens(text.slice(lastIndex, match.index), lastIndex);
    const surface = decodeURIComponent(match[1] ?? "");
    const reading = decodeURIComponent(match[2] ?? "");
    tokens.push({
      surface,
      base: surface,
      reading,
      authorRuby: true,
      html: authorRubyHtml(surface, reading),
      eligible: false,
      learned: true,
      start: match.index,
      end: match.index + match[0].length
    });
    lastIndex = match.index + match[0].length;
  }
  pushTextTokens(text.slice(lastIndex), lastIndex);
  return tokens;
}

function joinTextBlocks(blocks = []) {
  let text = "";
  let quoteDepth = 0;

  for (const block of blocks) {
    const value = typeof block === "string" ? block : block.text ?? "";
    if (!value.trim()) continue;
    if (text && quoteDepth === 0) text += "\n";
    text += value;
    for (const char of value) {
      if (char === "「") quoteDepth += 1;
      if (char === "」") quoteDepth = Math.max(0, quoteDepth - 1);
    }
  }

  return text;
}

function splitLongTextBlock(block, charLimit) {
  if (block.type !== "text" || block.text.length <= charLimit) return [block];
  const chunks = [];
  let current = "";
  const parts = block.text
    .split(/\n+|(?<=[\u3002\uff01\uff1f.!?])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts.length > 0 ? parts : [block.text]) {
    if (part.length > charLimit) {
      if (current) {
        chunks.push({ type: "text", text: current });
        current = "";
      }
      for (let index = 0; index < part.length; index += charLimit) {
        chunks.push({ type: "text", text: part.slice(index, index + charLimit) });
      }
      continue;
    }
    if (current && current.length + part.length > charLimit) {
      chunks.push({ type: "text", text: current });
      current = "";
    }
    current = current ? `${current}\n${part}` : part;
  }

  if (current) chunks.push({ type: "text", text: current });
  return chunks;
}

async function renderStructuredBlocks(blocks = [], options = {}) {
  const rendered = [];
  let textBuffer = [];

  async function flushText() {
    if (textBuffer.length === 0) return;
    rendered.push(`<div class="book-lines">${await renderReaderTextLines(joinTextBlocks(textBuffer), options)}</div>`);
    textBuffer = [];
  }

  for (const block of blocks) {
    if (block.type === "page") {
      await flushText();
      if (block.pdfSrc) {
        rendered.push(renderPdfPageFigure(block));
        continue;
      }
      const pageNumber = block.pageNumber ? ` data-pdf-page="${escapeHtml(String(block.pageNumber))}"` : "";
      rendered.push(`<section class="pdf-page-block"${pageNumber}>${await renderStructuredBlocks(block.blocks ?? [], options)}</section>`);
      continue;
    }
    if (block.type === "image") {
      await flushText();
      rendered.push(`<figure class="book-image"><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? "")}" loading="lazy"></figure>`);
      continue;
    }
    if (block.type === "link" && block.href && block.text?.trim()) {
      await flushText();
      const isExternal = /^https?:\/\//i.test(block.href);
      const attrs = isExternal ? `href="${escapeHtml(block.href)}" target="_blank" rel="noreferrer"` : `href="#" data-epub-href="${escapeHtml(block.href)}"`;
      rendered.push(`<p class="book-line"><a class="book-link" ${attrs}>${escapeHtml(block.text)}</a></p>`);
      continue;
    }
    if (block.type === "text" && block.text?.trim()) {
      textBuffer.push(block.text);
    }
  }
  await flushText();
  return rendered.join("");
}

async function renderStructuredPages(blocks = [], charLimit = 850, options = {}) {
  const pages = [];
  let pageBlocks = [];
  let count = 0;

  for (const originalBlock of blocks) {
    const expandedBlocks = splitLongTextBlock(originalBlock, charLimit);
    for (const block of expandedBlocks) {
    if (block.type === "page") {
      if (pageBlocks.length > 0) {
        pages.push(await renderStructuredBlocks(pageBlocks, options));
        pageBlocks = [];
        count = 0;
      }
      pages.push(block.pdfSrc ? renderPdfPageFigure(block) : await renderStructuredBlocks(block.blocks ?? [], options));
      continue;
    }
    if (block.type === "image") {
      if (pageBlocks.length > 0) {
        pages.push(await renderStructuredBlocks(pageBlocks, options));
        pageBlocks = [];
        count = 0;
      }
      pages.push(await renderStructuredBlocks([block], options));
      continue;
    }
    const blockLength = block.type === "text" || block.type === "link" ? block.text.length : 220;
    if (pageBlocks.length > 0 && count + blockLength > charLimit) {
      pages.push(await renderStructuredBlocks(pageBlocks, options));
      pageBlocks = [];
      count = 0;
    }
    pageBlocks.push(block);
    count += blockLength;
    }
  }

  if (pageBlocks.length > 0) pages.push(await renderStructuredBlocks(pageBlocks, options));
  return pages.length > 0 ? pages : [""];
}

function fallbackChapters(document) {
  if (
    Array.isArray(document.chapters) &&
    document.chapters.some((chapter) => Array.isArray(chapter.blocks) && chapter.blocks.some((block) => block.type === "text" || block.type === "image" || block.type === "page" || block.type === "link"))
  ) {
    return document.chapters.filter((chapter) => Array.isArray(chapter.blocks) && chapter.blocks.length > 0);
  }
  return [
    {
      id: "chapter-1",
      title: "Document",
      blocks: splitSentences(document.text).map((sentence) => ({ type: "text", text: sentence }))
    }
  ];
}

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function imageSvg(expression, reading) {
  const label = escapeHtml(expression);
  const subLabel = escapeHtml(reading);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#f5f1e8"/>
  <rect x="64" y="64" width="832" height="412" rx="8" fill="#fffdf8" stroke="#2f5d50" stroke-width="6"/>
  <text x="480" y="250" text-anchor="middle" font-family="Yu Mincho, Noto Serif JP, serif" font-size="112" fill="#1f2a28">${label}</text>
  <text x="480" y="334" text-anchor="middle" font-family="Yu Gothic, Noto Sans JP, sans-serif" font-size="42" fill="#57645f">${subLabel}</text>
</svg>`;
}

function mapCardFields(template, card) {
  const fields = {};
  for (const field of template.fields) {
    const normalized = field.toLowerCase();
    if (normalized.includes("expression") || normalized.includes("word") || normalized.includes("vocab")) fields[field] = card.expression;
    else if (normalized.includes("reading") || normalized.includes("furigana")) fields[field] = card.reading;
    else if (normalized.includes("sentence")) fields[field] = card.sentence;
    else if (normalized.includes("meaning") || normalized.includes("definition")) fields[field] = card.meaning;
    else if (normalized.includes("audio") || normalized.includes("sound")) fields[field] = card.audioPrompt;
    else if (normalized.includes("image") || normalized.includes("picture")) fields[field] = card.imagePath;
    else if (normalized.includes("source")) fields[field] = card.source;
    else if (normalized.includes("base") || normalized.includes("dictionary")) fields[field] = card.dictionaryForm;
    else fields[field] = "";
  }
  return fields;
}

async function ankiConnect(action, params = {}) {
  const response = await fetch(state.anki.connectUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params })
  });
  if (!response.ok) throw new Error(`AnkiConnect request failed with ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

async function ankiConnectBatched(action, key, values, batchSize = 150) {
  const results = [];
  for (const batch of chunkArray(values, batchSize)) {
    const result = await ankiConnect(action, { [key]: batch });
    if (Array.isArray(result)) results.push(...result);
  }
  return results;
}

function cleanAnkiField(value = "") {
  return htmlToText(String(value))
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJapaneseCandidates(value = "") {
  return cleanAnkiField(value)
    .split(/[。！？!?\n\r,，、;；/|]/u)
    .map((part) => normalizeJapaneseTerm(part))
    .filter((part) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(part))
    .map((part) => part.replace(/^[^\u3040-\u30ff\u3400-\u9fff]+|[^\u3040-\u30ff\u3400-\u9fff]+$/gu, ""))
    .filter(Boolean);
}

function scoreFieldName(fieldName = "") {
  const normalized = fieldName.toLowerCase();
  if (/(expression|vocab|vocabulary|word|term|target|kanji|japanese|front)/.test(normalized)) return 0;
  if (/(sentence|例文|context|cloze)/.test(normalized)) return 3;
  if (/(meaning|definition|english|gloss|audio|image|picture|source|url|note)/.test(normalized)) return 8;
  return 5;
}

function extractTermsFromNotes(notes, preferredFields = [], options = {}) {
  const terms = new Map();
  const fieldPriority = [
    ...preferredFields,
    "Expression",
    "Vocab",
    "Vocabulary",
    "Word",
    "Term",
    "Kanji",
    "Japanese",
    "Front"
  ];

  for (const note of notes) {
    const fields = note.fields ?? {};
    const values = [];
    for (const fieldName of fieldPriority) {
      if (fields[fieldName]?.value) values.push({ fieldName, value: fields[fieldName].value });
    }
    values.push(
      ...Object.entries(fields)
        .map(([fieldName, field]) => ({ fieldName, value: field?.value }))
        .filter((field) => field.value)
    );

    const candidates = values
      .flatMap(({ fieldName, value }) =>
        extractJapaneseCandidates(value).map((candidate) => ({
          candidate,
          score: scoreFieldName(fieldName) + Math.max(0, candidate.length - 18)
        }))
      )
      .filter(({ candidate }) => candidate.length <= 60)
      .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length);

    if (candidates[0]) {
      const term = normalizeJapaneseTerm(candidates[0].candidate);
      terms.set(term, {
        term,
        noteId: Number(note.noteId ?? note.id),
        modelName: note.modelName ?? "",
        deckName: note.deckName ?? ""
      });
    }
  }

  return options.withMetadata ? [...terms.values()] : [...terms.keys()];
}

function summarizeRetention(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { cards: 0, reviews: 0, lapses: 0, matureCards: 0, averageInterval: 0 };
  }

  const reviews = cards.reduce((total, card) => total + Number(card.reps ?? 0), 0);
  const lapses = cards.reduce((total, card) => total + Number(card.lapses ?? 0), 0);
  const matureCards = cards.filter((card) => Number(card.interval ?? 0) >= 21).length;
  const averageInterval = Math.round(cards.reduce((total, card) => total + Number(card.interval ?? 0), 0) / cards.length);
  return { cards: cards.length, reviews, lapses, matureCards, averageInterval };
}

function logLearningEvent(type, payload = {}) {
  eventLog.append(type, payload).catch((error) => {
    console.warn(`Learning event not written: ${error.message}`);
  });
}

function syncDiagnostics() {
  const documents = state.documents ?? [];
  let uploadableFiles = 0;
  let missingFiles = 0;
  for (const document of documents) {
    if (!document.sourcePath) {
      missingFiles += 1;
      continue;
    }
    if (document.sourcePath.startsWith("/media/")) {
      const localPath = path.join(mediaDir, document.sourcePath.replace(/^\/media\//, ""));
      if (existsSync(localPath)) uploadableFiles += 1;
      else missingFiles += 1;
    }
  }
  return {
    documents: documents.length,
    uploadableFiles,
    missingFiles,
    vectorIndexStale: Boolean(state.ml?.indexStale)
  };
}

app.get("/api/state", (req, res) => {
  const sync = publicSyncSettings(state.sync);
  res.json({
    documents: state.documents.map(({ text, chapters, ...document }) => document),
    knownTermsCount: state.knownTerms.length,
    trash: {
      documents: state.trash.documents.map(({ text, chapters, ...document }) => document),
      knownTerms: state.trash.knownTerms
    },
    dictionaries: dictionaryService.listMetadata(),
    dictionarySettings: state.dictionarySettings,
    reader: state.reader,
    progress: state.progress,
    cards: state.cards,
    anki: state.anki,
    media: state.media,
    ai: state.ai,
    ml: publicMlSettings(state.ml),
    sync: { ...sync, diagnostics: syncDiagnostics() },
    templates: state.templates
  });
});

app.get("/api/known-terms", (req, res) => {
  const query = normalizeJapaneseTerm(String(req.query.q ?? "")).toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sort = String(req.query.sort ?? "gojuon");
  const dictionaryId = String(req.query.dictionaryId ?? "");
  const filtered = state.knownTerms.filter((term) => !query || term.toLowerCase().includes(query));
  const terms = sortKnownTerms(filtered, sort)
    .slice(offset, offset + limit)
    .slice(0, limit)
    .map((term) => ({ term, dictionaryEntries: lookupCachedWordBankMeaning(term, dictionaryId) }));

  res.json({ total: filtered.length, allTotal: state.knownTerms.length, offset, limit, sort, terms });
});

app.get("/api/cache/wordbank-meanings/status", (req, res) => {
  const dictionaryId = String(req.query.dictionaryId ?? "") || selectedWordBankDictionaryId();
  res.json(wordBankMeaningCacheStatus(dictionaryId));
});

app.post("/api/cache/wordbank-meanings/rebuild", async (req, res, next) => {
  try {
    const dictionaryId = String(req.body?.dictionaryId ?? "") || selectedWordBankDictionaryId();
    const result = await rebuildWordBankMeaningCache(dictionaryId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function updateReaderSettings(req, res) {
  state.reader = {
    ...structuredClone(initialState.reader),
    ...(state.reader ?? {}),
    hideInferredReadableFurigana: Boolean(req.body?.hideInferredReadableFurigana)
  };
  clearDocumentCache();
  invalidateReadabilityContext();
  await saveState();
  res.json({ reader: state.reader });
}

app.patch("/api/reader/settings", updateReaderSettings);
app.post("/api/reader/settings", updateReaderSettings);

app.post("/api/reader/readable-suggestion/dismiss", async (req, res) => {
  const term = normalizeJapaneseTerm(req.body?.term ?? "");
  if (!term) return res.status(400).json({ error: "No vocabulary selected." });
  logLearningEvent("reader.readable-suggestion-dismissed", {
    term,
    documentId: String(req.body?.documentId ?? "")
  });
  res.json({ dismissed: true, term });
});

app.get("/api/sync/status", (req, res) => {
  res.json({ ...syncService.status(), diagnostics: syncDiagnostics() });
});

app.post("/api/sync/settings", async (req, res, next) => {
  try {
    res.json(await syncService.updateSettings(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync/sign-in", async (req, res, next) => {
  try {
    res.json(await syncService.signIn(req.body ?? {}));
  } catch (error) {
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveState();
    next(error);
  }
});

app.post("/api/sync/sign-out", async (req, res, next) => {
  try {
    res.json(await syncService.signOut());
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync/push", async (req, res, next) => {
  try {
    res.json(await syncService.push());
  } catch (error) {
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveState();
    next(error);
  }
});

app.post("/api/sync/pull", async (req, res, next) => {
  try {
    res.json(await syncService.pull());
  } catch (error) {
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveState();
    next(error);
  }
});

app.post("/api/sync/run", async (req, res, next) => {
  try {
    res.json(await syncService.syncNow());
  } catch (error) {
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveState();
    next(error);
  }
});

app.post("/api/sync/cleanup-deleted", async (req, res, next) => {
  try {
    res.json(await syncService.cleanupDeletedRemoteItems());
  } catch (error) {
    state.sync = normalizeSyncSettings({ ...(state.sync ?? {}), lastError: error.message, status: "error" });
    await saveState();
    next(error);
  }
});

app.post("/api/documents", upload.single("book"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const id = crypto.randomUUID();
    const imported = await extractDocument(req.file, id);
    if (!imported.text) return res.status(422).json({ error: "Could not extract text from this file." });
    const filename = repairMojibake(decodeUploadName(req.file.originalname));
    const type = path.extname(filename).replace(".", "").toLowerCase() || "text";
    const duplicate = state.documents.find((item) =>
      item.filename === filename &&
      item.type === type &&
      item.text?.length === imported.text.length
    );
    if (duplicate) return res.status(409).json({ error: "Duplicate copy", document: { id: duplicate.id, title: duplicate.title } });

    const document = {
      id,
      title: repairMojibake(req.body.title?.trim() || imported.title || path.parse(filename).name),
      author: repairMojibake(imported.author || ""),
      filename,
      type,
      createdAt: new Date().toISOString(),
      coverPath: imported.coverPath ?? "",
      sourcePath: imported.sourcePath ?? "",
      text: imported.text,
      chapters: imported.chapters
    };

    state.documents.unshift(document);
    state.progress[document.id] = { percentage: 0, updatedAt: new Date().toISOString() };
    clearDocumentCache();
    markMlIndexStale("Imported book added new source text.");
    await saveState();
    logLearningEvent("document.imported", { documentId: document.id, title: document.title, type: document.type });
    res.status(201).json({ document: { ...document, text: undefined } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/reorder", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  if (ids.length === 0) return res.status(400).json({ error: "Document order is required." });
  const order = new Map(ids.map((id, index) => [id, index]));
  state.documents.sort((a, b) => {
    const aOrder = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bOrder = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
  markMlIndexStale("Book order changed.");
  await saveState();
  const documents = state.documents.map(({ text, chapters, ...document }) => document);
  res.json({ documents });
});

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/documents/:id/ingest-stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  try {
    const document = state.documents.find((item) => item.id === req.params.id);
    if (!document) {
      writeSse(res, "error", { error: "Document not found." });
      res.end();
      return;
    }
    const result = await ensureDocumentIngestionCache(document, {
      force: req.query.force === "1",
      onProgress: (progress) => writeSse(res, "progress", progress)
    });
    if (result.state === "dictionary-stale" && result.rebuilt) {
      markMlIndexFresh();
      await saveState();
    }
    writeSse(res, "done", {
      state: result.state,
      rebuilt: result.rebuilt,
      deferred: Boolean(result.deferred),
      reason: result.reason,
      indexStale: Boolean(state.ml?.indexStale)
    });
    res.end();
  } catch (error) {
    writeSse(res, "error", { error: error.message });
    res.end();
  }
});

app.get("/api/documents/:id", async (req, res, next) => {
  try {
    const document = state.documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found." });
    const includeCandidates = req.query.candidates === "1" || document.text.length < 20000;
    const ingestion = await ensureDocumentIngestionCache(document);
    const tokenCacheDir = ingestion.cacheDir;

    const cacheKey = documentCacheKey(document);
    let cached = documentResponseCache.get(cacheKey);

    if (!cached) {
      let analysis;
      const getAnalysis = async () => {
        analysis ??= await analyzeDocument(document);
        return analysis;
      };
      const chapters = fallbackChapters(document);
      const hasImageBlocks = chapters.some((chapter) => chapter.blocks?.some((block) => block.type === "image"));
      const hasPageBlocks = chapters.some((chapter) => chapter.blocks?.some((block) => block.type === "page"));
      let responseChapters;

      if (!hasImageBlocks && !hasPageBlocks && chapters.length <= 1 && document.text.length <= 20000) {
        analysis = await getAnalysis();
        responseChapters = [{ id: chapters[0]?.id ?? "chapter-1", title: chapters[0]?.title ?? "Document", html: renderRubyLines(analysis.tokens), pages: renderRubyLinePages(analysis.tokens) }];
      } else {
        const renderedChapters = [];
        for (const [index, chapter] of chapters.entries()) {
          const chapterTitle = chapter.title || `Chapter ${index + 1}`;
          const renderBlocks = stripChapterTitleFromBlocks(chapter.blocks ?? [], chapterTitle);
          const chapterText = blocksToText(renderBlocks);
          const chapterHasPageBlocks = renderBlocks.some((block) => block.type === "page");
          const chapterHasImageBlocks = renderBlocks.some((block) => block.type === "image");
          const rawPages = await renderStructuredPages(renderBlocks, 850, {
            cacheDir: tokenCacheDir,
            authorRubyProtectedTerms: authorRubyProtectedTermsFromText(chapterText)
          });
          let headingPlaced = false;
          const pages = rawPages.map((pageHtml) => {
            const includeHeading = !headingPlaced && !isImageOnlyPageHtml(pageHtml);
            if (includeHeading) headingPlaced = true;
            return wrapReaderPage(pageHtml, chapterTitle, includeHeading);
          });
          const rawHtml = rawPages.join("");
          const html = `${chapterHeadingHtml(chapterTitle)}${rawHtml}`;
          renderedChapters.push({
            id: chapter.id || `chapter-${index + 1}`,
            title: chapterTitle,
            href: chapter.href ?? "",
            html,
            pages
          });
        }
        const visibleChapters = renderedChapters.filter((chapter) => chapter.html.trim());
        const fallbackHtml = visibleChapters.length > 0 ? "" : renderRuby((await getAnalysis()).tokens);
        responseChapters = visibleChapters.length > 0 ? visibleChapters : [{ id: "chapter-1", title: "Document", html: fallbackHtml, pages: renderRubyPages(analysis.tokens) }];
      }
      const missingFrontImages = (await frontImagePaths(document)).filter((imagePath) =>
        !responseChapters.some((chapter) =>
          String(chapter.html ?? "").includes(imagePath) ||
          (chapter.pages ?? []).some((pageHtml) => String(pageHtml ?? "").includes(imagePath))
        )
      );
      const frontImageHtml = missingFrontImages.map((imagePath) => renderImageFigure(imagePath, document.title)).join("");
      const pages = [
        ...missingFrontImages.map((imagePath) => ({
          chapterId: responseChapters[0]?.id ?? "chapter-1",
          html: wrapReaderPage(renderImageFigure(imagePath, document.title), responseChapters[0]?.title ?? document.title)
        })),
        ...responseChapters.flatMap((chapter) => chapter.pages.map((html, pageIndex) => ({
          chapterId: chapter.id,
          html: wrapReaderPage(html, chapter.title, pageIndex === 0)
        })))
      ];
      cached = {
        id: document.id,
        filename: document.filename,
        createdAt: document.createdAt,
        coverPath: document.coverPath ?? "",
        author: document.author ?? "",
        sourcePath: document.sourcePath ?? "",
        html: frontImageHtml,
        pages,
        chapters: responseChapters.map(({ id, title, href }) => ({ id, title, href: href ?? "" })),
        textLength: document.text.length
      };
      documentResponseCache.set(cacheKey, cached);
    }

    let candidates = [];
    let readabilitySuggestions = [];
    const pageIndex = Number(req.query.page);
    if (includeCandidates) {
      if (Number.isInteger(pageIndex) && cached.pages[pageIndex]) {
        candidates = (await analyzeText(pageHtmlToCandidateText(cached.pages[pageIndex].html))).candidates.map(enrichCandidate);
      } else {
        candidates = (await analyzeDocument(document)).candidates.map(enrichCandidate);
      }
      candidates = await mlService.rankCandidates(document.id, candidates);
    }
    const suggestionPageIndex = Number.isInteger(pageIndex) && cached.pages[pageIndex] ? pageIndex : 0;
    if (cached.pages[suggestionPageIndex]) {
      readabilitySuggestions = await readableSuggestionsFromText(pageHtmlToCandidateText(cached.pages[suggestionPageIndex].html), 20);
    }

    res.json({
      ...cached,
      candidates,
      readabilitySuggestions,
      title: document.title,
      progress: state.progress[document.id] ?? { percentage: 0 }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/documents/:id", async (req, res) => {
  const document = state.documents.find((item) => item.id === req.params.id);
  if (!document) return res.status(404).json({ error: "Document not found." });

  const title = req.body.title?.trim();
  if (!title) return res.status(400).json({ error: "Title is required." });

  document.title = title;
  document.updatedAt = new Date().toISOString();
  clearDocumentCache();
  markMlIndexStale("Book metadata changed.");
  await saveState();
  const { text, chapters, ...publicDocument } = document;
  res.json(publicDocument);
});

app.delete("/api/documents/:id", async (req, res) => {
  const index = state.documents.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Document not found." });

  const [deleted] = state.documents.splice(index, 1);
  const trashIndex = state.trash.documents.findIndex((item) => item.id === deleted.id);
  const trashedDocument = { ...deleted, deletedAt: new Date().toISOString() };
  if (trashIndex >= 0) state.trash.documents.splice(trashIndex, 1, trashedDocument);
  else state.trash.documents.unshift(trashedDocument);
  clearDocumentCache();
  await saveState();
  res.json({ ok: true });
});

app.post("/api/trash/documents/:id/restore", async (req, res) => {
  const index = state.trash.documents.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Deleted book not found." });

  const [restored] = state.trash.documents.splice(index, 1);
  const { deletedAt, ...document } = restored;
  if (!state.documents.some((item) => item.id === document.id)) {
    state.documents.push(document);
  }
  clearDocumentCache();
  await saveState();
  const { text, chapters, ...publicDocument } = document;
  res.json({ document: publicDocument });
});

app.delete("/api/trash/documents/:id", async (req, res) => {
  const index = state.trash.documents.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Deleted book not found." });
  const [deleted] = state.trash.documents.splice(index, 1);
  clearDocumentCache();
  await deleteDocumentVectorsFromMlIndex(deleted.id);
  markMlIndexStale("Deleted book was permanently removed.");
  await saveState();
  res.json({ deleted: 1, documentId: deleted.id, total: state.trash.documents.length });
});

app.delete("/api/trash/documents", async (req, res) => {
  const deletedIds = state.trash.documents.map((document) => document.id).filter(Boolean);
  const deleted = state.trash.documents.length;
  state.trash.documents = [];
  clearDocumentCache();
  for (const id of deletedIds) await deleteDocumentVectorsFromMlIndex(id);
  if (deleted > 0) markMlIndexStale("Deleted books were permanently removed.");
  await saveState();
  res.json({ deleted, total: 0 });
});

app.post("/api/documents/:id/progress", async (req, res) => {
  const document = state.documents.find((item) => item.id === req.params.id);
  if (!document) return res.status(404).json({ error: "Document not found." });

  const percentage = Math.max(0, Math.min(100, Number(req.body.percentage) || 0));
  state.progress[document.id] = {
    percentage,
    page: Math.max(0, Number(req.body.page) || 0),
    mode: req.body.mode === "paged" ? "paged" : "scroll",
    chapterId: req.body.chapterId ? String(req.body.chapterId) : "",
    scrollTop: Math.max(0, Number(req.body.scrollTop) || 0),
    zoom: Math.max(75, Math.min(175, Number(req.body.zoom) || state.progress[document.id]?.zoom || 100)),
    highlights: req.body.highlights && typeof req.body.highlights === "object" ? req.body.highlights : state.progress[document.id]?.highlights ?? { pages: {}, scrollHtml: "" },
    bookmarks: Array.isArray(req.body.bookmarks) ? req.body.bookmarks.slice(0, 100) : state.progress[document.id]?.bookmarks ?? [],
    updatedAt: new Date().toISOString()
  };
  await saveState();
  logLearningEvent("reading.progress", {
    documentId: document.id,
    title: document.title,
    page: state.progress[document.id].page,
    chapterId: state.progress[document.id].chapterId,
    percentage
  });
  res.json(state.progress[document.id]);
});

app.post("/api/known-terms", upload.single("terms"), async (req, res) => {
  const incoming = req.file
    ? parseKnownTerms(req.file.buffer)
    : [
        ...(Array.isArray(req.body.terms) ? req.body.terms : []),
        req.body.term
      ].map(normalizeJapaneseTerm).filter(Boolean);
  if (incoming.length === 0) return res.status(400).json({ error: "No vocabulary provided." });
  const added = mergeKnownTerms(incoming);
  clearDocumentCache();
  invalidateReadabilityContext();
  if (added.length > 0) markMlIndexStale("Word Bank changed known-term coverage.");
  await saveState();
  const source = req.file ? "import" : String(req.body?.source ?? "manual");
  for (const term of added) {
    logLearningEvent("wordbank.added", { term, source });
    if (source === "readable-suggestion") {
      logLearningEvent("reader.readable-suggestion-added", {
        term,
        documentId: String(req.body?.documentId ?? "")
      });
    }
  }
  res.json({ imported: incoming.length, added: added.length, total: state.knownTerms.length });
});

app.delete("/api/known-terms", async (req, res) => {
  const body = req.body ?? {};
  const normalizedTerms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
  const terms = body.all === true
    ? normalizedTerms
    : Array.isArray(body.terms) ? body.terms.map(normalizeJapaneseTerm).filter(Boolean) : [];
  if (terms.length === 0) return res.status(400).json({ error: "No vocabulary selected." });
  const deletedTerms = moveKnownTermsToTrash(terms);
  const deleted = deletedTerms.length;
  clearDocumentCache();
  invalidateReadabilityContext();
  if (deleted > 0) markMlIndexStale("Word Bank changed known-term coverage.");
  await saveState();
  for (const term of deletedTerms) logLearningEvent("wordbank.deleted", { term });
  res.json({ deleted, total: state.knownTerms.length });
});

app.post("/api/known-terms/sync-anki", async (req, res, next) => {
  try {
    const normalizedTerms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
    const noteIdsByTerm = new Map();
    const allNoteIds = [];
    for (const term of normalizedTerms) {
      const noteIds = [...new Set((state.knownTermMeta?.[term]?.ankiNoteIds ?? []).map(Number).filter(Number.isFinite))];
      if (noteIds.length === 0) continue;
      noteIdsByTerm.set(term, noteIds);
      allNoteIds.push(...noteIds);
    }

    if (allNoteIds.length === 0) {
      return res.json({ checked: 0, removed: 0, total: state.knownTerms.length });
    }

    const existingNoteIds = new Set(await ankiService.existingNoteIds(allNoteIds));
    const removedTerms = [];
    for (const [term, noteIds] of noteIdsByTerm.entries()) {
      if (noteIds.some((noteId) => existingNoteIds.has(noteId))) continue;
      removedTerms.push(term);
    }

    if (removedTerms.length > 0) {
      moveKnownTermsToTrash(removedTerms, "anki-sync");
      clearDocumentCache();
      invalidateReadabilityContext();
      markMlIndexStale("Anki sync removed Word Bank terms.");
      await saveState();
    }
    logLearningEvent("wordbank.synced-anki", { checked: noteIdsByTerm.size, removed: removedTerms.length });

    res.json({
      checked: noteIdsByTerm.size,
      removed: removedTerms.length,
      terms: removedTerms,
      total: state.knownTerms.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/trash/known-terms/restore", async (req, res) => {
  const terms = Array.isArray(req.body.terms) ? req.body.terms.map(normalizeJapaneseTerm).filter(Boolean) : [];
  if (terms.length === 0) return res.status(400).json({ error: "No vocabulary selected." });
  const selected = new Set(terms);
  const activeTerms = new Set(state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean));
  const restoredTerms = [];
  const remainingTrash = [];

  for (const entry of state.trash.knownTerms) {
    const term = trashTermValue(entry);
    if (!term || !selected.has(term)) {
      remainingTrash.push(entry);
      continue;
    }
    if (!activeTerms.has(term)) {
      state.knownTerms.push(term);
      state.knownTermMeta[term] = trashTermMeta(entry);
      activeTerms.add(term);
      restoredTerms.push(term);
    }
  }

  state.trash.knownTerms = remainingTrash;
  if (restoredTerms.length > 0) invalidateWordBankMeaningCache();
  clearDocumentCache();
  invalidateReadabilityContext();
  if (restoredTerms.length > 0) markMlIndexStale("Word Bank changed known-term coverage.");
  await saveState();
  for (const term of restoredTerms) logLearningEvent("wordbank.restored", { term });
  res.json({ restored: restoredTerms.length, total: state.knownTerms.length });
});

app.delete("/api/trash/known-terms", async (req, res) => {
  const body = req.body ?? {};
  const selected = body.all === true
    ? new Set(state.trash.knownTerms.map((entry) => trashTermValue(entry)).filter(Boolean))
    : new Set(Array.isArray(body.terms) ? body.terms.map(normalizeJapaneseTerm).filter(Boolean) : []);
  if (selected.size === 0) return res.status(400).json({ error: "No deleted vocabulary selected." });
  const before = state.trash.knownTerms.length;
  state.trash.knownTerms = state.trash.knownTerms.filter((entry) => {
    const term = trashTermValue(entry);
    return !term || !selected.has(term);
  });
  const deleted = before - state.trash.knownTerms.length;
  if (deleted > 0) markMlIndexStale("Deleted vocabulary was permanently removed.");
  await saveState();
  res.json({ deleted, total: state.trash.knownTerms.length });
});

app.post("/api/templates", upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const raw = req.file.buffer.toString("utf8");
  let fields;
  try {
    const parsed = JSON.parse(raw);
    fields = parsed.fields ?? parsed.flds?.map((field) => field.name);
  } catch {
    fields = raw.split(/[\r\n,\t]/).map((field) => field.trim()).filter(Boolean);
  }

  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(422).json({ error: "Template must contain at least one field name." });
  }

  const template = {
    id: crypto.randomUUID(),
    name: req.body.name?.trim() || path.parse(req.file.originalname).name,
    fields
  };
  state.templates.unshift(template);
  await saveState();
  res.status(201).json(template);
});

app.post("/api/dictionaries", upload.array("dictionary", 20), async (req, res, next) => {
  try {
    const files = req.files ?? [];
    if (files.length === 0) return res.status(400).json({ error: "No dictionary uploaded." });

    clearDocumentCache();
    invalidateWordBankMeaningCache();
    invalidateReadabilityContext();
    const displayName = files.length === 1 ? req.body.name ?? "" : "";
    const imports = [];
    for (const file of files) {
      imports.push(await dictionaryService.importDictionary(file, displayName));
    }
    markMlIndexStale("Dictionary imports changed lookup metadata.");
    await saveDictionariesState();
    await saveState();
    res.status(201).json({
      dictionary: imports[0]?.dictionary ?? null,
      dictionaries: imports.map((item) => item.dictionary),
      validations: imports.map((item) => item.validation)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dictionaries", (req, res) => {
  res.json({ dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
});

app.patch("/api/dictionaries/:id/settings", async (req, res, next) => {
  try {
    const patch = req.body ?? {};
    const dictionary = await dictionaryService.updateSettings(req.params.id, req.body ?? {});
    const selectedOnly = Object.keys(patch).every((key) => key === "selectedForWordBank");
    if (!selectedOnly) {
      markMlIndexStale("Dictionary settings changed lookup metadata.");
      invalidateReadabilityContext();
      clearDocumentCache();
    }
    await saveDictionariesState();
    await saveState();
    res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dictionaries/:id", async (req, res, next) => {
  try {
    const dictionary = await dictionaryService.deleteDictionary(req.params.id);
    invalidateWordBankMeaningCache(req.params.id);
    markMlIndexStale("Dictionary was deleted.");
    invalidateReadabilityContext();
    await saveDictionariesState();
    await saveState();
    clearDocumentCache();
    res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/dictionaries/settings", async (req, res, next) => {
  try {
    const settings = await dictionaryService.updateLookupSettings(req.body ?? {});
    markMlIndexStale("Dictionary lookup settings changed.");
    invalidateReadabilityContext();
    await saveState();
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dictionary/lookup", async (req, res, next) => {
  try {
    const term = String(req.query.term ?? "");
    const result = await lookupDictionaryForms(term, { prefix: req.query.prefix === "true" });
    result.readability = await readabilityForLookupTerm(term, result);
    if (result.knownTerm?.ankiNoteIds?.length) {
      try {
        const liveNoteId = await firstExistingAnkiNoteId(result.knownTerm.ankiNoteIds);
        result.knownTerm.hasAnkiNote = Boolean(liveNoteId);
        if (liveNoteId) result.knownTerm.ankiNoteIds = [liveNoteId, ...result.knownTerm.ankiNoteIds.filter((id) => Number(id) !== liveNoteId)];
      } catch {
        result.knownTerm.hasAnkiNote = true;
      }
    }
    logLearningEvent("lookup.performed", {
      term: normalizeJapaneseTerm(term),
      matched: (result.entries?.length ?? 0) > 0,
      entries: result.entries?.length ?? 0,
      frequencies: result.frequencies?.length ?? 0
    });
    invalidateReadabilityContext();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function firstExistingAnkiNoteId(noteIds = []) {
  for (const noteId of noteIds.map(Number).filter(Number.isFinite)) {
    if (await ankiService.hasNote(noteId)) return noteId;
  }
  return null;
}

app.get("/api/dictionary", async (req, res, next) => {
  try {
    const result = await lookupDictionaryForms(String(req.query.term ?? ""));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/anki/settings", async (req, res) => {
  const hasAutoLaunch = Object.prototype.hasOwnProperty.call(req.body, "autoLaunchAnki");
  const hasExecutablePath = Object.prototype.hasOwnProperty.call(req.body, "ankiExecutablePath");
  const nextExecutablePath = hasExecutablePath
    ? String(req.body.ankiExecutablePath ?? "").trim()
    : state.anki.ankiExecutablePath;
  const patch = {
    connectUrl: req.body.connectUrl?.trim() || state.anki.connectUrl,
    deckName: req.body.deckName?.trim() ?? state.anki.deckName,
    modelName: req.body.modelName?.trim() ?? state.anki.modelName,
    fieldMap: req.body.fieldMap ?? {},
    autoLaunchAnki: hasAutoLaunch ? Boolean(req.body.autoLaunchAnki) : state.anki.autoLaunchAnki,
    ankiExecutablePath: nextExecutablePath
  };
  if (hasExecutablePath && nextExecutablePath !== state.anki.ankiExecutablePath) {
    patch.ankiExecutablePathDetected = false;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "instantExport")) {
    patch.instantExport = Boolean(req.body.instantExport);
  }
  const nextSettings = await stateStore.anki.updateSettings({
    ...patch
  });
  res.json(nextSettings);
});

app.get("/api/media/providers", async (req, res, next) => {
  try {
    res.json(await mediaProvider.providers());
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/settings", async (req, res, next) => {
  try {
    const settings = await stateStore.media.updateSettings(req.body ?? {}, normalizeMediaSettings);
    res.json({ settings, providers: await mediaProvider.providers() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/voice-models", async (req, res, next) => {
  try {
    const url = String(req.body.url ?? "").trim();
    const name = String(req.body.name ?? "").trim() || voiceModelNameFromUrl(url);
    if (!/^https:\/\/huggingface\.co\/[^/\s]+\/[^/\s]+\/?$/i.test(url)) {
      return res.status(400).json({ error: "Enter a Hugging Face model URL, for example https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP" });
    }
    const model = {
      id: createHash("sha256").update(url).digest("hex").slice(0, 16),
      name,
      url,
      provider: "huggingface",
      status: "imported",
      note: "Imported model metadata. Local liquid-audio runtime support is required before this model can generate card audio."
    };
    const current = normalizeMediaSettings(state.media);
    const existing = current.voiceModels.filter((item) => item.id !== model.id);
    const settings = await stateStore.media.updateSettings({
      ...current,
      audio: { ...current.audio, voiceModelId: model.id },
      voiceModels: [...existing, model]
    }, normalizeMediaSettings);
    res.status(201).json({ model, settings, providers: await mediaProvider.providers() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/providers", async (req, res, next) => {
  try {
    res.json(await aiService.providers());
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai/runtime", async (req, res, next) => {
  try {
    res.json(await aiRuntimeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/runtime/stop", async (req, res, next) => {
  try {
    const stopped = await stopAiRuntime();
    res.json({ stopped, ...(await aiRuntimeStatus()) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/settings", async (req, res, next) => {
  try {
    res.json(await aiService.updateSettings(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/models", async (req, res, next) => {
  try {
    res.status(201).json(await aiService.importModel(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/test-translation", async (req, res, next) => {
  try {
    res.json(await aiService.translate({
      text: req.body.text,
      sourceLanguage: req.body.sourceLanguage,
      targetLanguage: req.body.targetLanguage
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/test-audio", async (req, res, next) => {
  try {
    const value = await mediaProvider.createAudio({
      expression: req.body.expression || "図書館",
      sentence: req.body.sentence || "図書館へ行きます。"
    });
    res.json({ value, status: await mediaProvider.status() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/test-image", async (req, res, next) => {
  try {
    const value = await mediaProvider.createImage({
      expression: req.body.expression || "図書館",
      reading: req.body.reading || "としょかん",
      meaning: req.body.meaning || "library",
      source: "Media test"
    });
    res.json({ value, status: await mediaProvider.status() });
  } catch (error) {
    next(error);
  }
});

function voiceModelNameFromUrl(url = "") {
  return url.split("/").filter(Boolean).slice(-2).join("/") || "Imported voice model";
}

app.get("/api/anki/connect", async (req, res, next) => {
  try {
    const result = await ankiService.listDecksAndModels();
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/anki/model-fields", async (req, res, next) => {
  try {
    res.json(await ankiService.modelFields(String(req.query.modelName ?? "")));
  } catch (error) {
    next(error);
  }
});

app.post("/api/anki/import", async (req, res, next) => {
  try {
    const result = await ankiService.importReviewedTerms({
      preset: req.body.preset,
      deckName: req.body.deckName?.trim(),
      query: req.body.query
    });
    logLearningEvent("anki.vocabulary-imported", { preset: req.body.preset, deckName: req.body.deckName, imported: result.imported });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/anki/card-preview", async (req, res, next) => {
  try {
    const preview = await ankiService.previewCard(req.body);
    logLearningEvent("sentence.previewed", {
      documentId: req.body.documentId,
      expression: preview.canonical?.Expression,
      dictionaryForm: preview.canonical?.DictionaryForm
    });
    res.json(preview);
  } catch (error) {
    next(error);
  }
});

app.post("/api/anki/open-known-term", async (req, res, next) => {
  try {
    const requestedTerm = normalizeJapaneseTerm(req.body.term ?? "");
    const queryTerms = await dictionaryLookupTerms(requestedTerm);
    const match = knownTermLookupMatch(requestedTerm, queryTerms, []);
    if (!match.exists) throw Object.assign(new Error("This vocabulary is not in the Word Bank."), { status: 404 });
    res.json(await ankiService.openTerm(match.term));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards", async (req, res) => {
  const document = state.documents.find((item) => item.id === req.body.documentId);
  if (!document) return res.status(404).json({ error: "Document not found." });

  const template = state.templates.find((item) => item.id === req.body.templateId) ?? state.templates[0];
  const expression = normalizeJapaneseTerm(req.body.expression);
  if (!expression) return res.status(400).json({ error: "Expression is required." });

  const imageName = `${crypto.randomUUID()}.svg`;
  await fs.writeFile(path.join(mediaDir, imageName), imageSvg(expression, req.body.reading ?? ""));

  const card = {
    id: crypto.randomUUID(),
    documentId: document.id,
    templateId: template.id,
    expression,
    dictionaryForm: normalizeJapaneseTerm(req.body.dictionaryForm || expression),
    reading: req.body.reading ?? "",
    sentence: req.body.sentence ?? "",
    meaning: req.body.meaning ?? "",
    source: document.title,
    audioPrompt: `Generate natural Japanese audio for: ${req.body.sentence || expression}`,
    imagePrompt: `Simple visual mnemonic for the Japanese vocabulary "${expression}" (${req.body.reading ?? ""}).`,
    imagePath: `/media/${imageName}`,
    createdAt: new Date().toISOString()
  };

  card.fields = mapCardFields(template, card);
  state.cards.unshift(card);
  await saveState();
  res.status(201).json(card);
});

app.get("/api/ml/analytics", async (req, res, next) => {
  try {
    res.json(await mlService.analytics());
  } catch (error) {
    next(error);
  }
});

app.get("/api/ml/index/status", async (req, res, next) => {
  try {
    res.json(await mlService.status());
  } catch (error) {
    next(error);
  }
});

app.get("/api/ml/providers", async (req, res, next) => {
  try {
    res.json({
      models: EMBEDDING_MODELS,
      settings: publicMlSettings(state.ml),
      status: await mlService.status()
    });
  } catch (error) {
    next(error);
  }
});

async function updateMlSettings(req, res, next) {
  try {
    const previousMl = normalizeMlSettings(state.ml);
    state.ml = normalizeMlSettings({
      ...state.ml,
      embeddingProviderId: req.body?.embeddingProviderId ?? state.ml?.embeddingProviderId,
      embeddingPythonPath: req.body?.embeddingPythonPath ?? state.ml?.embeddingPythonPath,
      embeddingBatchSize: req.body?.embeddingBatchSize ?? state.ml?.embeddingBatchSize
    });
    if (previousMl.embeddingProviderId !== state.ml.embeddingProviderId) {
      markMlIndexStale("Embedding model changed. Rebuild the local semantic index.");
    } else if (previousMl.embeddingPythonPath !== state.ml.embeddingPythonPath) {
      markMlIndexStale("Embedding Python runtime changed. Rebuild the local semantic index.");
    } else if (previousMl.embeddingBatchSize !== state.ml.embeddingBatchSize) {
      markMlIndexStale("Embedding batch size changed. Rebuild the local semantic index.");
    }
    await saveState();
    res.json({
      settings: publicMlSettings(state.ml),
      status: await mlService.status()
    });
  } catch (error) {
    next(error);
  }
}

app.patch("/api/ml/settings", updateMlSettings);
app.post("/api/ml/settings", updateMlSettings);

app.post("/api/ml/index/rebuild", async (req, res, next) => {
  try {
    const shouldSaveFreshState = Boolean(state.ml?.indexStale || state.ml?.indexStaleReason);
    await mlService.rebuildIndex();
    markMlIndexFresh();
    if (shouldSaveFreshState) await saveState();
    const result = await mlService.status();
    logLearningEvent("ml.index-rebuilt", { chunks: result.chunks, provider: result.provider, embeddingProvider: result.embeddingProvider });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/search/semantic", async (req, res, next) => {
  try {
    const result = await mlService.search(req.body.query, {
      limit: req.body.limit,
      readSafe: req.body.readSafe === true,
      documentId: req.body.documentId ? String(req.body.documentId) : "",
      currentPage: Number.isFinite(Number(req.body.currentPage)) ? Number(req.body.currentPage) : null,
      scope: req.body.scope === "document" ? "document" : "library"
    });
    logLearningEvent("search.semantic", { query: req.body.query, results: result.results.length });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/search/fts", async (req, res, next) => {
  try {
    const result = await ftsSearchService.search(req.body.query, {
      limit: req.body.limit,
      documentId: req.body.documentId ? String(req.body.documentId) : ""
    });
    logLearningEvent("search.fts", { query: req.body.query, results: result.results.length });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rag/ask", async (req, res, next) => {
  try {
    const result = await mlService.ragAnswer(req.body.question, {
      readSafe: req.body.readSafe !== false,
      documentId: req.body.documentId ? String(req.body.documentId) : "",
      currentPage: Number.isFinite(Number(req.body.currentPage)) ? Number(req.body.currentPage) : null
    });
    logLearningEvent("rag.asked", { question: req.body.question, citations: result.citations.length });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reader/assistant", async (req, res, next) => {
  try {
    const document = state.documents.find((item) => item.id === req.body.documentId);
    const question = compactReaderContext(req.body.question, 2500);
    if (!question) return res.status(400).json({ error: "Type a message before sending." });
    const task = inferAssistantIntent(question);
    const history = normalizeAssistantHistory(req.body.history);
    const contextText = task === "translate" ? compactReaderContext(translationPromptText(question), 2500) : question;
    const analysis = await analyzeText(contextText);
    const termNotes = assistantTermNotes(analysis.tokens);
    const query = assistantRetrievalQuery(question, contextText, history);
    const exposeCitations = task !== "translate" && assistantWantsExplicitCitations(question);
    const useRagContext = task === "recap" || (task !== "translate" && assistantWantsLocalRetrieval(query));
    const exampleSearch = task !== "translate" && assistantWantsExamples(query);
    const currentPage = Number(req.body.page) || 0;
    const searchResult = !useRagContext
      ? { results: [], status: { ready: false, skipped: true } }
      : await mlService.search(query, {
          limit: 6,
          readSafe: true,
          documentId: document?.id || "",
          currentPage
        });
    const citations = searchResult.results ?? [];
    const nameNotes = assistantNameReadingNotes({ document, question, contextText, citations });
    let chat;
    try {
      chat = await aiService.chat({
        intent: task,
        modelId: req.body.modelId,
        messages: buildAssistantMessages({
          intent: task,
          question: task === "translate" ? contextText : question,
          contextText,
          history,
          termNotes,
          nameNotes,
          citations,
          document,
          page: currentPage,
          includeRetrievedContext: useRagContext,
          includeCitations: exposeCitations,
          exampleSearch
        }),
        maxTokens: assistantMaxTokens(task, contextText, { useRagContext, exampleSearch }),
        temperature: task === "translate" ? 0.1 : 0.25
      });
    } catch (error) {
      chat = { available: false, text: "", reason: error.message, model: null };
    }
    const fallback = assistantResponseText(task, {
      contextText,
      question,
      termNotes,
      citations,
      document,
      translation: task === "translate" ? {
        available: chat.available,
        translatedText: chat.text,
        reason: chat.reason
      } : null
    });
    const answer = chat.available && chat.text ? chat.text : fallback;
    const result = {
      task,
      intent: task,
      question,
      answer,
      terms: termNotes,
      citations: exposeCitations ? citations : [],
      includeCitations: exposeCitations,
      translation: task === "translate" ? {
        available: chat.available,
        translatedText: chat.text,
        reason: chat.reason,
        model: chat.model
      } : null,
      ai: {
        available: chat.available,
        reason: chat.reason,
        model: chat.model
      },
      status: searchResult.status,
      context: {
        documentId: document?.id || "",
        title: document?.title || "",
        page: currentPage,
        source: "message"
      }
    };
    logLearningEvent("reader.assistant", {
      documentId: document?.id,
      task,
      page: result.context.page,
      terms: termNotes.length,
      citations: citations.length,
      source: result.context.source
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function writeAssistantStream(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/reader/assistant/stream", async (req, res, next) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  try {
    const document = state.documents.find((item) => item.id === req.body.documentId);
    const question = compactReaderContext(req.body.question, 2500);
    if (!question) {
      writeAssistantStream(res, "error", { error: "Type a message before sending." });
      res.end();
      return;
    }
    const task = inferAssistantIntent(question);
    const history = normalizeAssistantHistory(req.body.history);
    const contextText = task === "translate" ? compactReaderContext(translationPromptText(question), 2500) : question;
    const analysis = await analyzeText(contextText);
    const termNotes = assistantTermNotes(analysis.tokens);
    const query = assistantRetrievalQuery(question, contextText, history);
    const exposeCitations = task !== "translate" && assistantWantsExplicitCitations(question);
    const useRagContext = task === "recap" || (task !== "translate" && assistantWantsLocalRetrieval(query));
    const exampleSearch = task !== "translate" && assistantWantsExamples(query);
    const currentPage = Number(req.body.page) || 0;
    const searchResult = !useRagContext
      ? { results: [], status: { ready: false, skipped: true } }
      : await mlService.search(query, {
          limit: 6,
          readSafe: true,
          documentId: document?.id || "",
          currentPage
        });
    const citations = searchResult.results ?? [];
    const nameNotes = assistantNameReadingNotes({ document, question, contextText, citations });

    writeAssistantStream(res, "meta", {
      task,
      intent: task,
      includeCitations: exposeCitations,
      terms: termNotes,
      citations: exposeCitations ? citations : [],
      status: searchResult.status,
      context: {
        documentId: document?.id || "",
        title: document?.title || "",
        page: currentPage,
        source: "message"
      }
    });

    let chat;
    try {
      chat = await aiService.chatStream({
        intent: task,
        modelId: req.body.modelId,
        messages: buildAssistantMessages({
          intent: task,
          question: task === "translate" ? contextText : question,
          contextText,
          history,
          termNotes,
          nameNotes,
          citations,
          document,
          page: currentPage,
          includeRetrievedContext: useRagContext,
          includeCitations: exposeCitations,
          exampleSearch
        }),
        maxTokens: assistantMaxTokens(task, contextText, { useRagContext, exampleSearch }),
        temperature: task === "translate" ? 0.1 : 0.25,
        onToken: (delta) => writeAssistantStream(res, "delta", { delta })
      });
    } catch (error) {
      chat = { available: false, text: "", reason: error.message, model: null };
    }

    const fallback = assistantResponseText(task, {
      contextText,
      question,
      termNotes,
      citations,
      document,
      translation: task === "translate" ? {
        available: chat.available,
        translatedText: chat.text,
        reason: chat.reason
      } : null
    });
    const answer = chat.available && chat.text ? chat.text : fallback;
    if (!chat.available || !chat.text) writeAssistantStream(res, "delta", { delta: answer });
    const result = {
      task,
      intent: task,
      question,
      answer,
      terms: termNotes,
      citations: exposeCitations ? citations : [],
      includeCitations: exposeCitations,
      ai: {
        available: chat.available,
        reason: chat.reason,
        model: chat.model
      },
      status: searchResult.status,
      context: {
        documentId: document?.id || "",
        title: document?.title || "",
        page: currentPage,
        source: "message"
      }
    };
    logLearningEvent("reader.assistant", {
      documentId: document?.id,
      task,
      page: result.context.page,
      terms: termNotes.length,
      citations: citations.length,
      source: result.context.source
    });
    writeAssistantStream(res, "done", result);
    res.end();
  } catch (error) {
    writeAssistantStream(res, "error", { error: error.message });
    res.end();
  }
});

app.post("/api/anki/export-card", async (req, res, next) => {
  try {
    const exported = await ankiService.exportCard(req.body);
    logLearningEvent("anki.exported", {
      documentId: exported.documentId,
      expression: exported.expression,
      dictionaryForm: exported.dictionaryForm,
      noteId: exported.ankiNoteId,
      deckName: exported.deckName,
      modelName: exported.modelName
    });
    invalidateReadabilityContext();
    await saveAnkiExportState();
    res.status(201).json(exported);
  } catch (error) {
    next(error);
  }
});

app.get("/api/cards/export", (req, res) => {
  const rows = state.cards.map((card) => card.fields);
  const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [
    fieldNames.join(","),
    ...rows.map((row) => fieldNames.map((field) => JSON.stringify(row[field] ?? "")).join(","))
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"anki-cards.csv\"");
  res.send(csv);
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error." });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Anki Kanji Reader running at http://localhost:${port}`);
});
