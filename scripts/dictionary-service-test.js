import AdmZip from "adm-zip";
import * as crypto from "node:crypto";
import assert from "node:assert/strict";
import { createDictionaryService } from "../server/dictionary-service.js";
import { createJsonStateStore } from "../server/json-state-store.js";

const libraryTerm = "\u56f3\u66f8\u9928";
const libraryReading = "\u3068\u3057\u3087\u304b\u3093";
const libraryAltReading = "\u305a\u3057\u3087\u304b\u3093";
const causeTerm = "\u539f\u56e0";
const causeReading = "\u3052\u3093\u3044\u3093";
const kanaLookUpTerm = "\u307f\u3088\u3046";
const kanjiSameReadingTerm = "\u898b\u69d8";
const layeredTerm = "\u5e7e\u91cd";
const layeredReading = "\u3044\u304f\u3048";

const state = {
  dictionaries: [],
  dictionarySettings: { prefixWildcardSearch: false }
};

let saved = 0;
const store = createJsonStateStore({
  getState: () => state,
  setState: () => {},
  saveState: async () => {
    saved += 1;
  }
});

const normalizeJapaneseTerm = (value = "") => String(value).normalize("NFKC").trim();
const repairMojibake = (value = "") => String(value);
const service = createDictionaryService({ store, normalizeJapaneseTerm, repairMojibake, crypto });

const termImport = await service.importDictionary(fileFromZip("jitendex.zip", {
  "index.json": { title: "Jitendex", targetLanguage: "en" },
  "term_bank_1.json": [
    [libraryTerm, libraryReading, "n", "", 0, ["library"]],
    [libraryTerm, libraryAltReading, "n", "", 0, ["library"]],
    [kanaLookUpTerm, "", "exp", "", 0, ["let's see"]],
    [kanjiSameReadingTerm, kanaLookUpTerm, "n", "", 0, ["point of view"]],
    [layeredTerm, layeredReading, "adv", "", 0, [
      {
        tag: "div",
        content: [
          { tag: "span", content: "adverb" },
          { tag: "ol", content: [
            { tag: "li", content: ["repeatedly", "over and over again"] },
            { tag: "li", content: ["several layers deep", "layer upon layer", "row upon row"] }
          ] }
        ]
      }
    ]]
  ]
}));
assert.equal(termImport.dictionary.type, "term");
assert.equal(termImport.dictionary.selectedForWordBank, true);

const secondImport = await service.importDictionary(fileFromZip("spanish.zip", {
  "index.json": { title: "Spanish", targetLanguage: "es" },
  "term_bank_1.json": [[libraryTerm, libraryReading, "n", "", 0, ["biblioteca"]]]
}));
assert.equal(secondImport.dictionary.selectedForWordBank, false);

const frequencyImport = await service.importDictionary(fileFromZip("freq.zip", {
  "index.json": { title: "JPDB", targetLanguage: "ja" },
  "term_meta_bank_1.json": [
    [libraryTerm, "freq", { value: 440 }],
    [libraryTerm, "freq", { frequency: { value: "N4" } }]
  ]
}));
assert.equal(frequencyImport.dictionary.type, "frequency");
assert.equal(frequencyImport.dictionary.frequencyCount, 2);
assert.equal(frequencyImport.dictionary.enabledForLookup, true);

await service.updateSettings(secondImport.dictionary.id, { selectedForWordBank: true });
const metadata = service.listMetadata();
assert.equal(metadata.find((item) => item.id === secondImport.dictionary.id).selectedForWordBank, true);
assert.equal(metadata.find((item) => item.id === termImport.dictionary.id).selectedForWordBank, false);

const wordBank = service.lookupWordBank(libraryTerm);
assert.equal(wordBank[0].definitions[0], "biblioteca");

const lookup = service.lookup(libraryTerm);
assert.equal(lookup.entries[0].dictionary, "Jitendex");
assert.equal(lookup.entries.some((entry) => entry.dictionary === "Spanish"), true);
assert.deepEqual([...new Set(lookup.entries.map((entry) => entry.dictionary))].slice(0, 2), ["Jitendex", "Spanish"]);

const layeredLookup = service.lookup(layeredTerm);
const layeredJitendex = layeredLookup.entries.find((entry) => entry.dictionary === "Jitendex");
assert(layeredJitendex.details.some((line) => line.includes("several layers deep")), "Structured Yomitan details should preserve nested content.");
assert(layeredJitendex.details.some((line) => line.includes("layer upon layer")), "Structured Yomitan details should preserve all nested lines.");
assert(layeredJitendex.definitions.length > 0, "Structured Yomitan entries should keep concise definitions for compatibility.");

await service.importDictionary(fileFromZip("redirected.zip", {
  "index.json": { title: "Redirected", targetLanguage: "en" },
  "term_bank_1.json": [
    ["\u5e7e\u91cd", "\u3044\u304f\u3048", "n", "", 0, [[
      "noun",
      "piling up",
      "multiple layers",
      "See:",
      "\u5e7e",
      "\u3044\u304f",
      "\u91cd",
      "\u3048",
      "\u306b\u3082",
      "JMdict"
    ]]],
    ["\u5e7e\u91cd\u306b\u3082", "\u3044\u304f\u3048\u306b\u3082", "adv", "", 0, ["repeatedly; over and over again; several layers deep; layer upon layer"]]
  ]
}));
const redirectedLookup = service.lookup("\u5e7e\u91cd");
const redirectStub = redirectedLookup.entries.find((entry) => entry.dictionary === "Redirected" && entry.term === "\u5e7e\u91cd");
assert(redirectStub.redirectTargets.includes("\u5e7e\u91cd\u306b\u3082"), "Fragmented See details should produce a usable redirect target.");

await service.importDictionary(fileFromZip("mixed.zip", {
  "index.json": { title: "Mixed", targetLanguage: "en" },
  "term_bank_1.json": [[causeTerm, causeReading, "n", "", 0, [`noun; suru; intransitive; cause; origin; source; \u305d\u308c\u3067; ${causeTerm}; \u304c; \u5206\u304b\u3063\u305f\u3002; That accounts for the accident.; JMdict`]]]
}));
const mixedLookup = service.lookup(causeTerm);
assert.equal(mixedLookup.entries.some((entry) => entry.dictionary === "Mixed" && entry.definitions.includes("cause")), true);
assert.equal(lookup.frequencies[0].dictionary, "JPDB");
assert.equal(lookup.frequencies[0].displayValue, "440");
assert.equal(lookup.frequencies.some((entry) => entry.displayValue === "N4"), true);

await service.importDictionary({
  originalname: "legacy-rich.json",
  buffer: Buffer.from(JSON.stringify({
    title: "Legacy Rich",
    entries: [{
      term: "\u8a66\u9a13",
      reading: "\u3057\u3051\u3093",
      definitions: ["test"],
      details: ["test", "examination", "full legacy explanation"]
    }]
  }), "utf8")
});
const legacyRichLookup = service.lookup("\u8a66\u9a13");
const legacyRichEntry = legacyRichLookup.entries.find((entry) => entry.dictionary === "Legacy Rich");
assert(legacyRichEntry.details.includes("full legacy explanation"), "Legacy JSON details should be preserved.");

const exactKanaLookup = service.lookup(kanaLookUpTerm);
assert.equal(exactKanaLookup.entries[0].term, kanaLookUpTerm);
assert.equal(exactKanaLookup.entries.some((entry) => entry.term === kanjiSameReadingTerm), true);

await service.updateSettings(termImport.dictionary.id, { enabledForLookup: false });
assert.equal(service.lookup(lookup.entries[0].term).entries[0].dictionary, "Spanish");
await service.updateSettings(termImport.dictionary.id, { enabledForLookup: true });

await service.updateSettings(frequencyImport.dictionary.id, { enabledForLookup: false });
assert.equal(service.lookup(libraryTerm).frequencies.length, 0);
await service.updateSettings(frequencyImport.dictionary.id, { enabledForLookup: true });

const deleted = await service.deleteDictionary(secondImport.dictionary.id);
assert.equal(deleted.name, "Spanish");
const afterDelete = service.listMetadata();
assert.equal(afterDelete.some((item) => item.id === secondImport.dictionary.id), false);
assert.equal(afterDelete.find((item) => item.id === termImport.dictionary.id).selectedForWordBank, true);

await assert.rejects(
  () => service.importDictionary({ originalname: "invalid.json", buffer: Buffer.from(JSON.stringify([{ nope: true }])) }),
  /No valid dictionary/
);
assert.equal(saved > 0, true);

console.log("Dictionary service test passed.");

function fileFromZip(name, files) {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(JSON.stringify(contents), "utf8"));
  }
  return { originalname: name, buffer: zip.toBuffer() };
}
