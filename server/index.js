import AdmZip from "adm-zip";
import express from "express";
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import pdfParse from "pdf-parse";
import kuromoji from "kuromoji";
import { createHash } from "node:crypto";
import { createAnkiService } from "./anki-service.js";
import { createAnkiLauncher, detectAnkiExecutablePath } from "./anki-launcher.js";
import { createDictionaryService, repairDictionaryState } from "./dictionary-service.js";
import { createJsonStateStore } from "./json-state-store.js";
import { createLearningEventLog } from "./learning-events.js";
import { createMlService } from "./ml-service.js";
import { createLocalMediaProvider, defaultMediaSettings, normalizeMediaSettings } from "./media-providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const mediaDir = path.join(dataDir, "media");
const eventsPath = path.join(dataDir, "events.jsonl");
const vectorDir = path.join(dataDir, "vector-index");
const dbPath = path.join(dataDir, "state.json");
const dbTmpPath = path.join(dataDir, "state.json.tmp");
const dictionaryDbPath = path.join(dataDir, "dictionaries.json");
const dictionaryDbTmpPath = path.join(dataDir, "dictionaries.json.tmp");
const publicDir = path.join(rootDir, "public");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use("/media", express.static(mediaDir));
app.get("/vendor/pdfjs/", (req, res) => res.redirect("/"));
app.use("/vendor/pdfjs", express.static(path.join(rootDir, "node_modules", "pdf-parse", "lib", "pdf.js", "v1.10.100", "build")));
app.use(express.static(publicDir));

const detectedAnkiExecutablePath = detectAnkiExecutablePath();

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
  media: defaultMediaSettings(),
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
const dictionaryService = createDictionaryService({
  store: stateStore,
  normalizeJapaneseTerm,
  repairMojibake,
  crypto
});
const eventLog = createLearningEventLog({ eventsPath });
const mlService = createMlService({
  getState: () => state,
  vectorDir,
  eventLog,
  analyzeText,
  lookupDictionary,
  normalizeJapaneseTerm,
  hasJapaneseText,
  hasKanji
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
    fs.mkdir(vectorDir, { recursive: true })
  ]);
}

async function loadState() {
  if (!existsSync(dbPath)) {
    await saveState();
    return;
  }

  const raw = await fs.readFile(dbPath, "utf8");
  const migratedDictionaries = !existsSync(dictionaryDbPath) && await migrateDictionariesFromRawState(raw);
  const loadedState = parseStateJson(raw);
  const externalDictionaries = await loadExternalDictionaries();
  let repaired = Boolean(migratedDictionaries);
  state = { ...structuredClone(initialState), ...loadedState };
  if (externalDictionaries) state.dictionaries = externalDictionaries;
  else if (Array.isArray(loadedState.dictionaries) && loadedState.dictionaries.length > 0) {
    state.dictionaries = loadedState.dictionaries;
  }
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
  state.media = normalizeMediaSettings(state.media);
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
  if (repaired) await saveState();
}

async function saveState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      await writeStateJson(dbTmpPath, mainStateSnapshot());
      await replaceStateFile(dbTmpPath, dbPath);
    });
  return saveStateQueue;
}

function mainStateSnapshot() {
  return {
    ...state,
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
  await writeStateJson(dictionaryDbTmpPath, { dictionaries });
  await replaceStateFile(dictionaryDbTmpPath, dictionaryDbPath);
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
    state.knownTerms.length,
    state.knownTerms.join("\u0001"),
    state.dictionaries.length
  ].join("\u0002");
}

function clearDocumentCache() {
  documentResponseCache.clear();
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
  return `<ruby class="author-ruby" data-author-ruby="true" data-reading="${escapeHtml(reading)}">${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
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
  let coverPath = "";
  let tocItems = [];

  if (opf) {
    title = repairMojibake(getXmlText(opf, "dc:title") || getXmlText(opf, "title"));
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
    return extractEpubDocument(file, documentId);
  }

  const text = file.buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  return { text, chapters: [{ id: "chapter-1", title: "Document", blocks: splitSentences(text).map((sentence) => ({ type: "text", text: sentence })) }] };
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

function learnedSet() {
  return new Set(state.knownTerms.map((term) => normalizeJapaneseTerm(term)));
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

  const tokenizer = await getTokenizer();
  for (const token of tokenizer.tokenize(normalized)) {
    addTerm(tokenBase(token), true);
    addTerm(token.surface_form, true);
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
    const key = token.base || token.surface;
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        expression: token.base || token.surface,
        surface: token.surface,
        dictionaryForm: token.base,
        reading: token.reading,
        partOfSpeech: token.pos,
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
    const key = token.base || token.surface;
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        expression: token.base || token.surface,
        surface: token.surface,
        dictionaryForm: token.base,
        reading: token.reading,
        partOfSpeech: token.pos,
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
      if (!token.eligible || !token.reading) return escapeHtml(token.surface);
      return `<ruby data-base="${escapeHtml(token.base)}" data-reading="${escapeHtml(token.reading)}">${escapeHtml(token.surface)}<rt>${escapeHtml(token.reading)}</rt></ruby>`;
    })
    .join("");
}

async function renderAnkiSentenceHtml(sentence = "", target = "", context = {}) {
  if (!hasJapaneseText(sentence)) return highlightPlainSentenceTarget(sentence, target);
  const tokens = await analyzeReaderTokenStream(sentence);
  return renderAnkiSentenceTokens(tokens, target, context);
}

function renderAnkiSentenceTokens(tokens = [], target = "", context = {}) {
  const targetIndexes = targetTokenIndexes(tokens, target);
  const fallbackTargetReading = targetIndexes.size === 1 ? primaryReading(context.reading) : "";
  return tokens
    .map((token, index) => {
      const isTarget = targetIndexes.has(index);
      const html = tokenToAnkiHtml(token, true, isTarget ? fallbackTargetReading : "");
      return isTarget ? `<span style="color:#ff5a3d;font-weight:700;">${html}</span>` : html;
    })
    .join("");
}

function targetTokenIndexes(tokens = [], target = "") {
  const normalizedTarget = normalizeJapaneseTerm(target);
  const indexes = new Set();
  if (!normalizedTarget) return indexes;

  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if ([token.surface, token.base].map(normalizeJapaneseTerm).includes(normalizedTarget)) {
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

  return indexes;
}

function tokenToAnkiHtml(token, forceRuby = false, fallbackReading = "") {
  if (token.html) return token.html;
  const surface = token.surface ?? "";
  const reading = primaryReading(token.reading) || primaryReading(fallbackReading);
  const shouldShowRuby = Boolean(reading && hasKanji(surface) && (forceRuby || token.eligible));
  if (!shouldShowRuby) return escapeHtml(surface);
  return `<ruby data-base="${escapeHtml(token.base || surface)}" data-reading="${escapeHtml(reading)}">${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
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
  if (!token.eligible || !token.reading) {
    if (hasJapaneseText(token.surface) && token.pos !== "記号") {
      return `<span class="lookup-token" data-base="${escapeHtml(token.base || token.surface)}">${escapeHtml(token.surface)}</span>`;
    }
    return escapeHtml(token.surface);
  }
  const reading = primaryReading(token.reading);
  return `<ruby data-base="${escapeHtml(token.base)}" data-reading="${escapeHtml(reading)}">${escapeHtml(token.surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
}

function primaryReading(reading = "") {
  return String(reading).split("/")[0].trim();
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
  const tokenizer = await getTokenizer();
  const known = learnedSet();
  
  // Use the exact matching rules from requirement 3
  const tokens = tokenizer.tokenize(text).map((token) => {
    const surface = normalizeJapaneseTerm(token.surface_form);
    const base = tokenBase(token);
    const reading = tokenReading(token);
    const learned = isLearnedToken(token, known);
    
    return {
      surface,
      base,
      reading,
      // Eligible means it contains Kanji, is NOT known in Anki, and isn't punctuation
      eligible: hasKanji(surface) && !learned && token.pos !== "記号"
    };
  });
  
  return tokens.map(tokenToHtml).join("");
}

async function renderTextLinesBlock(text) {
  if (!hasJapaneseText(text)) return renderPlainTextLines(text);

  const tokenizer = await getTokenizer();
  const known = learnedSet();
  const tokens = tokenizer.tokenize(text).map((token) => {
    const surface = normalizeJapaneseTerm(token.surface_form);
    const base = tokenBase(token);
    const reading = tokenReading(token);
    const learned = isLearnedToken(token, known);
    return {
      surface,
      base,
      reading,
      eligible: hasKanji(surface) && !learned && token.pos !== "記号"
    };
  });

  const lines = [];
  let line = "";
  for (const token of tokens) {
    line += tokenToHtml(token);
    if (/[。！？!?\n]/u.test(token.surface)) {
      if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
      line = "";
    }
  }
  if (line.trim()) lines.push(`<p class="book-line">${line}</p>`);
  return lines.join("");
}

function renderPlainTextLines(text = "") {
  return text
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="book-line">${escapeHtml(line)}</p>`)
    .join("");
}

async function analyzeReaderTokenStream(text) {
  const tokenizer = await getTokenizer();
  const known = learnedSet();
  return mergeDictionaryCompounds(readerRenderTokens(text, tokenizer, known), known);
}

async function renderReaderTextLines(text) {
  if (!hasJapaneseText(text)) return renderPlainTextLines(text);

  const tokens = await analyzeReaderTokenStream(text);

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

async function renderStructuredBlocks(blocks = []) {
  const rendered = [];
  let textBuffer = [];

  async function flushText() {
    if (textBuffer.length === 0) return;
    rendered.push(`<div class="book-lines">${await renderReaderTextLines(joinTextBlocks(textBuffer))}</div>`);
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
      rendered.push(`<section class="pdf-page-block"${pageNumber}>${await renderStructuredBlocks(block.blocks ?? [])}</section>`);
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

async function renderStructuredPages(blocks = [], charLimit = 850) {
  const pages = [];
  let pageBlocks = [];
  let count = 0;

  for (const originalBlock of blocks) {
    const expandedBlocks = splitLongTextBlock(originalBlock, charLimit);
    for (const block of expandedBlocks) {
    if (block.type === "page") {
      if (pageBlocks.length > 0) {
        pages.push(await renderStructuredBlocks(pageBlocks));
        pageBlocks = [];
        count = 0;
      }
      pages.push(block.pdfSrc ? renderPdfPageFigure(block) : await renderStructuredBlocks(block.blocks ?? []));
      continue;
    }
    if (block.type === "image") {
      if (pageBlocks.length > 0) {
        pages.push(await renderStructuredBlocks(pageBlocks));
        pageBlocks = [];
        count = 0;
      }
      pages.push(await renderStructuredBlocks([block]));
      continue;
    }
    const blockLength = block.type === "text" || block.type === "link" ? block.text.length : 220;
    if (pageBlocks.length > 0 && count + blockLength > charLimit) {
      pages.push(await renderStructuredBlocks(pageBlocks));
      pageBlocks = [];
      count = 0;
    }
    pageBlocks.push(block);
    count += blockLength;
    }
  }

  if (pageBlocks.length > 0) pages.push(await renderStructuredBlocks(pageBlocks));
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

app.get("/api/state", (req, res) => {
  res.json({
    documents: state.documents.map(({ text, chapters, ...document }) => document),
    knownTermsCount: state.knownTerms.length,
    trash: {
      documents: state.trash.documents.map(({ text, chapters, ...document }) => document),
      knownTerms: state.trash.knownTerms
    },
    dictionaries: dictionaryService.listMetadata(),
    dictionarySettings: state.dictionarySettings,
    progress: state.progress,
    cards: state.cards,
    anki: state.anki,
    media: state.media,
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
    .map((term) => ({ term, dictionaryEntries: dictionaryService.lookupWordBank(term, dictionaryId) }));

  res.json({ total: filtered.length, allTotal: state.knownTerms.length, offset, limit, sort, terms });
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
  await saveState();
  const documents = state.documents.map(({ text, chapters, ...document }) => document);
  res.json({ documents });
});

app.get("/api/documents/:id", async (req, res, next) => {
  try {
    const document = state.documents.find((item) => item.id === req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found." });
    const includeCandidates = req.query.candidates === "1" || document.text.length < 20000;

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
          const rawPages = await renderStructuredPages(renderBlocks);
          let headingPlaced = false;
          const pages = rawPages.map((pageHtml) => {
            const includeHeading = !headingPlaced && !isImageOnlyPageHtml(pageHtml);
            if (includeHeading) headingPlaced = true;
            return wrapReaderPage(pageHtml, chapterTitle, includeHeading);
          });
          const rawHtml = chapterText.length > 30000 && !chapterHasPageBlocks && !chapterHasImageBlocks ? rawPages.slice(0, 3).join("") : await renderStructuredBlocks(renderBlocks);
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
      const contentHtml = responseChapters.map((chapter) => `<section class="book-chapter" data-chapter-id="${escapeHtml(chapter.id)}"><h2>${escapeHtml(chapter.title)}</h2>${chapter.html}</section>`).join("");
      const missingFrontImages = (await frontImagePaths(document)).filter((imagePath) => !contentHtml.includes(imagePath));
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
        sourcePath: document.sourcePath ?? "",
        html: `${frontImageHtml}${contentHtml}`,
        pages,
        chapters: responseChapters.map(({ id, title, href, html }) => ({ id, title, href: href ?? "", html })),
        textLength: document.text.length
      };
      documentResponseCache.set(cacheKey, cached);
    }

    let candidates = [];
    if (includeCandidates) {
      const pageIndex = Number(req.query.page);
      if (Number.isInteger(pageIndex) && cached.pages[pageIndex]) {
        candidates = (await analyzeText(pageHtmlToCandidateText(cached.pages[pageIndex].html))).candidates.map(enrichCandidate);
      } else {
        candidates = (await analyzeDocument(document)).candidates.map(enrichCandidate);
      }
      candidates = await mlService.rankCandidates(document.id, candidates);
    }

    res.json({
      ...cached,
      candidates,
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
  await saveState();
  res.json({ deleted: 1, documentId: deleted.id, total: state.trash.documents.length });
});

app.delete("/api/trash/documents", async (req, res) => {
  const deleted = state.trash.documents.length;
  state.trash.documents = [];
  clearDocumentCache();
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
  await saveState();
  for (const term of added) logLearningEvent("wordbank.added", { term, source: req.file ? "import" : "manual" });
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
  clearDocumentCache();
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
    const displayName = files.length === 1 ? req.body.name ?? "" : "";
    const imports = [];
    for (const file of files) {
      imports.push(await dictionaryService.importDictionary(file, displayName));
    }
    await saveDictionariesState();
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
    const dictionary = await dictionaryService.updateSettings(req.params.id, req.body ?? {});
    await saveDictionariesState();
    clearDocumentCache();
    res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dictionaries/:id", async (req, res, next) => {
  try {
    const dictionary = await dictionaryService.deleteDictionary(req.params.id);
    await saveDictionariesState();
    clearDocumentCache();
    res.json({ dictionary, dictionaries: dictionaryService.listMetadata(), settings: state.dictionarySettings });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/dictionaries/settings", async (req, res, next) => {
  try {
    const settings = await dictionaryService.updateLookupSettings(req.body ?? {});
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dictionary/lookup", async (req, res, next) => {
  try {
    const term = String(req.query.term ?? "");
    const result = await lookupDictionaryForms(term, { prefix: req.query.prefix === "true" });
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

app.post("/api/ml/index/rebuild", async (req, res, next) => {
  try {
    const result = await mlService.rebuildIndex();
    logLearningEvent("ml.index-rebuilt", { chunks: result.chunks, provider: result.provider });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/search/semantic", async (req, res, next) => {
  try {
    const result = await mlService.search(req.body.query, { limit: req.body.limit });
    logLearningEvent("search.semantic", { query: req.body.query, results: result.results.length });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rag/ask", async (req, res, next) => {
  try {
    const result = await mlService.ragAnswer(req.body.question);
    logLearningEvent("rag.asked", { question: req.body.question, citations: result.citations.length });
    res.json(result);
  } catch (error) {
    next(error);
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
