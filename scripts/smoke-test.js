import fs from "node:fs/promises";
import AdmZip from "adm-zip";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-data-"));
const port = 3199;
const baseUrl = `http://localhost:${port}`;

await fs.mkdir(dataDir, { recursive: true });

const server = spawn("node", ["server/index.js"], {
  cwd: rootDir,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForServer();
  const smokeDictionaryTerm = await sampleDictionaryTerm();
  await uploadFile("/api/known-terms", "terms", "samples/known-vocab.txt");
  const noisyDictionaryPath = await writeNoisyDictionaryFixture();
  await uploadFile("/api/dictionaries", "dictionary", noisyDictionaryPath);
  const batchDictionaryPaths = await writeBatchDictionaryFixtures();
  const batchImport = await uploadFiles("/api/dictionaries", "dictionary", batchDictionaryPaths);
  assert(batchImport.dictionaries?.length === 2, "Multiple dictionary import should return both dictionaries.");
  const frequencyDictionaryPath = await writeFrequencyDictionaryFixture();
  await uploadFile("/api/dictionaries", "dictionary", frequencyDictionaryPath);
  const conjugationDictionaryPath = await writeConjugationDictionaryFixture();
  await uploadFile("/api/dictionaries", "dictionary", conjugationDictionaryPath);
  const readingAlignmentDictionaryPath = await writeReadingAlignmentDictionaryFixture();
  await uploadFile("/api/dictionaries", "dictionary", readingAlignmentDictionaryPath);
  const imported = await uploadFile("/api/documents", "book", "samples/sample-novel.txt");
  const documentId = imported.document.id;
  const stateSnapshot = await getJson("/api/state");
  const publicDocument = stateSnapshot.documents.find((document) => document.id === documentId);
  assert(publicDocument && !Object.hasOwn(publicDocument, "text") && !Object.hasOwn(publicDocument, "chapters"), "/api/state should not expose full document text or chapters.");
  const ingestEvents = await readSse(`/api/documents/${documentId}/ingest-stream`);
  const initialIngestDone = ingestEvents.find((event) => event.event === "done")?.data;
  assert(initialIngestDone, "Document ingestion stream should report completion.");
  assert(
    initialIngestDone.rebuilt === true || (initialIngestDone.state === "full-stale" && initialIngestDone.deferred === true),
    "Document ingestion should either build a cache or defer full rebuild during normal open."
  );
  if (initialIngestDone.rebuilt === true) await assertDocumentCacheCreated(documentId);
  const documentData = await getJson(`/api/documents/${documentId}?initial=1&page=0`);
  assert(Array.isArray(documentData.candidates) && documentData.candidates.length === 0, "Sentence mining candidates should be disabled.");
  const lookup = await getJson(`/api/dictionary?term=${encodeURIComponent("\u56f3\u66f8\u9928")}`);
  assert(lookup.entries[0]?.definitions?.includes("library"), "Dictionary lookup failed.");
  const lookupDefinitions = lookup.entries.flatMap((entry) => entry.definitions ?? []);
  assert(!lookupDefinitions.some((definition) => definition.includes("Ã¢Ëœâ€¦") || definition.includes("Ã¢â€ºÂ¬")), "Noisy dictionary metadata should be filtered.");
  assert(!lookupDefinitions.some((definition) => definition.includes("â˜…") || definition.includes("â›¬")), "Unicode dictionary metadata should be filtered.");
  const driftDictionaryPath = await writeDictionaryDriftFixture();
  await uploadFile("/api/dictionaries", "dictionary", driftDictionaryPath);
  const driftEvents = await readSse(`/api/documents/${documentId}/ingest-stream`);
  const driftDone = driftEvents.find((event) => event.event === "done")?.data;
  assert(driftDone && (driftDone.deferred === true || driftDone.rebuilt === false), "Dictionary drift should not trigger a blocking rebuild during normal open.");
  assert(!driftEvents.some((event) => event.event === "progress" && event.data.phase === "vector-index"), "Dictionary drift should not rebuild the semantic index during normal open.");
  assert(driftDone?.indexStale === true || driftDone?.deferred === true, `Dictionary-stale ingestion should mark or defer stale index work. Events: ${JSON.stringify(driftEvents)}`);
  const richLookup = await getJson(`/api/dictionary/lookup?term=${encodeURIComponent(smokeDictionaryTerm)}`);
  assert(richLookup.entries[0]?.dictionary, "Lookup should include dictionary labels.");
  assert(richLookup.frequencies[0]?.displayValue === "440", "Lookup should include frequency data.");
  const conjugatedLookup = await getJson(`/api/dictionary/lookup?term=${encodeURIComponent("\u8003\u3048\u3089\u308c\u308b")}`);
  assert(conjugatedLookup.entries.some((entry) => entry.term === "\u8003\u3048\u308b" && entry.definitions.includes("to think")), "Conjugated lookup should resolve to dictionary form.");
  const readingAlignmentDocumentPath = await writeReadingAlignmentDocumentFixture();
  const readingAlignmentImport = await uploadFile("/api/documents", "book", readingAlignmentDocumentPath);
  const reordered = await postJson("/api/documents/reorder", { ids: [readingAlignmentImport.document.id, documentId] });
  assert(reordered.documents[0]?.id === readingAlignmentImport.document.id, "/api/documents/reorder should not be captured by /api/documents/:id.");
  const readingAlignmentData = await getJson(`/api/documents/${readingAlignmentImport.document.id}?initial=1&page=0`);
  assert(Array.isArray(readingAlignmentData.candidates) && readingAlignmentData.candidates.length === 0, "Sentence mining candidates should stay disabled on reader documents.");
  const readabilityFrequencyPath = await writeReadabilityFrequencyDictionaryFixture();
  await uploadFile("/api/dictionaries", "dictionary", readabilityFrequencyPath);
  await postJson("/api/known-terms", { terms: ["\u5f8c", "\u8f2a"] });
  await postJson("/api/reader/settings", { hideInferredReadableFurigana: true });
  await postJson("/api/reader/settings", { hideInferredReadableFurigana: false });
  const addedReadable = await postJson("/api/known-terms", { term: "\u5f8c\u8f2a", source: "readable-suggestion", documentId: readingAlignmentImport.document.id });
  assert(addedReadable.added === 1, "Readable suggestions should be addable to Word Bank.");
  const authorRubyNameDocumentPath = await writeAuthorRubyNameDocumentFixture();
  const authorRubyNameImport = await uploadFile("/api/documents", "book", authorRubyNameDocumentPath);
  const authorRubyNameData = await getJson(`/api/documents/${authorRubyNameImport.document.id}?initial=1&page=0`);
  const authorRubyNameHtml = authorRubyNameData.pages[0]?.html ?? "";
  assert(authorRubyNameHtml.includes('class="author-ruby" data-author-ruby="true" data-base="\u5468" data-reading="\u3042\u307e\u306d"'), "Reader should preserve author-provided name ruby.");
  assert(!authorRubyNameHtml.includes('<ruby data-base="\u5468"'), "Reader should not add generated ruby to later bare occurrences of author-ruby names.");
  await assertWordCardCss();
  const mlProviders = await getJson("/api/ml/providers");
  assert(mlProviders.models.some((model) => model.id === "multilingual-e5-small"), "ML providers should include multilingual-e5-small.");
  assert(!mlProviders.models.some((model) => ["jina-embeddings-v3", "bge-m3", "paraphrase-multilingual-minilm"].includes(model.id)), "ML providers should expose only E5 plus the local fallback.");
  const mlSettings = await postJson("/api/ml/settings", { embeddingProviderId: "local-hash-ngram-v1" });
  assert(mlSettings.settings.embeddingProviderId === "local-hash-ngram-v1", "ML embedding settings should persist provider selection.");
  const mlIndex = await postJson("/api/ml/index/rebuild", {});
  assert(mlIndex.embeddingProvider === "local-hash-ngram-v1", "Rebuilt ML index should report the selected embedding provider.");
  const semanticResult = await postJson("/api/search/semantic", { query: smokeDictionaryTerm, limit: 5 });
  assert(semanticResult.results[0]?.text?.includes(smokeDictionaryTerm), "Exact semantic search query should rank exact text matches first.");
  const progress = await postJson(`/api/documents/${documentId}/progress`, {
    percentage: 42,
    page: 3,
    mode: "paged",
    chapterId: "chapter-route-test",
    zoom: 999,
    bookmarks: [{ page: 3, label: "Route check" }],
    highlights: { pages: { 3: "<mark>route</mark>" }, scrollHtml: "" }
  });
  assert(progress.mode === "paged" && progress.zoom === 175 && progress.bookmarks[0]?.page === 3, "Progress route should preserve mode/bookmarks and clamp zoom.");
  assert(progress.highlights?.pages?.[3] === "<mark>route</mark>" && progress.chapterId === "chapter-route-test", "Progress route should preserve highlights and chapter id.");
  const assistantEvents = await postSse("/api/reader/assistant/stream", { documentId, question: "", history: [] });
  assert(assistantEvents.some((event) => event.event === "error"), "Assistant stream should emit SSE errors without using Express error middleware.");

  const card = await postJson("/api/cards", {
    documentId,
    templateId: "default-template",
    expression: "\u56f3\u66f8\u9928",
    dictionaryForm: "\u56f3\u66f8\u9928",
    reading: "\u3068\u3057\u3087\u304b\u3093",
    sentence: "\u305d\u306e\u5f8c\u3001\u56f3\u66f8\u9928\u3078\u884c\u304d\u3001\u65b0\u3057\u3044\u5c0f\u8aac\u3092\u8aad\u307f\u59cb\u3081\u307e\u3057\u305f\u3002",
    meaning: "library"
  });
  assert(card.fields.Expression === "\u56f3\u66f8\u9928", "Card field mapping failed.");

  const exportedCsv = await getText("/api/cards/export");
  assert(exportedCsv.includes("Expression") && exportedCsv.includes(card.fields.Expression), "Cards CSV export should include mapped fields.");

  console.log("Smoke test passed.");
} finally {
  server.kill();
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await getJson("/api/state");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server did not start. ${stderr}`);
}

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`);
  if (!response.ok) throw new Error(`${route} failed with ${response.status}`);
  return response.json();
}

async function getText(route) {
  const response = await fetch(`${baseUrl}${route}`);
  if (!response.ok) throw new Error(`${route} failed with ${response.status}`);
  return response.text();
}

async function readSse(route) {
  const response = await fetch(`${baseUrl}${route}`);
  if (!response.ok) throw new Error(`${route} failed with ${response.status}`);
  return parseSseText(await response.text());
}

async function postSse(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  return parseSseText(await response.text());
}

function parseSseText(text) {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      let data = "{}";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      return { event, data: JSON.parse(data) };
    });
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function uploadFile(route, fieldName, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.set(fieldName, new Blob([buffer]), path.basename(filePath));

  const response = await fetch(`${baseUrl}${route}`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function uploadFiles(route, fieldName, relativePaths) {
  const form = new FormData();
  for (const relativePath of relativePaths) {
    const filePath = path.join(rootDir, relativePath);
    const buffer = await fs.readFile(filePath);
    form.append(fieldName, new Blob([buffer]), path.basename(filePath));
  }

  const response = await fetch(`${baseUrl}${route}`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function sampleDictionaryTerm() {
  const source = JSON.parse(await fs.readFile(path.join(rootDir, "samples/sample-dictionary.json"), "utf8"));
  return source[0][0];
}

async function writeNoisyDictionaryFixture() {
  const source = JSON.parse(await fs.readFile(path.join(rootDir, "samples/sample-dictionary.json"), "utf8"));
  source.push(["Ã¥â€ºÂ³Ã¦â€ºÂ¸Ã©Â¤Â¨", "Ã£ÂÂ¨Ã£Ââ€”Ã£â€šâ€¡Ã£Ââ€¹Ã£â€šâ€œ", "", "", 0, ["th; Ã¥â€ºÂ³Ã¦â€ºÂ¸Ã©Â¤Â¨; Ã£ÂÂ¨Ã£Ââ€”Ã£â€šâ€¡Ã£Ââ€¹Ã£â€šâ€œ; Ã¢Ëœâ€¦; Ã£ÂÅ¡Ã£Ââ€”Ã£â€šâ€¡Ã£Ââ€¹Ã£â€šâ€œ; Ã¢â€ºÂ¬"]]);
  source.push([source[0][0], source[0][1], "", "", 0, ["th; \u56f3\u66f8\u9928; \u3068\u3057\u3087\u304b\u3093; \u2605; \u305a\u3057\u3087\u304b\u3093; \u26ec"]]);
  const fixturePath = path.join(dataDir, "noisy-dictionary.json");
  await fs.writeFile(fixturePath, JSON.stringify(source));
  return path.relative(rootDir, fixturePath);
}

async function writeFrequencyDictionaryFixture() {
  const source = JSON.parse(await fs.readFile(path.join(rootDir, "samples/sample-dictionary.json"), "utf8"));
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({ title: "JPDB", targetLanguage: "ja" }), "utf8"));
  zip.addFile("term_meta_bank_1.json", Buffer.from(JSON.stringify([[source[0][0], "freq", { value: 440 }]]), "utf8"));
  const fixturePath = path.join(dataDir, "frequency-dictionary.zip");
  await fs.writeFile(fixturePath, zip.toBuffer());
  return path.relative(rootDir, fixturePath);
}

async function writeReadabilityFrequencyDictionaryFixture() {
  const zip = new AdmZip();
  zip.addFile("index.json", Buffer.from(JSON.stringify({ title: "Readability Freq", targetLanguage: "ja" }), "utf8"));
  zip.addFile("term_meta_bank_1.json", Buffer.from(JSON.stringify([["\u5f8c\u8f2a", "freq", { value: 440 }]]), "utf8"));
  const fixturePath = path.join(dataDir, "readability-frequency.zip");
  await fs.writeFile(fixturePath, zip.toBuffer());
  return path.relative(rootDir, fixturePath);
}

async function writeBatchDictionaryFixtures() {
  const firstPath = path.join(dataDir, "batch-dictionary-a.json");
  const secondPath = path.join(dataDir, "batch-dictionary-b.json");
  await fs.writeFile(firstPath, JSON.stringify([
    ["\u6279\u91cfA", "\u3072\u308a\u3087\u3046\u3048\u30fc", "n", "", 0, ["batch dictionary A"]]
  ]));
  await fs.writeFile(secondPath, JSON.stringify([
    ["\u6279\u91cfB", "\u3072\u308a\u3087\u3046\u3073\u30fc", "n", "", 0, ["batch dictionary B"]]
  ]));
  return [path.relative(rootDir, firstPath), path.relative(rootDir, secondPath)];
}

async function writeConjugationDictionaryFixture() {
  const fixturePath = path.join(dataDir, "conjugation-dictionary.json");
  await fs.writeFile(fixturePath, JSON.stringify([
    ["\u8003\u3048\u308b", "\u304b\u3093\u304c\u3048\u308b", "v1", "", 0, ["to think"]]
  ]));
  return path.relative(rootDir, fixturePath);
}

async function writeReadingAlignmentDictionaryFixture() {
  const fixturePath = path.join(dataDir, "reading-alignment-dictionary.json");
  await fs.writeFile(fixturePath, JSON.stringify([
    ["\u5f8c\u8f2a", "\u3053\u3046\u308a\u3093", "n", "", 0, ["rear wheel"]],
    ["\u53d6\u308a\u3064\u3051\u308b", "\u3068\u308a\u3064\u3051\u308b", "v1", "", 0, ["\u53d6\u308a\u4ed8\u3051\u308b; redirected from"]],
    ["\u53d6\u308a\u4ed8\u3051\u308b", "\u3068\u308a\u3064\u3051\u308b", "v1", "", 0, ["to install", "to attach"]]
  ]));
  return path.relative(rootDir, fixturePath);
}

async function writeDictionaryDriftFixture() {
  const fixturePath = path.join(dataDir, "dictionary-drift.json");
  await fs.writeFile(fixturePath, JSON.stringify([
    ["\u8f9e\u66f8\u6f02\u6d41", "\u3058\u3057\u3087\u3072\u3087\u3046\u308a\u3085\u3046", "n", "", 0, ["dictionary drift fixture"]]
  ]));
  return path.relative(rootDir, fixturePath);
}

async function writeReadingAlignmentDocumentFixture() {
  const fixturePath = path.join(dataDir, "reading-alignment.txt");
  await fs.writeFile(fixturePath, "\u5f8c\u8f2a\u8107\u306b\u53d6\u308a\u3064\u3051\u3089\u308c\u3066\u3044\u308b\u3002", "utf8");
  return path.relative(rootDir, fixturePath);
}

async function writeAuthorRubyNameDocumentFixture() {
  const fixturePath = path.join(dataDir, "author-ruby-name.txt");
  await fs.writeFile(fixturePath, "[[RUBY:%E5%91%A8|%E3%81%82%E3%81%BE%E3%81%AD]]\u306f\u6c17\u4ed8\u3044\u305f\u3002\u5468\u306e\u69d8\u5b50\u3092\u6307\u6458\u3057\u305f\u3002", "utf8");
  return path.relative(rootDir, fixturePath);
}

async function assertWordCardCss() {
  const css = await fs.readFile(path.join(rootDir, "public/styles.css"), "utf8");
  assert(/\.word-row\s*\{[\s\S]*height:\s*124px;/.test(css), "Word cards should have a fixed height.");
  assert(/\.word-row p\s*\{[\s\S]*-webkit-line-clamp:\s*3;/.test(css), "Word card definitions should be line-clamped.");
}

async function assertDocumentCacheCreated(documentId) {
  const cacheRoot = path.join(dataDir, "document-cache", documentId);
  const manifest = JSON.parse(await fs.readFile(path.join(cacheRoot, "manifest.json"), "utf8"));
  assert(manifest.documentId === documentId, "Document cache manifest should be written.");
  const tokenFiles = await fs.readdir(path.join(cacheRoot, "tokens"));
  assert(tokenFiles.length > 0, "Document token cache should contain token files.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
