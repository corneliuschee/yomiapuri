import fs from "node:fs/promises";
import AdmZip from "adm-zip";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(rootDir, ".tmp", "smoke-data");
const port = 3199;
const baseUrl = `http://localhost:${port}`;

await fs.rm(dataDir, { recursive: true, force: true });
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
  const documentData = await getJson(`/api/documents/${documentId}`);
  const expressions = documentData.candidates.map((candidate) => candidate.expression);

  assert(!expressions.includes("食べ"), "食べました should be filtered by known 食べる.");
  assert(!expressions.includes("行き"), "行き should be filtered by known 行く.");
  assert(expressions.includes("図書館"), "Expected 図書館 as an unknown candidate.");
  const lookup = await getJson(`/api/dictionary?term=${encodeURIComponent("図書館")}`);
  assert(lookup.entries[0]?.definitions?.includes("library"), "Dictionary lookup failed.");
  const lookupDefinitions = lookup.entries.flatMap((entry) => entry.definitions ?? []);
  assert(!lookupDefinitions.some((definition) => definition.includes("â˜…") || definition.includes("â›¬")), "Noisy dictionary metadata should be filtered.");
  assert(!lookupDefinitions.some((definition) => definition.includes("★") || definition.includes("⛬")), "Unicode dictionary metadata should be filtered.");
  const richLookup = await getJson(`/api/dictionary/lookup?term=${encodeURIComponent(smokeDictionaryTerm)}`);
  assert(richLookup.entries[0]?.dictionary, "Lookup should include dictionary labels.");
  assert(richLookup.frequencies[0]?.displayValue === "440", "Lookup should include frequency data.");
  const conjugatedLookup = await getJson(`/api/dictionary/lookup?term=${encodeURIComponent("\u8003\u3048\u3089\u308c\u308b")}`);
  assert(conjugatedLookup.entries.some((entry) => entry.term === "\u8003\u3048\u308b" && entry.definitions.includes("to think")), "Conjugated lookup should resolve to dictionary form.");
  const readingAlignmentDocumentPath = await writeReadingAlignmentDocumentFixture();
  const readingAlignmentImport = await uploadFile("/api/documents", "book", readingAlignmentDocumentPath);
  const readingAlignmentData = await getJson(`/api/documents/${readingAlignmentImport.document.id}?candidates=1&page=0`);
  const compoundCandidate = readingAlignmentData.candidates.find((candidate) => candidate.expression === "\u5f8c\u8f2a");
  assert(compoundCandidate?.reading === "\u3053\u3046\u308a\u3093", "Sentence mining should use the same compound reading as reader furigana.");
  assert(readingAlignmentData.pages[0]?.html?.includes('data-base="\u5f8c\u8f2a" data-reading="\u3053\u3046\u308a\u3093"'), "Reader furigana should use the compound dictionary reading.");
  const redirectedVerbCandidate = readingAlignmentData.candidates.find((candidate) => candidate.expression === "\u53d6\u308a\u4ed8\u3051\u308b");
  assert(redirectedVerbCandidate?.dictionaryForm === "\u53d6\u308a\u4ed8\u3051\u308b", "Sentence mining should canonicalize redirected verb forms.");
  assert(redirectedVerbCandidate?.reading === "\u3068\u308a\u3064\u3051\u308b", "Canonical redirected verb should use dictionary-form reading.");
  await assertWordCardCss();

  const card = await postJson("/api/cards", {
    documentId,
    templateId: "default-template",
    expression: "図書館",
    dictionaryForm: "図書館",
    reading: "としょかん",
    sentence: "その後、図書館へ行き、新しい小説を読み始めました。",
    meaning: "library"
  });
  assert(card.fields.Expression === "図書館", "Card field mapping failed.");

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
  source.push(["å›³æ›¸é¤¨", "ã¨ã—ã‚‡ã‹ã‚“", "", "", 0, ["th; å›³æ›¸é¤¨; ã¨ã—ã‚‡ã‹ã‚“; â˜…; ãšã—ã‚‡ã‹ã‚“; â›¬"]]);
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

async function writeReadingAlignmentDocumentFixture() {
  const fixturePath = path.join(dataDir, "reading-alignment.txt");
  await fs.writeFile(fixturePath, "\u5f8c\u8f2a\u8107\u306b\u53d6\u308a\u3064\u3051\u3089\u308c\u3066\u3044\u308b\u3002", "utf8");
  return path.relative(rootDir, fixturePath);
}

async function assertWordCardCss() {
  const css = await fs.readFile(path.join(rootDir, "public/styles.css"), "utf8");
  assert(/\.word-row\s*\{[\s\S]*height:\s*124px;/.test(css), "Word cards should have a fixed height.");
  assert(/\.word-row p\s*\{[\s\S]*-webkit-line-clamp:\s*3;/.test(css), "Word card definitions should be line-clamped.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
