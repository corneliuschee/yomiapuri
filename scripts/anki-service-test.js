import * as crypto from "node:crypto";
import assert from "node:assert/strict";
import { createAnkiService, buildAnkiFields, fieldMapForModel } from "../server/anki-service.js";
import { createJsonStateStore } from "../server/json-state-store.js";
import { createDefaultMediaProvider } from "../server/media-providers.js";

const state = {
  documents: [{ id: "doc-1", title: "Test Book" }],
  knownTerms: [],
  knownTermMeta: {},
  dictionaries: [],
  cards: [],
  anki: {
    connectUrl: "http://127.0.0.1:8765",
    deckName: "Mining",
    modelName: "Custom Mining",
    fieldMap: { Expression: "Expression", Reading: "Reading", Sentence: "Sentence", Meaning: "Meaning" },
    modelFieldMaps: {},
    retentionStats: null
  }
};

let saved = 0;
const store = createJsonStateStore({
  getState: () => state,
  setState: () => {},
  saveState: async () => {
    saved += 1;
  }
});

const ankiCalls = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  ankiCalls.push(body);
  const responses = {
    modelFieldNames: ["Word", "WordReading", "WordReadingHiragana", "Sentence", "SentenceReading", "Definition", "WordAudio", "SentenceAudio", "Audio", "Image", "Source"],
    findNotes: [1733919550242],
    notesInfo: [{ noteId: 1733919550242, modelName: "Mining Note", fields: { Expression: { value: "食べる" } } }],
    storeMediaFile: null,
    addNote: 12345,
    guiBrowse: [555]
  };
  return {
    ok: true,
    async json() {
      return { result: responses[body.action] ?? [], error: null };
    }
  };
};

const service = createAnkiService({
  store,
  mediaProvider: createDefaultMediaProvider(),
  lookupDictionary: () => [{ term: "図書館", reading: "としょかん", definitions: ["library"] }],
  normalizeJapaneseTerm: (value = "") => value.normalize("NFKC").trim(),
  extractTermsFromNotes: (notes, _fields = [], options = {}) => options.withMetadata
    ? notes.map((note) => ({ term: "食べる", noteId: note.noteId, modelName: note.modelName }))
    : ["食べる"],
  mergeKnownTerms: (terms, _addedAt, metadataByTerm = {}) => {
    for (const term of terms) {
      if (!state.knownTerms.includes(term)) state.knownTerms.push(term);
      state.knownTermMeta[term] = { ...(state.knownTermMeta[term] ?? {}), ...(metadataByTerm[term] ?? {}) };
    }
    return terms;
  },
  clearDocumentCache: () => {},
  crypto,
  renderSentenceHtml: async (sentence, target) => sentence.replace(
    target,
    `<span style="color:#ff5a3d;font-weight:700;"><ruby data-base="${target}" data-reading="ã¨ã—ã‚‡ã‹ã‚“">${target}<rt>ã¨ã—ã‚‡ã‹ã‚“</rt></ruby></span>`
  )
});

const mapped = buildAnkiFields(["Word", "Sentence", "Definition"], { Expression: "図書館", Sentence: "図書館へ行く。", Meaning: "library" }, {});
assert.equal(mapped.values.Word, "図書館");
assert.equal(mapped.values.Definition, "library");

const definitionMapped = buildAnkiFields(
  ["Expression", "PrimaryDefinition", "SecondaryDefinition", "ExtraDefition"],
  {
    Expression: "åŽŸå› ",
    PrimaryDefinition: "Jitendex.org [2024-05-20]: cause; origin",
    SecondaryDefinition: "æ–°å’Œè‹±: cause; reason",
    ExtraDefinition: "JMdict_english: source"
  },
  {}
);
assert.equal(definitionMapped.values.PrimaryDefinition, "Jitendex.org [2024-05-20]: cause; origin");
assert.equal(definitionMapped.values.SecondaryDefinition, "æ–°å’Œè‹±: cause; reason");
assert.equal(definitionMapped.values.ExtraDefition, "JMdict_english: source");

const jpMiningDetectedMap = fieldMapForModel(
  {
    fieldMap: { Expression: "Expression", Reading: "Reading", Sentence: "Sentence", Meaning: "Meaning", Audio: "Audio", Image: "Image" },
    modelFieldMaps: {
      "JP Mining Note": {
        Expression: "Word",
        Reading: "WordReadingHiragana",
        Sentence: "SentenceReading",
        Image: "Picture",
        Audio: "SentenceAudio"
      }
    }
  },
  "JP Mining Note",
  ["Key", "Word", "WordReading", "PrimaryDefinition", "PrimaryDefinitionPicture", "Sentence", "SentenceReading", "Picture", "WordAudio", "SentenceAudio", "WordReadingHiragana", "SecondaryDefinition", "ExtraDefinitions"]
);
assert.equal(jpMiningDetectedMap.Expression, "Word");
assert.equal(jpMiningDetectedMap.WordReading, "WordReading");
assert.equal(jpMiningDetectedMap.WordReadingHiragana, "WordReadingHiragana");
assert.equal(jpMiningDetectedMap.Sentence, "Sentence");
assert.equal(jpMiningDetectedMap.SentenceReading, "SentenceReading");
assert.equal(jpMiningDetectedMap.Image, "Picture");
assert.equal(jpMiningDetectedMap.WordAudio, "WordAudio");
assert.equal(jpMiningDetectedMap.SentenceAudio, "SentenceAudio");
assert.equal(jpMiningDetectedMap.Reading, undefined);
assert.equal(jpMiningDetectedMap.Audio, undefined);

const jpMiningMapped = buildAnkiFields(
  ["Key", "Word", "WordReading", "WordReadingHiragana", "PrimaryDefinition", "PrimaryDefinitionPicture", "Sentence", "SentenceReading", "IsSentenceCard", "Picture", "WordAudio", "SentenceAudio", "SecondaryDefinition", "ExtraDefinitions"],
  {
    Expression: "åŽŸå› ",
    Reading: "ã’ã‚“ã„ã‚“",
    Sentence: "åŽŸå› ãŒåˆ†ã‹ã£ãŸã€‚",
    PrimaryDefinition: "Jitendex.org [2024-05-20]: cause; origin",
    SecondaryDefinition: "æ–°å’Œè‹±: cause; reason",
    ExtraDefinition: "JMdict_english: source",
    Image: '<img src="kanji-reader-image-test.svg">',
    WordReading: "word reading",
    WordReadingHiragana: "word reading hiragana",
    SentenceReading: "sentence reading context",
    WordAudio: "",
    SentenceAudio: ""
  },
  {}
);
assert.equal(jpMiningMapped.values.Key, "åŽŸå› ");
assert.equal(jpMiningMapped.values.Word, "åŽŸå› ");
assert.equal(jpMiningMapped.values.PrimaryDefinition, "Jitendex.org [2024-05-20]: cause; origin");
assert.equal(jpMiningMapped.values.WordReading, "word reading");
assert.equal(jpMiningMapped.values.WordReadingHiragana, "word reading hiragana");
assert.equal(jpMiningMapped.values.PrimaryDefinitionPicture, "");
assert.equal(jpMiningMapped.values.Sentence, "åŽŸå› ãŒåˆ†ã‹ã£ãŸã€‚");
assert.equal(jpMiningMapped.values.SentenceReading, "sentence reading context");
assert.notEqual(jpMiningMapped.values.SentenceReading, jpMiningMapped.values.WordReading);
assert.equal(jpMiningMapped.values.IsSentenceCard, "");
assert.equal(jpMiningMapped.values.Picture, '<img src="kanji-reader-image-test.svg">');
assert.equal(jpMiningMapped.values.WordAudio, "");
assert.equal(jpMiningMapped.values.SentenceAudio, "");
assert.equal(jpMiningMapped.values.ExtraDefinitions, "JMdict_english: source");

const preview = await service.previewCard({
  documentId: "doc-1",
  expression: "図書館",
  dictionaryForm: "図書館",
  reading: "としょかん",
  sentence: "図書館へ行く。"
});
assert.equal(preview.values.Word, "図書館");
assert.equal(preview.values.Definition, "library");
assert.equal(preview.values.WordReading, preview.canonical.WordReading);
assert.equal(preview.values.WordReadingHiragana, preview.canonical.WordReadingHiragana);
assert.match(preview.values.Sentence, /<span style="color:#ff5a3d;font-weight:700;">/);
assert.match(preview.values.Sentence, /<ruby /);
assert.match(preview.values.Sentence, /<rt>/);
assert.match(preview.values.SentenceReading, /<span style="color:#ff5a3d;font-weight:700;">/);
assert.match(preview.values.SentenceReading, /<ruby /);
assert.equal(preview.values.SentenceReading, preview.canonical.SentenceReading);
assert.notEqual(preview.values.SentenceReading, preview.canonical.WordReading);
assert.equal(preview.media.audio.configured, false);

await service.importReviewedTerms({ preset: "reviewed-once", deckName: "Mining" });
assert.equal(ankiCalls.find((call) => call.action === "findNotes")?.params.query, 'deck:"Mining" prop:reps>0');
assert.deepEqual(state.knownTermMeta["食べる"].ankiNoteIds, [1733919550242]);
const opened = await service.openTerm("食べる");
assert.equal(opened.query, "nid:1733919550242");
const existingNoteIds = await service.existingNoteIds([1733919550242, 999]);
assert.deepEqual(existingNoteIds, [1733919550242]);

const exported = await service.exportCard({
  documentId: "doc-1",
  expression: "図書館",
  dictionaryForm: "図書館",
  reading: "としょかん",
  sentence: "図書館へ行く。",
  meaning: "library",
  fields: { Word: "図書館", Definition: "library" },
  fieldMapUpdates: { Expression: "Word", Meaning: "Definition" }
});
assert.equal(exported.ankiNoteId, 12345);
assert.equal(state.cards[0].fields.Word, "図書館");
assert.equal(state.anki.modelFieldMaps["Custom Mining"].Expression, "Word");
assert.equal(saved > 0, true);
assert.equal(ankiCalls.some((call) => call.action === "addNote"), true);

const audioCalls = [];
const generatedAudioExportService = createAnkiService({
  store,
  mediaProvider: {
    status: () => ({
      audio: { configured: true, label: "Local audio enabled" },
      image: { configured: false, label: "Local image disabled" }
    }),
    createAudio: async (payload, options) => {
      audioCalls.push({ payload, options });
      return payload.sentence ? "[sound:sentence-audio.wav]" : "[sound:word-audio.wav]";
    },
    createImage: async () => "",
    storeMediaFiles: async () => []
  },
  lookupDictionary: () => [{ term: "fast-word", reading: "fast-reading", definitions: ["fast meaning"] }],
  normalizeJapaneseTerm: (value = "") => value.normalize("NFKC").trim(),
  extractTermsFromNotes: () => [],
  mergeKnownTerms: (terms, _addedAt, metadataByTerm = {}) => {
    for (const term of terms) {
      if (!state.knownTerms.includes(term)) state.knownTerms.push(term);
      state.knownTermMeta[term] = { ...(state.knownTermMeta[term] ?? {}), ...(metadataByTerm[term] ?? {}) };
    }
    return terms;
  },
  clearDocumentCache: () => {},
  crypto
});
const callCountBeforeGeneratedAudioExport = ankiCalls.length;
const generatedAudioExport = await generatedAudioExportService.exportCard({
  documentId: "doc-1",
  expression: "fast-word",
  dictionaryForm: "fast-word",
  reading: "fast-reading",
  sentence: "This is the full sentence.",
  meaning: "fast meaning",
  fields: {
    Word: "fast-word",
    WordAudio: "",
    SentenceAudio: ""
  }
});
const generatedAudioAddNote = ankiCalls.slice(callCountBeforeGeneratedAudioExport).find((call) => call.action === "addNote");
assert.equal(generatedAudioAddNote.params.note.fields.WordAudio, "[sound:word-audio.wav]");
assert.equal(generatedAudioAddNote.params.note.fields.SentenceAudio, "[sound:sentence-audio.wav]");
assert.deepEqual(generatedAudioExport.media.skippedAudioFields, []);
assert.deepEqual(audioCalls.map((call) => call.options), [{ generate: true }, { generate: true }]);
assert.deepEqual(audioCalls[0].payload, { expression: "fast-word", sentence: "" });
assert.deepEqual(audioCalls[1].payload, { expression: "fast-word", sentence: "This is the full sentence." });

const mediaExportService = createAnkiService({
  store,
  mediaProvider: {
    status: () => ({
      audio: { configured: true, label: "Local audio enabled" },
      image: { configured: true, label: "Local image enabled" }
    }),
    createAudio: async () => "[sound:kanji-reader-audio-test.wav]",
    createImage: async () => '<img src="kanji-reader-image-test.svg">',
    storeMediaFiles: async (connect, fields) => {
      if (String(fields.Audio ?? "").includes("[sound:")) await connect("storeMediaFile", { filename: "kanji-reader-audio-test.wav", data: "AA==" });
      if (String(fields.Image ?? "").includes("<img")) await connect("storeMediaFile", { filename: "kanji-reader-image-test.svg", data: "AA==" });
      return ["kanji-reader-audio-test.wav", "kanji-reader-image-test.svg"];
    }
  },
  lookupDictionary: () => [{ term: "å›³æ›¸é¤¨", reading: "ã¨ã—ã‚‡ã‹ã‚“", definitions: ["library"] }],
  normalizeJapaneseTerm: (value = "") => value.normalize("NFKC").trim(),
  extractTermsFromNotes: () => [],
  mergeKnownTerms: (terms, _addedAt, metadataByTerm = {}) => {
    for (const term of terms) {
      if (!state.knownTerms.includes(term)) state.knownTerms.push(term);
      state.knownTermMeta[term] = { ...(state.knownTermMeta[term] ?? {}), ...(metadataByTerm[term] ?? {}) };
    }
    return terms;
  },
  clearDocumentCache: () => {},
  crypto
});
const callCountBeforeMediaExport = ankiCalls.length;
await mediaExportService.exportCard({
  documentId: "doc-1",
  expression: "éŸ³å£°",
  dictionaryForm: "éŸ³å£°",
  reading: "ãŠã‚“ã›ã„",
  sentence: "éŸ³å£°ã‚’ç¢ºèªã™ã‚‹ã€‚",
  meaning: "audio",
  fields: {
    Word: "éŸ³å£°",
    Audio: "[sound:kanji-reader-audio-test.wav]",
    Image: '<img src="kanji-reader-image-test.svg">'
  }
});
const mediaExportCalls = ankiCalls.slice(callCountBeforeMediaExport);
assert.deepEqual(mediaExportCalls.slice(0, 2).map((call) => call.action), ["storeMediaFile", "storeMediaFile"]);
assert.equal(mediaExportCalls.at(-1).action, "addNote");

const createLauncherTestService = (ankiLauncher) => createAnkiService({
  store,
  mediaProvider: createDefaultMediaProvider(),
  lookupDictionary: () => [],
  normalizeJapaneseTerm: (value = "") => value.normalize("NFKC").trim(),
  extractTermsFromNotes: () => [],
  mergeKnownTerms: (terms) => terms,
  clearDocumentCache: () => {},
  crypto,
  ankiLauncher
});

const previousFetch = globalThis.fetch;
state.anki.autoLaunchAnki = true;
let launcherCalls = 0;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  return {
    ok: true,
    async json() {
      return { result: body.action === "deckNames" ? ["Mining"] : null, error: null };
    }
  };
};
assert.deepEqual(await createLauncherTestService({ ensureRunning: async () => { launcherCalls += 1; } }).connect("deckNames"), ["Mining"]);
assert.equal(launcherCalls, 0);

let retryFetchCalls = 0;
launcherCalls = 0;
globalThis.fetch = async (_url, options) => {
  retryFetchCalls += 1;
  if (retryFetchCalls === 1) throw new TypeError("fetch failed");
  const body = JSON.parse(options.body);
  return {
    ok: true,
    async json() {
      return { result: body.action === "deckNames" ? ["Mining"] : null, error: null };
    }
  };
};
assert.deepEqual(await createLauncherTestService({ ensureRunning: async () => { launcherCalls += 1; } }).connect("deckNames"), ["Mining"]);
assert.equal(launcherCalls, 1);
assert.equal(retryFetchCalls, 2);

state.anki.autoLaunchAnki = false;
launcherCalls = 0;
globalThis.fetch = async () => {
  throw new TypeError("fetch failed");
};
await assert.rejects(
  () => createLauncherTestService({ ensureRunning: async () => { launcherCalls += 1; } }).connect("deckNames"),
  /fetch failed/
);
assert.equal(launcherCalls, 0);

state.anki.autoLaunchAnki = true;
await assert.rejects(
  () => createLauncherTestService({ ensureRunning: async () => { throw new Error("Could not start Anki Desktop or AnkiConnect did not become ready."); } }).connect("deckNames"),
  /Could not start Anki Desktop/
);
globalThis.fetch = previousFetch;

console.log("Anki service test passed.");
