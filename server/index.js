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
import { createMlService } from "./ml-service.js";
import { createJsonStateStore } from "./json-state-store.js";
import { createLearningEventLog } from "./learning-events.js";
import { createFtsSearchService } from "./fts-search-service.js";
import { createLocalMediaProvider, defaultMediaSettings, normalizeMediaSettings } from "./media-providers.js";
import { createSqliteStateStore } from "./sqlite-state-store.js";
import { createSyncService, defaultSyncSettings, normalizeSyncSettings, publicSyncSettings } from "./sync-service.js";
import { registerAssistantRoutes } from "./routes/assistant-routes.js";
import { registerCardRoutes } from "./routes/card-routes.js";
import { registerDictionaryRoutes } from "./routes/dictionary-routes.js";
import { registerDocumentRoutes } from "./routes/document-routes.js";
import { registerIntegrationRoutes } from "./routes/integration-routes.js";
import { registerMlRoutes } from "./routes/ml-routes.js";
import { registerStateRoutes } from "./routes/state-routes.js";
import { registerSyncRoutes } from "./routes/sync-routes.js";
import { registerWordBankRoutes } from "./routes/wordbank-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
loadDotEnv(path.join(rootDir, ".env"));
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const mediaDir = path.join(dataDir, "media");
const eventsPath = path.join(dataDir, "events.jsonl");
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
const publicStaticMiddleware = express.static(publicDir);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return publicStaticMiddleware(req, res, next);
});

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
  // Legacy compatibility state. Text-index status comes from SQLite FTS5.
  ml: {
    indexStale: false,
    indexStaleReason: ""
  },
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
const documentIngestionPromises = new Map();
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
    await saveSettingsState(["ai"]);
  },
  runtimeCommand: String(process.env.LOCAL_TRANSLATION_COMMAND ?? "").trim()
});
const dictionaryService = createDictionaryService({
  store: stateStore,
  normalizeJapaneseTerm,
  repairMojibake,
  crypto,
  deferStoreSave: true,
  dictionaryStore: sqliteStateStore
});
const eventLog = createLearningEventLog({ eventsPath });
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
  saveSyncState: async () => saveSettingsState(["sync"]),
  savePulledState: saveState,
  mediaDir,
  eventLog,
  clearDocumentCache
});
const mlService = createMlService({
  getState: () => state,
  getRevisions: () => sqliteStateStore.revisions({ readOnly: true }),
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji,
  ftsSearch: ftsSearchService
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
    fs.mkdir(documentCacheDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true })
  ]);
}

async function loadState() {
  const sqliteState = sqliteStateStore.loadState();
  if (sqliteState) {
    state = { ...structuredClone(initialState), ...sqliteState };
    const repaired = await repairLoadedState();
    await ensureSqliteDictionaryIndexes();
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
  state.ml = {
    ...(state.ml ?? {}),
    indexStale: Boolean(state.ml?.indexStale),
    indexStaleReason: String(state.ml?.indexStaleReason ?? "")
  };
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

async function saveDocumentsState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveDocumentsState(state);
    });
  return saveStateQueue;
}

async function saveProgressState(documentId, payload) {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveProgress(documentId, payload);
    });
  return saveStateQueue;
}

async function saveKnownTermsState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveKnownTermsState(state);
    });
  return saveStateQueue;
}

async function saveKnownTermsAddedState(terms = []) {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      if (typeof sqliteStateStore.saveKnownTermsAdded === "function") {
        sqliteStateStore.saveKnownTermsAdded(terms, state.knownTermMeta ?? {}, state);
      } else {
        sqliteStateStore.saveKnownTermsState(state);
      }
    });
  return saveStateQueue;
}

async function saveKnownTermsDeletedState(terms = []) {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      if (typeof sqliteStateStore.saveKnownTermsDeleted === "function") {
        sqliteStateStore.saveKnownTermsDeleted(terms, state.trash?.knownTerms ?? [], state);
      } else {
        sqliteStateStore.saveKnownTermsState(state);
      }
    });
  return saveStateQueue;
}

async function saveCardsAndKnownTermsState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveCardsAndKnownTermsState(state);
    });
  return saveStateQueue;
}

async function saveTemplatesState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveTemplatesState(state);
    });
  return saveStateQueue;
}

async function saveSettingsState(keys = []) {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveSettingsState(state, keys);
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

async function ensureSqliteDictionaryIndexes() {
  if (typeof sqliteStateStore.dictionaryIndexStats !== "function") return;
  const stats = sqliteStateStore.dictionaryIndexStats();
  if (stats.dictionaries === 0 || stats.entries > 0 || stats.frequencies > 0) return;
  const externalDictionaries = await loadExternalDictionaries();
  const dictionaries = Array.isArray(externalDictionaries) ? externalDictionaries : [];
  const expectedEntries = dictionaries.reduce((sum, dictionary) => sum + Number(dictionary?.entries?.length ?? 0), 0);
  const expectedFrequencies = dictionaries.reduce((sum, dictionary) => sum + Number(dictionary?.frequencyEntries?.length ?? 0), 0);
  if (expectedEntries + expectedFrequencies === 0) return;

  console.log(`Rebuilding SQLite dictionary lookup index from dictionaries.json (${expectedEntries.toLocaleString()} entries, ${expectedFrequencies.toLocaleString()} frequencies).`);
  sqliteStateStore.saveDictionariesState({ ...state, dictionaries });
  state.dictionaries = dictionaries.map(dictionaryPublicStorageRecord);
  invalidateWordBankMeaningCache();
  invalidateReadabilityContext();
  normalizationDictionaryCache.clear();
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
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      sqliteStateStore.saveDictionariesState(state);
    });
  return saveStateQueue;
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
    state.dictionaries.length
  ].join("\u0002");
}

function clearDocumentCache() {
  documentResponseCache.clear();
}

function hideKnownTermsInDocumentResponseCache(terms = []) {
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : [terms])
    .map(normalizeJapaneseTerm)
    .filter(Boolean))];
  if (normalizedTerms.length === 0 || documentResponseCache.size === 0) return;
  for (const cached of documentResponseCache.values()) {
    if (typeof cached.html === "string") cached.html = hideKnownTermsInHtml(cached.html, normalizedTerms);
    if (Array.isArray(cached.pages)) {
      cached.pages = cached.pages.map((page) => ({
        ...page,
        html: typeof page?.html === "string" ? hideKnownTermsInHtml(page.html, normalizedTerms) : page?.html
      }));
    }
  }
}

function hideKnownTermsInHtml(html = "", terms = []) {
  let next = String(html ?? "");
  for (const term of terms) {
    const escapedTerm = escapeRegExp(escapeHtml(term));
    const rubyPattern = new RegExp(`<ruby([^>]*)\\bdata-base="${escapedTerm}"([^>]*)>([\\s\\S]*?)<rt>[\\s\\S]*?<\\/rt><\\/ruby>`, "gu");
    next = next.replace(rubyPattern, (_match, beforeAttrs, afterAttrs, surfaceHtml) => {
      return `<span class="lookup-token"${beforeAttrs} data-base="${escapeHtml(term)}"${afterAttrs}>${surfaceHtml}</span>`;
    });
  }
  return next;
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function deleteDocumentSearchIndex(documentId = "") {
  try {
    const result = await mlService.deleteDocumentSearchIndex(documentId);
    if (result.deleted > 0) {
      markMlIndexStale("Book text-search rows were removed. Refresh the local text index after restoring books.");
    }
    return result;
  } catch (error) {
    markMlIndexStale(`Book text-index cleanup failed: ${error.message}`);
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
    markMlIndexStale("Dictionary normalization changed. Refresh the local text search index when convenient.");
    return { ...cacheState, rebuilt: false, deferred: true, cacheDir };
  }
  if (cacheState.state === "full-stale" && options.force !== true && options.deferFullStale === true) {
    markMlIndexStale("Document ingestion cache is stale. Refresh the local text search index when convenient.");
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
    if (index > 0 && index % 10 === 0) await yieldToEventLoop();
    await analyzeReaderTokenStream(text, {
      cacheDir,
      authorRubyProtectedTerms: authorRubyProtectedTermsFromText(text)
    });
  }

  await writeDocumentCacheManifest(document, cacheState.current);
  if (cacheState.state === "dictionary-stale") {
    markMlIndexStale("Dictionary normalization changed. Refresh the local text search index when convenient.");
    await saveSettingsState(["ml"]).catch((error) => {
      console.warn("Unable to persist ML stale flag after reader cache refresh:", error.message);
    });
  } else if (cacheState.state === "full-stale" || options.force === true) {
    markMlIndexStale("Document ingestion cache changed. Refresh the local text search index.");
    await saveSettingsState(["ml"]).catch((error) => {
      console.warn("Unable to persist ML stale flag after reader cache refresh:", error.message);
    });
  }
  return { ...cacheState, rebuilt: true, cacheDir };
}

async function ensureDocumentIngestionCacheSingleFlight(document = {}, options = {}) {
  const documentId = String(document?.id ?? "");
  if (!documentId) return ensureDocumentIngestionCache(document, options);
  const existing = documentIngestionPromises.get(documentId);
  if (existing && options.force !== true) {
    if (typeof options.onProgress === "function") {
      options.onProgress({
        phase: "waiting",
        label: "Waiting for existing local cache check...",
        current: 0,
        total: 1
      });
    }
    return existing;
  }
  const promise = ensureDocumentIngestionCache(document, options)
    .finally(() => {
      if (documentIngestionPromises.get(documentId) === promise) documentIngestionPromises.delete(documentId);
    });
  documentIngestionPromises.set(documentId, promise);
  return promise;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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

function lookupCachedWordBankMeanings(terms = [], dictionaryId = "") {
  const resolvedDictionaryId = dictionaryId || selectedWordBankDictionaryId();
  const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : [])
    .map(normalizeJapaneseTerm)
    .filter(Boolean))];
  const cache = wordBankMeaningCacheEntry(resolvedDictionaryId);
  const result = new Map();
  const missing = [];
  for (const term of normalizedTerms) {
    if (cache && cache.entries.has(term)) result.set(term, cache.entries.get(term));
    else missing.push(term);
  }
  if (missing.length > 0) {
    const batch = typeof dictionaryService.lookupWordBankMany === "function"
      ? dictionaryService.lookupWordBankMany(missing, resolvedDictionaryId)
      : new Map(missing.map((term) => [term, dictionaryService.lookupWordBank(term, resolvedDictionaryId)]));
    for (const term of missing) {
      const entries = batch.get(term) ?? [];
      result.set(term, entries);
      if (cache) cache.entries.set(term, entries);
    }
  }
  return result;
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
  const terms = state.knownTerms.map(normalizeJapaneseTerm).filter(Boolean);
  const batch = typeof dictionaryService.lookupWordBankMany === "function"
    ? dictionaryService.lookupWordBankMany(terms, resolvedDictionaryId)
    : new Map(terms.map((term) => [term, dictionaryService.lookupWordBank(term, resolvedDictionaryId)]));
  for (const term of terms) entries.set(term, batch.get(term) ?? []);
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

function assistantResponseText(task, { contextText, question, termNotes, document, translation }) {
  const title = document?.title || "the current book";
  const terms = termNotes.slice(0, 6).map((term) => {
    const meaning = term.definitions?.slice(0, 2).join("; ") || "no dictionary definition";
    return "- " + term.term + (term.reading ? " (" + term.reading + ")" : "") + ": " + meaning;
  });
  if (task === "recap") {
    const sentences = splitSentences(contextText).slice(0, 5);
    return [
      "Recap of current-page context for " + title + ":",
      sentences.length
        ? sentences.map((sentence, index) => (index + 1) + ". " + sentence).join("\n")
        : "No readable current-page text was available."
    ].join("\n\n");
  }
  if (task === "translate") {
    if (translation?.available && translation.translatedText) return translation.translatedText;
    return [
      "Local AI is not ready yet. " + (translation?.reason || "Configure a local assistant model in Integrations."),
      contextText ? "Message text:\n" + contextText.slice(0, 900) : "Type the text you want translated.",
      terms.length ? "Dictionary notes:\n" + terms.join("\n") : "No dictionary notes were found for this context."
    ].join("\n\n");
  }
  if (task === "ask") {
    return [
      question ? "Question: " + question : "Question: current page",
      contextText ? "Current context:\n" + contextText.slice(0, 900) : "No current page context was available.",
      terms.length ? "Useful terms:\n" + terms.join("\n") : "No dictionary terms were found."
    ].join("\n\n");
  }
  return [
    "Context explanation:",
    contextText ? contextText.slice(0, 900) : "No readable selected text or page text was available.",
    terms.length ? "Key vocabulary and dictionary meanings:\n" + terms.join("\n") : "No dictionary-backed vocabulary notes were found."
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

function assistantContextMessage({ intent, question, contextText, history = [], termNotes = [], nameNotes = [], document, page }) {
  const lines = [
    "You are running inside YomiApuri, a local Japanese reading app.",
    "The app library currently contains " + state.documents.length + " imported book" + (state.documents.length === 1 ? "" : "s") + ", but this assistant turn cannot search or retrieve passages from other books.",
    "Use only the user's current message, current page context, dictionary notes, author-name notes, and recent conversation history.",
    "Intent: " + intent,
    "Current book: " + (document?.title || "unknown"),
    "Current page: " + (Number(page) + 1 || "unknown")
  ];
  const previousUser = previousUserMessage(history);
  if (previousUser && intent !== "translate") {
    lines.push("Immediate previous user message. Use this first for follow-up references like \"the second sentence\", \"previous sentence\", or \"that grammar point\":\n" + compactReaderContext(previousUser, 900));
  }
  if (intent === "translate") {
    lines.push("Translate only the user's requested text. Do not translate unrelated page text.");
  }
  if (intent === "recap") {
    lines.push("Summarize only the current message and supplied current-page context. Do not infer events from unread or other books.");
  }
  if (question) lines.push("User message:\n" + compactReaderContext(question, 1200));
  if (contextText && intent !== "translate") {
    lines.push("Reader context:\n" + compactReaderContext(contextText, 900));
  }
  if (termNotes.length) {
    lines.push("Dictionary lookup notes for grounding only. Do not label these as vocabulary anchors in the answer:\n" + termNotes.slice(0, 6).map((term) => {
      const meaning = term.definitions?.slice(0, 2).join("; ") || "no dictionary definition";
      return "- " + term.term + (term.reading ? " (" + term.reading + ")" : "") + ": " + meaning;
    }).join("\n"));
  }
  if (nameNotes.length) {
    lines.push("Author ruby/name reading notes from the current book. These override common kanji readings when romanizing character names:\n" + nameNotes.slice(0, 12).map((note) => "- " + note.surface + ": " + note.reading + " -> " + note.romaji).join("\n"));
  }
  return compactReaderContext(lines.join("\n\n"), 2600);
}
function buildAssistantMessages({ intent, question, contextText, history, termNotes, nameNotes = [], citations, document, page, includeRetrievedContext = false, includeCitations = false, exampleSearch = false }) {
  const messages = [];
  const context = assistantContextMessage({ intent, question, contextText, history, termNotes, nameNotes, citations, document, page, includeRetrievedContext, includeCitations, exampleSearch });
  if (context) messages.push({ role: "user", content: `App-provided context for this turn:\n${context}` });
  messages.push(...normalizeAssistantHistory(history));
  messages.push({ role: "user", content: question });
  return messages;
}

function assistantMaxTokens(intent, contextText = "") {
  if (intent === "translate") return Math.max(96, Math.min(768, Math.ceil(String(contextText).length * 1.8) + 64));
  if (intent === "explain") return 448;
  if (intent === "recap") return 768;
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
  // Try graceful kill based on PID files
  for (const runtime of runtimes.runtimes) {
    if (!runtime.running || !runtime.pid) continue;
    try {
      process.kill(runtime.pid);
      stopped += 1;
    } catch {
      // Process may have exited
    }
  }

  // Guaranteed "Hard Kill" for any lingering llama-server.exe
  try {
    // /F = Force, /IM = Image Name, /T = Terminate child processes
    execSync('taskkill /F /IM llama-server.exe /T', { stdio: 'ignore' });
    stopped += 1;
  } catch (e) {
    // No llama-server.exe found, or already stopped
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

  try {
    const tokenizer = await getTokenizer();
    for (const token of tokenizer.tokenize(normalized)) {
      addTerm(token.surface_form, true);
      addTerm(tokenBase(token), true);
      addTerm(tokenReading(token), true);
      if (terms.length >= 12) break;
    }
  } catch {
    // Direct lookup still works if tokenizer setup is unavailable.
  }
  return terms;
}

async function lookupDictionaryForms(term = "", options = {}) {
  const normalized = normalizeJapaneseTerm(term);
  const terms = normalized ? [normalized] : [];
  const entries = [];
  const frequencies = [];
  const seenEntries = new Set();
  const seenFrequencies = new Set();
  const appendResult = (lookupTerm, result = {}) => {
    for (const entry of result.entries ?? []) {
      for (const redirectTarget of entry.redirectTargets ?? []) {
        if (terms.length < 16 && !terms.includes(redirectTarget)) terms.push(redirectTarget);
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
  };

  if (normalized) appendResult(normalized, dictionaryService.lookup(normalized, options));
  if (entries.length === 0 && frequencies.length === 0) {
    for (const expandedTerm of await dictionaryLookupTerms(term)) {
      if (!terms.includes(expandedTerm)) terms.push(expandedTerm);
    }
  }

  for (let index = 0; index < terms.length && index < 16; index += 1) {
    const lookupTerm = terms[index];
    if (index === 0 && lookupTerm === normalized) continue;
    appendResult(lookupTerm, dictionaryService.lookup(lookupTerm, options));
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

function fastPageCandidates(text = "", limit = 40) {
  if (!hasJapaneseText(text)) return [];
  const known = learnedSet();
  const cleanText = stripReaderMarkers(String(text ?? ""));
  const sentences = buildSentenceLookup(cleanText);
  const candidatesByKey = new Map();
  const pattern = /[\u3400-\u9fff々〆ヵヶ][\u3400-\u9fff々〆ヵヶぁ-んァ-ヴー]{0,8}/gu;
  for (const match of cleanText.matchAll(pattern)) {
    const surface = normalizeJapaneseTerm(match[0]);
    if (!surface || !hasKanji(surface) || surface.length < 2) continue;
    if (known.has(surface)) continue;
    if (candidatesByKey.has(surface)) continue;
    candidatesByKey.set(surface, {
      expression: surface,
      surface,
      dictionaryForm: surface,
      reading: "",
      partOfSpeech: "",
      readabilityStatus: "unknown",
      readabilityScore: 0,
      readabilityReasons: [],
      sentence: sentenceForOffset(sentences, match.index ?? 0)
    });
    if (candidatesByKey.size >= limit) break;
  }
  return [...candidatesByKey.values()];
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

function normalizeReaderToken(token = {}, known = learnedSet(), authorRubyProtectedTerms = new Set(), options = {}) {
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
  const canonical = options.dictionaryAware === false ? null : canonicalDictionaryMatch([surface, base]);
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

function dictionaryAwareTokenStream(tokens = [], known = learnedSet(), authorRubyProtectedTerms = authorRubyProtectedTermsFromTokens(tokens), options = {}) {
  if (options.dictionaryAware === false) {
    return tokens.map((token) => normalizeReaderToken(token, known, authorRubyProtectedTerms, options));
  }
  const merged = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.authorRuby || !hasKanji(token.surface) || isAuthorRubyProtectedToken(token, authorRubyProtectedTerms)) {
      merged.push(normalizeReaderToken(token, known, authorRubyProtectedTerms, options));
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
      }, known, authorRubyProtectedTerms, options);
      merged.push(compound);
      index = best.end;
      continue;
    }

    merged.push(normalizeReaderToken(token, known, authorRubyProtectedTerms, options));
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
    normalizedTokens = dictionaryAwareTokenStream(readerRenderTokens(text, tokenizer, new Set()), new Set(), authorRubyProtectedTerms, {
      dictionaryAware: options.dictionaryAware !== false
    });
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
  const known = Boolean(lookupResult.knownTerm?.exists) || learnedByTokenVariants(token, learnedSet());
  if (known) return { status: "known", score: 100, reasons: ["word bank"] };
  let score = 0;
  const reasons = [];
  if ((lookupResult.entries?.length ?? 0) > 0) {
    score += 35;
    reasons.push("dictionary match");
  }
  if ((lookupResult.frequencies?.length ?? 0) > 0) {
    score += 35;
    reasons.push("frequency match");
  }
  const knownKanji = knownKanjiSet();
  const kanji = [...(token.dictionaryForm || token.surface || "")].filter((char) => hasKanji(char));
  if (kanji.length > 0 && kanji.every((char) => knownKanji.has(char))) {
    score += 25;
    reasons.push("known kanji");
  }
  const readability = {
    status: score >= 85 ? "inferred-readable" : "unknown",
    score,
    reasons
  };
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
      rendered.push(`<p class="book-line">${renderReaderLinkHtml(block.href, stripReaderMarkers(block.text))}</p>`);
      continue;
    }
    if (block.type === "text" && block.text?.trim()) {
      textBuffer.push(block.text);
    }
  }
  await flushText();
  return rendered.join("");
}

function renderInitialStructuredBlocks(blocks = []) {
  const rendered = [];
  let textBuffer = [];
  const flushText = () => {
    if (textBuffer.length === 0) return;
    rendered.push(`<div class="book-lines">${renderFastTextLines(joinTextBlocks(textBuffer))}</div>`);
    textBuffer = [];
  };
  for (const block of blocks) {
    if (block.type === "page") {
      flushText();
      rendered.push(block.pdfSrc ? renderPdfPageFigure(block) : renderInitialStructuredBlocks(block.blocks ?? []));
      continue;
    }
    if (block.type === "image") {
      flushText();
      rendered.push(renderImageFigure(block.src, block.alt ?? ""));
      continue;
    }
    if (block.type === "link" && block.text?.trim()) {
      flushText();
      rendered.push(`<p class="book-line">${renderReaderLinkHtml(block.href, stripReaderMarkers(block.text))}</p>`);
      continue;
    }
    if (block.type === "text" && block.text?.trim()) textBuffer.push(block.text);
  }
  flushText();
  return rendered.join("");
}

function decodeReaderMarker(value = "") {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return value ?? "";
  }
}

function renderReaderLinkHtml(href = "", label = "") {
  const text = escapeHtml(String(label ?? "").trim());
  const targetHref = String(href ?? "").trim();
  if (!text) return "";
  if (!targetHref) return text;
  const isExternal = /^https?:\/\//i.test(targetHref);
  const attrs = isExternal
    ? `href="${escapeHtml(targetHref)}" target="_blank" rel="noreferrer"`
    : `href="#" data-epub-href="${escapeHtml(targetHref)}"`;
  return `<a class="book-link" ${attrs}>${text}</a>`;
}

function renderFastInlineText(value = "") {
  const markerPattern = /\[\[(RUBY):([^|]*)\|([^\]]*)\]\]|\[\[LINK:([^|]*)\|([^\]]*)\]\]|\[\[IMG:[^\]]*\]\]/g;
  let html = "";
  let lastIndex = 0;
  for (const match of String(value ?? "").matchAll(markerPattern)) {
    html += escapeHtml(value.slice(lastIndex, match.index));
    if (match[1] === "RUBY") html += authorRubyHtml(decodeReaderMarker(match[2]), decodeReaderMarker(match[3]));
    else if (match[4] || match[5]) html += renderReaderLinkHtml(decodeReaderMarker(match[4]), decodeReaderMarker(match[5]));
    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(value.slice(lastIndex));
  return html;
}

function renderFastTextLines(text = "") {
  return String(text ?? "")
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="book-line">${renderFastInlineText(line)}</p>`)
    .join("");
}

function renderInitialStructuredPages(blocks = [], charLimit = 850, maxPages = 8) {
  const pages = [];
  let pageBlocks = [];
  let count = 0;
  for (const originalBlock of blocks) {
    if (pages.length >= maxPages) break;
    const expandedBlocks = splitLongTextBlock(originalBlock, charLimit);
    for (const block of expandedBlocks) {
      if (pages.length >= maxPages) break;
      if (block.type === "page" || block.type === "image") {
        if (pageBlocks.length > 0) {
          pages.push(renderInitialStructuredBlocks(pageBlocks));
          pageBlocks = [];
          count = 0;
          if (pages.length >= maxPages) break;
        }
        pages.push(renderInitialStructuredBlocks([block]));
        continue;
      }
      const blockLength = block.type === "text" || block.type === "link" ? block.text.length : 220;
      if (pageBlocks.length > 0 && count + blockLength > charLimit) {
        pages.push(renderInitialStructuredBlocks(pageBlocks));
        pageBlocks = [];
        count = 0;
        if (pages.length >= maxPages) break;
      }
      pageBlocks.push(block);
      count += blockLength;
    }
  }
  if (pageBlocks.length > 0 && pages.length < maxPages) pages.push(renderInitialStructuredBlocks(pageBlocks));
  return pages.length > 0 ? pages : [""];
}

function paginateStructuredBlockGroups(blocks = [], charLimit = 850) {
  const pages = [];
  let pageBlocks = [];
  let count = 0;
  const pushPage = () => {
    if (pageBlocks.length === 0) return;
    pages.push(pageBlocks);
    pageBlocks = [];
    count = 0;
  };
  for (const originalBlock of blocks) {
    const expandedBlocks = splitLongTextBlock(originalBlock, charLimit);
    for (const block of expandedBlocks) {
      if (block.type === "page" || block.type === "image") {
        pushPage();
        pages.push([block]);
        continue;
      }
      const blockLength = block.type === "text" || block.type === "link" ? String(block.text ?? "").length : 220;
      if (pageBlocks.length > 0 && count + blockLength > charLimit) pushPage();
      pageBlocks.push(block);
      count += blockLength;
    }
  }
  pushPage();
  return pages.length > 0 ? pages : [[]];
}

function documentPageDescriptors(document = {}, charLimit = 850) {
  const chapters = fallbackChapters(document);
  const descriptors = [];
  const chapterMetas = chapters.map((chapter, index) => ({
    id: chapter.id || `chapter-${index + 1}`,
    title: chapter.title || `Chapter ${index + 1}`,
    href: chapter.href ?? ""
  }));
  for (const [index, chapter] of chapters.entries()) {
    const meta = chapterMetas[index];
    const renderBlocks = stripChapterTitleFromBlocks(chapter.blocks ?? [], meta.title);
    const pageGroups = paginateStructuredBlockGroups(renderBlocks, charLimit);
    for (const [pageIndex, blocks] of pageGroups.entries()) {
      descriptors.push({
        chapterId: meta.id,
        chapterTitle: meta.title,
        isChapterFirstPage: pageIndex === 0,
        blocks
      });
    }
  }
  return { chapters: chapterMetas, descriptors };
}

function readerPageWindowStart(total = 0, requestedPage = 0, limit = 8) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeLimit = Math.max(1, Number(limit) || 8);
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, Math.max(0, safeTotal - 1)));
  return Math.max(0, Math.min(page - Math.floor(safeLimit / 2), Math.max(0, safeTotal - safeLimit)));
}

async function renderPageDescriptor(descriptor = {}, options = {}) {
  const pageHtml = options.fast
    ? renderInitialStructuredBlocks(descriptor.blocks ?? [])
    : await renderStructuredBlocks(descriptor.blocks ?? [], options);
  return {
    chapterId: descriptor.chapterId,
    html: wrapReaderPage(pageHtml, descriptor.chapterTitle, Boolean(descriptor.isChapterFirstPage) && !isImageOnlyPageHtml(pageHtml))
  };
}

async function renderDocumentPageWindow(document = {}, start = 0, limit = 8) {
  const { descriptors } = documentPageDescriptors(document);
  const manifest = await readDocumentCacheManifest(document.id);
  const cacheState = documentCacheState(document, manifest);
  const dictionaryAware = cacheState.state !== "dictionary-stale";
  const useFastRenderer = cacheState.state !== "valid";
  const cacheDir = documentTokenCacheDir(document.id);
  const safeStart = Math.max(0, Math.min(Number(start) || 0, Math.max(0, descriptors.length - 1)));
  const safeLimit = Math.max(1, Math.min(24, Number(limit) || 8));
  const renderedPages = [];
  for (const [offset, descriptor] of descriptors.slice(safeStart, safeStart + safeLimit).entries()) {
    const pageText = blocksToText(descriptor.blocks ?? []);
    const page = await renderPageDescriptor(descriptor, {
      cacheDir,
      authorRubyProtectedTerms: authorRubyProtectedTermsFromText(pageText),
      dictionaryAware,
      fast: useFastRenderer
    });
    renderedPages.push({ ...page, index: safeStart + offset, unloaded: false });
    await yieldToEventLoop();
  }
  return {
    start: safeStart,
    limit: safeLimit,
    total: descriptors.length,
    pages: renderedPages
  };
}

function stripReaderMarkers(value = "") {
  return String(value ?? "")
    .replace(/\[\[RUBY:([^|]*)\|[^\]]*\]\]/g, (_match, surface) => decodeURIComponent(surface ?? ""))
    .replace(/\[\[LINK:[^|]*\|([^\]]*)\]\]/g, (_match, label) => label ?? "")
    .replace(/\[\[IMG:[^\]]*\]\]/g, "");
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
        await yieldToEventLoop();
      }
      pages.push(block.pdfSrc ? renderPdfPageFigure(block) : await renderStructuredBlocks(block.blocks ?? [], options));
      await yieldToEventLoop();
      continue;
    }
    if (block.type === "image") {
      if (pageBlocks.length > 0) {
        pages.push(await renderStructuredBlocks(pageBlocks, options));
        pageBlocks = [];
        count = 0;
        await yieldToEventLoop();
      }
      pages.push(await renderStructuredBlocks([block], options));
      await yieldToEventLoop();
      continue;
    }
    const blockLength = block.type === "text" || block.type === "link" ? block.text.length : 220;
    if (pageBlocks.length > 0 && count + blockLength > charLimit) {
      pages.push(await renderStructuredBlocks(pageBlocks, options));
      pageBlocks = [];
      count = 0;
      await yieldToEventLoop();
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
  eventLog.append(type, payload).catch(() => {});
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
    textIndexStale: Boolean(state.ml?.indexStale)
  };
}

const routeContext = {
  getState: () => state,
  upload,
  persistence: {
    saveState,
    saveAnkiExportState,
    saveDocumentsState,
    saveProgressState,
    saveKnownTermsState,
    saveKnownTermsAddedState,
    saveKnownTermsDeletedState,
    saveCardsAndKnownTermsState,
    saveTemplatesState,
    saveSettingsState,
    saveDictionariesState
  },
  services: {
    stateStore,
    syncService,
    dictionaryService,
    mlService,
    ftsSearchService,
    ankiService,
    mediaProvider,
    aiService
  },
  cache: {
    clearDocumentCache,
    hideKnownTermsInDocumentResponseCache,
    invalidateReadabilityContext,
    invalidateWordBankMeaningCache,
    markMlIndexStale,
    markMlIndexFresh,
    deleteDocumentSearchIndex
  },
  paths: {
    mediaDir
  },
  stores: {
    documentResponseCache
  },
  helpers: {
    initialState,
    publicSyncSettings,
    logLearningEvent,
    syncDiagnostics,
    normalizeSyncSettings,
    normalizeMediaSettings,
    aiRuntimeStatus,
    stopAiRuntime,
    selectedWordBankDictionaryId,
    wordBankMeaningCacheStatus,
    rebuildWordBankMeaningCache,
    normalizeJapaneseTerm,
    parseKnownTerms,
    mergeKnownTerms,
    sortKnownTerms,
    lookupCachedWordBankMeanings,
    moveKnownTermsToTrash,
    trashTermValue,
    trashTermMeta,
    lookupDictionaryForms,
    readabilityForLookupTerm,
    dictionaryLookupTerms,
    knownTermLookupMatch,
    extractDocument,
    repairMojibake,
    decodeUploadName,
    ensureDocumentIngestionCacheSingleFlight,
    documentTokenCacheDir,
    documentPageDescriptors,
    readerPageWindowStart,
    renderDocumentPageWindow,
    documentCacheKey,
    analyzeDocument,
    fallbackChapters,
    renderRubyLines,
    renderRubyLinePages,
    stripChapterTitleFromBlocks,
    blocksToText,
    renderInitialStructuredPages,
    renderStructuredPages,
    authorRubyProtectedTermsFromText,
    isImageOnlyPageHtml,
    wrapReaderPage,
    chapterHeadingHtml,
    yieldToEventLoop,
    renderRuby,
    renderRubyPages,
    frontImagePaths,
    renderImageFigure,
    imageSvg,
    mapCardFields,
    compactReaderContext,
    inferAssistantIntent,
    normalizeAssistantHistory,
    translationPromptText,
    analyzeText,
    assistantTermNotes,
    assistantNameReadingNotes,
    buildAssistantMessages,
    assistantMaxTokens,
    assistantResponseText
  }
};

registerStateRoutes(app, routeContext);
registerSyncRoutes(app, routeContext);
registerDocumentRoutes(app, routeContext);
registerWordBankRoutes(app, routeContext);
registerDictionaryRoutes(app, routeContext);
registerIntegrationRoutes(app, routeContext);
registerMlRoutes(app, routeContext);
registerAssistantRoutes(app, routeContext);
registerCardRoutes(app, routeContext);

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error." });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Anki Kanji Reader running at http://localhost:${port}`);
});
