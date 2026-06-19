export const CANONICAL_CARD_FIELDS = [
  "Expression",
  "Reading",
  "WordReading",
  "WordReadingHiragana",
  "SentenceReading",
  "Sentence",
  "Meaning",
  "PrimaryDefinition",
  "SecondaryDefinition",
  "ExtraDefinition",
  "Audio",
  "WordAudio",
  "SentenceAudio",
  "Image",
  "Source",
  "DictionaryForm"
];

export function createAnkiService({
  store,
  mediaProvider,
  lookupDictionary,
  normalizeJapaneseTerm,
  extractTermsFromNotes,
  mergeKnownTerms,
  clearDocumentCache,
  crypto,
  ankiLauncher = null,
  renderSentenceHtml = null
}) {
  const requestAnkiConnect = async (settings, action, params = {}) => {
    const response = await fetch(settings.connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params })
    });
    if (!response.ok) throw new Error(`AnkiConnect request failed with ${response.status}.`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    return payload.result;
  };
  const connect = async (action, params = {}) => {
    const settings = store.anki.getSettings();
    try {
      return await requestAnkiConnect(settings, action, params);
    } catch (error) {
      if (!settings.autoLaunchAnki || !ankiLauncher || !isAnkiConnectUnreachable(error)) throw error;
      await ankiLauncher?.ensureRunning(settings);
      return requestAnkiConnect(store.anki.getSettings(), action, params);
    }
  };

  const service = {
    connect,
    async listDecksAndModels() {
      const [decks, models] = await Promise.all([connect("deckNames"), connect("modelNames")]);
      return { decks, models, settings: store.anki.getSettings() };
    },
    async modelFields(modelName) {
      const selectedModel = modelName || store.anki.getSettings().modelName;
      if (!selectedModel) return { modelName: "", fields: [], fieldMap: {}, media: await mediaProvider.status() };
      const fields = await connect("modelFieldNames", { modelName: selectedModel });
      return {
        modelName: selectedModel,
        fields,
        fieldMap: fieldMapForModel(store.anki.getSettings(), selectedModel, fields),
        media: await mediaProvider.status()
      };
    },
    async importReviewedTerms({ preset = "reviewed", deckName = "", query = "" }) {
      const settings = store.anki.getSettings();
      const presetQueries = {
        "reviewed-once": "prop:reps>0",
        reviewed: "rated:365",
        mature: "prop:ivl>=21",
        all: ""
      };
      const normalizedPreset = ["reviewed-once", "reviewed", "mature", "all"].includes(preset) ? preset : "reviewed-once";
      const deck = deckName || settings.deckName;
      const deckQuery = deck ? `deck:${JSON.stringify(deck)}` : "";
      const queryParts = [deckQuery, presetQueries[normalizedPreset]].filter(Boolean);
      const finalQuery = query?.trim() || queryParts.join(" ") || "rated:365";

      const noteIdsFromQuery = await connect("findNotes", { query: finalQuery });
      const noteIds = [...new Set(noteIdsFromQuery)];
      const importedTerms = new Set();
      const importedTermMeta = {};
      const importedAt = new Date().toISOString();
      for (const batch of chunkArray(noteIds, 75)) {
        const notes = await connect("notesInfo", { notes: batch });
        for (const entry of extractTermsFromNotes(notes, [], { withMetadata: true })) {
          const term = typeof entry === "string" ? normalizeJapaneseTerm(entry) : normalizeJapaneseTerm(entry.term);
          if (!term) continue;
          importedTerms.add(term);
          importedTermMeta[term] ??= { ankiNoteIds: [], ankiDeckName: deck, ankiModelName: "", importedAt };
          const noteId = Number(entry.noteId);
          if (Number.isFinite(noteId) && !importedTermMeta[term].ankiNoteIds.includes(noteId)) importedTermMeta[term].ankiNoteIds.push(noteId);
          if (entry.deckName) importedTermMeta[term].ankiDeckName = entry.deckName;
          if (entry.modelName) importedTermMeta[term].ankiModelName = entry.modelName;
        }
      }

      const importedList = [...importedTerms];
      const added = await store.knownTerms.merge(importedList, mergeKnownTerms, importedTermMeta);
      clearDocumentCache();
      const retentionStats = {
        preset: normalizedPreset,
        query: finalQuery,
        importedTerms: importedList.length,
        addedTerms: added.length,
        notes: noteIds.length,
        cards: 0,
        reviews: 0,
        lapses: 0,
        matureCards: 0,
        averageInterval: 0,
        importedAt
      };
      await store.anki.saveRetentionStats(retentionStats);
      return { imported: importedList.length, total: store.getState().knownTerms.length, retentionStats };
    },
    async previewCard(input) {
      const document = store.documents.findById(input.documentId);
      if (!document) throw Object.assign(new Error("Document not found."), { status: 404 });
      const settings = store.anki.getSettings();
      const modelName = input.modelName?.trim() || settings.modelName;
      const deckName = input.deckName?.trim() || settings.deckName;
      if (!modelName) throw Object.assign(new Error("Choose an Anki note type before previewing."), { status: 422 });

      const expression = normalizeJapaneseTerm(input.expression);
      if (!expression) throw Object.assign(new Error("Expression is required."), { status: 400 });

      const dictionaryForm = normalizeJapaneseTerm(input.dictionaryForm || expression);
      const dictionaryEntries = lookupDictionary(dictionaryForm);
      const definitionSlots = definitionSlotsFromDictionaryEntries(dictionaryEntries, input.meaning);
      const meaning = input.meaning?.trim() || definitionSlots.PrimaryDefinition || "";
      const sentence = input.sentence ?? "";
      const sentenceHtml = await renderCardSentenceHtml(sentence, input.surface || expression, renderSentenceHtml, {
        expression,
        dictionaryForm,
        reading: input.reading ?? ""
      });
      const canonical = {
        Expression: expression,
        Reading: input.reading ?? "",
        WordReading: input.reading ?? "",
        WordReadingHiragana: toHiragana(input.reading ?? ""),
        SentenceReading: sentenceHtml,
        Sentence: sentenceHtml,
        Meaning: meaning,
        PrimaryDefinition: definitionSlots.PrimaryDefinition,
        SecondaryDefinition: definitionSlots.SecondaryDefinition,
        ExtraDefinition: definitionSlots.ExtraDefinition,
        Audio: "",
        WordAudio: "",
        SentenceAudio: "",
        Image: "",
        Source: document.title,
        DictionaryForm: dictionaryForm
      };

      let fields = [];
      try {
        fields = await connect("modelFieldNames", { modelName });
      } catch {
        fields = Object.values(fieldMapForModel(settings, modelName, [])).filter(Boolean);
      }
      const fieldMap = fieldMapForModel(settings, modelName, fields);
      const { values, unmappedFields, suggestedMap } = buildAnkiFields(fields, canonical, fieldMap);
      return {
        deckName,
        modelName,
        canonical,
        fields,
        values,
        fieldMap: suggestedMap,
        unmappedFields,
        dictionaryEntries,
        media: await mediaProvider.status()
      };
    },
    async exportCard(input) {
      const document = store.documents.findById(input.documentId);
      if (!document) throw Object.assign(new Error("Document not found."), { status: 404 });
      const settings = store.anki.getSettings();
      const deckName = input.deckName?.trim() || settings.deckName;
      const modelName = input.modelName?.trim() || settings.modelName;
      if (!deckName || !modelName) throw Object.assign(new Error("Choose an Anki deck and note type before exporting."), { status: 422 });

      const expression = normalizeJapaneseTerm(input.expression);
      if (!expression) throw Object.assign(new Error("Expression is required."), { status: 400 });
      const dictionaryForm = normalizeJapaneseTerm(input.dictionaryForm || expression);
      const fields = sanitizeFields(input.fields);
      if (Object.keys(fields).length === 0) throw Object.assign(new Error("At least one Anki field is required."), { status: 400 });
      ensureFirstFieldValue(fields, Object.keys(fields), {
        Expression: expression,
        DictionaryForm: dictionaryForm,
        Sentence: input.sentence ?? "",
        Meaning: input.meaning ?? ""
      });
      if (isEmptyFieldPayload(fields)) {
        throw Object.assign(new Error("Reviewed Anki fields are empty. Check the note field mapping before exporting."), { status: 422 });
      }
      const mediaFill = await fillGeneratedMediaFields({
        fields,
        fieldMap: fieldMapForModel(settings, modelName, Object.keys(fields)),
        mediaProvider,
        expression,
        reading: input.reading ?? "",
        sentence: input.sentence ?? "",
        meaning: input.meaning ?? "",
        source: document.title
      });
      const storedMedia = await mediaProvider.storeMediaFiles(connect, fields);

      const noteId = await connect("addNote", {
        note: {
          deckName,
          modelName,
          fields,
          options: { allowDuplicate: false },
          tags: ["sentence-mining", "kanji-reader"]
        }
      });

      if (input.fieldMapUpdates && Object.keys(input.fieldMapUpdates).length > 0) {
        await store.anki.saveModelFieldMap(modelName, sanitizeFields(input.fieldMapUpdates));
      }

      const exported = {
        id: crypto.randomUUID(),
        ankiNoteId: noteId,
        documentId: document.id,
        expression,
        dictionaryForm,
        reading: input.reading ?? "",
        sentence: input.sentence ?? "",
        meaning: input.meaning ?? "",
        source: document.title,
        deckName,
        modelName,
        fields,
        media: {
          stored: storedMedia,
          skippedAudioFields: mediaFill.skippedAudioFields
        },
        createdAt: new Date().toISOString()
      };
      await store.cards.add(exported);
      await store.knownTerms.merge([expression], mergeKnownTerms, {
        [expression]: {
          ankiNoteIds: [Number(noteId)].filter(Number.isFinite),
          ankiDeckName: deckName,
          ankiModelName: modelName,
          importedAt: exported.createdAt
        }
      });
      clearDocumentCache();
      return exported;
    },
    async hasNote(noteId) {
      const normalized = Number(noteId);
      if (!Number.isFinite(normalized)) return false;
      const notes = await connect("findNotes", { query: `nid:${normalized}` });
      return Array.isArray(notes) && notes.map(Number).includes(normalized);
    },
    async openTerm(term = "") {
      const normalized = normalizeJapaneseTerm(term);
      if (!normalized) throw Object.assign(new Error("Vocabulary term is required."), { status: 400 });
      const storedNoteIds = store.getState().knownTermMeta?.[normalized]?.ankiNoteIds ?? [];
      let noteId = NaN;
      for (const candidateNoteId of storedNoteIds.map(Number).filter(Number.isFinite)) {
        const notes = await connect("findNotes", { query: `nid:${candidateNoteId}` });
        if (Array.isArray(notes) && notes.map(Number).includes(candidateNoteId)) {
          noteId = candidateNoteId;
          break;
        }
      }
      const query = Number.isFinite(noteId) ? `nid:${noteId}` : quoteAnkiSearchTerm(normalized);
      const cards = await connect("guiBrowse", { query });
      return { term: normalized, noteId: Number.isFinite(noteId) ? noteId : null, query, cards: Array.isArray(cards) ? cards : [] };
    },
    async existingNoteIds(noteIds = []) {
      const ids = [...new Set(noteIds.map(Number).filter(Number.isFinite))];
      if (ids.length === 0) return [];
      const found = new Set();
      for (const batch of chunkArray(ids, 50)) {
        const query = batch.map((id) => `nid:${id}`).join(" OR ");
        const notes = await connect("findNotes", { query });
        for (const noteId of notes ?? []) {
          const normalized = Number(noteId);
          if (Number.isFinite(normalized)) found.add(normalized);
        }
      }
      return [...found];
    }
  };

  return service;
}

export function buildAnkiFields(fields = [], canonical = {}, existingMap = {}) {
  const values = {};
  const unmappedFields = [];
  const suggestedMap = {};
  const fieldNames = fields.length > 0 ? fields : Object.values(existingMap).filter(Boolean);

  for (const field of fieldNames) {
    const canonicalName = canonicalFieldForAnkiField(field, existingMap);
    if (canonicalName && canonical[canonicalName] !== undefined) {
      values[field] = canonical[canonicalName] ?? "";
      suggestedMap[canonicalName] = field;
    } else {
      values[field] = "";
      unmappedFields.push(field);
    }
  }

  ensureFirstFieldValue(values, fieldNames, canonical);
  return { values, unmappedFields, suggestedMap };
}

export function fieldMapForModel(settings = {}, modelName = "", fields = []) {
  const legacyMap = settings.fieldMap ?? {};
  const modelMap = settings.modelFieldMaps?.[modelName] ?? {};
  const detected = {};
  const protectedDetected = {};
  for (const field of fields) {
    const canonical = inferCanonicalField(field);
    if (canonical && !detected[canonical]) detected[canonical] = field;
    if (canonical && isProtectedExactField(field, canonical)) protectedDetected[canonical] = field;
  }
  return cleanConflictingGenericMappings({ ...legacyMap, ...detected, ...modelMap, ...protectedDetected });
}

export function inferCanonicalField(fieldName = "") {
  const normalized = fieldName.toLowerCase();
  if (/^(key|id|noteid|note_id)$/.test(normalized)) return "Expression";
  if (/^(word|vocab|vocabulary|expression|term|target)$/.test(normalized)) return "Expression";
  if (/^(wordreadinghiragana|word_reading_hiragana)$/.test(normalized)) return "WordReadingHiragana";
  if (/^(wordreading|word_reading)$/.test(normalized)) return "WordReading";
  if (/^(sentence|context|例文)$/.test(normalized)) return "Sentence";
  if (/^(sentencereading|sentence_reading)$/.test(normalized)) return "SentenceReading";
  if (/^(primarydefinitionpicture|primary_definition_picture)$/.test(normalized)) return "";
  if (/^(picture|image|screenshot|photo)$/.test(normalized)) return "Image";
  if (/^(wordaudio|word_audio)$/.test(normalized)) return "WordAudio";
  if (/^(sentenceaudio|sentence_audio)$/.test(normalized)) return "SentenceAudio";
  if (/^(audio|sound|voice)$/.test(normalized)) return "Audio";
  if (/^(pa|ajt|alt|is|separate|frequency|utility)/.test(normalized)) return "";
  if (/^(additionalnotes|hint|hintnothidden|comment|pagraphs|papositions|pasilence)$/.test(normalized)) return "";
  if (/(image|picture|screenshot|photo)/.test(normalized)) return "Image";
  if (/(word.*audio|audio.*word|word.*sound|sound.*word)/.test(normalized)) return "WordAudio";
  if (/(sentence.*audio|audio.*sentence|context.*audio|audio.*context)/.test(normalized)) return "SentenceAudio";
  if (/(audio|sound|voice)/.test(normalized)) return "Audio";
  if (/(primary.*def|primarydefinition|primary_definition|first.*def)/.test(normalized)) return "PrimaryDefinition";
  if (/(secondary.*def|secondarydefinition|secondary_definition|second.*def)/.test(normalized)) return "SecondaryDefinition";
  if (/(extra.*def|extradefinitions|extradefinition|extradefition|extra_definition|additional.*def|other.*def)/.test(normalized)) return "ExtraDefinition";
  if (/(meaning|definition|english|gloss|back)/.test(normalized)) return "Meaning";
  if (/(wordreadinghiragana|word_reading_hiragana)/.test(normalized)) return "WordReadingHiragana";
  if (/(wordreading|word_reading)/.test(normalized)) return "WordReading";
  if (/(sentencereading|sentence_reading)/.test(normalized)) return "SentenceReading";
  if (/(reading|kana|furigana|yomi|pronunciation)/.test(normalized)) return "Reading";
  if (/(sentence|例文|context|cloze)/.test(normalized)) return "Sentence";
  if (/(expression|vocab|vocabulary|word|term|target|kanji|japanese|front)/.test(normalized)) return "Expression";
  if (/(source|book|title|origin)/.test(normalized)) return "Source";
  if (/(dictionary|base|lemma)/.test(normalized)) return "DictionaryForm";
  return "";
}

function canonicalFieldForAnkiField(fieldName, fieldMap) {
  const inferred = inferCanonicalField(fieldName);
  if ([
    "Sentence",
    "Image",
    "PrimaryDefinition",
    "SecondaryDefinition",
    "ExtraDefinition",
    "WordReading",
    "WordReadingHiragana",
    "SentenceReading",
    "WordAudio",
    "SentenceAudio"
  ].includes(inferred)) return inferred;
  const mapped = Object.entries(fieldMap).find(([, ankiField]) => ankiField === fieldName)?.[0];
  return CANONICAL_CARD_FIELDS.includes(mapped) ? mapped : inferred;
}

function isProtectedExactField(fieldName = "", canonical = "") {
  const normalized = fieldName.toLowerCase();
  return [
    "word",
    "wordreading",
    "wordreadinghiragana",
    "sentence",
    "sentencereading",
    "primarydefinition",
    "secondarydefinition",
    "extradefinition",
    "extradefinitions",
    "wordaudio",
    "sentenceaudio"
  ].includes(normalized) && CANONICAL_CARD_FIELDS.includes(canonical);
}

function cleanConflictingGenericMappings(fieldMap = {}) {
  const next = { ...fieldMap };
  if (next.WordReading && next.Reading === next.WordReading) delete next.Reading;
  if (next.WordReadingHiragana && next.Reading === next.WordReadingHiragana) delete next.Reading;
  if (next.SentenceReading && next.Sentence === next.SentenceReading) delete next.Sentence;
  if (next.WordAudio && next.Audio === next.WordAudio) delete next.Audio;
  if (next.SentenceAudio && next.Audio === next.SentenceAudio) delete next.Audio;
  return next;
}

function sanitizeFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields)
      .map(([key, value]) => [String(key), String(value ?? "")])
      .filter(([key]) => key.trim())
  );
}

function ensureFirstFieldValue(values = {}, fieldNames = [], canonical = {}) {
  const firstField = fieldNames[0];
  if (!firstField || stripHtml(String(values[firstField] ?? "")).trim()) return;
  values[firstField] = canonical.Expression || canonical.DictionaryForm || canonical.Sentence || canonical.Meaning || "";
}

async function fillGeneratedMediaFields({
  fields = {},
  fieldMap = {},
  mediaProvider,
  expression = "",
  reading = "",
  sentence = "",
  meaning = "",
  source = ""
} = {}) {
  const fieldNames = Object.keys(fields);
  const skippedAudioFields = [];
  for (const fieldName of fieldNames) {
    if (stripHtml(String(fields[fieldName] ?? "")).trim()) continue;
    const canonical = canonicalFieldForAnkiField(fieldName, fieldMap);
    if (["Audio", "WordAudio", "SentenceAudio"].includes(canonical)) {
      fields[fieldName] = await mediaProvider.createAudio(audioPayloadForField(fieldName, { expression, sentence }), { generate: true });
      if (!fields[fieldName]) skippedAudioFields.push(fieldName);
    } else if (canonical === "Image") {
      fields[fieldName] = await mediaProvider.createImage({ expression, reading, meaning, source });
    }
  }
  return { skippedAudioFields };
}

function audioPayloadForField(fieldName = "", { expression = "", sentence = "" } = {}) {
  const normalized = fieldName.toLowerCase();
  if (/word|vocab|expression|term/.test(normalized) && !/sentence/.test(normalized)) {
    return { expression, sentence: "" };
  }
  if (/sentence|context|例文/.test(normalized)) {
    return { expression, sentence };
  }
  return { expression, sentence: sentence || expression };
}

function definitionSlotsFromDictionaryEntries(dictionaryEntries = [], fallbackMeaning = "") {
  const blocks = groupedDictionaryDefinitionBlocks(dictionaryEntries);
  const fallback = String(fallbackMeaning ?? "").trim();
  return {
    PrimaryDefinition: blocks[0] || fallback,
    SecondaryDefinition: blocks[1] || "",
    ExtraDefinition: blocks.slice(2).join("\n\n")
  };
}

function groupedDictionaryDefinitionBlocks(dictionaryEntries = []) {
  const grouped = new Map();
  for (const entry of dictionaryEntries) {
    const dictionary = String(entry.dictionary ?? "").trim();
    const key = dictionary || `entry:${grouped.size}`;
    if (!grouped.has(key)) grouped.set(key, { dictionary, definitions: [] });
    const target = grouped.get(key);
    for (const definition of entry.definitions ?? []) {
      const normalized = String(definition ?? "").trim();
      if (normalized && !target.definitions.includes(normalized)) target.definitions.push(normalized);
    }
  }
  return [...grouped.values()].map(formatDictionaryDefinitionBlock).filter(Boolean);
}

function formatDictionaryDefinitionBlock(entry = {}) {
  const definitions = [...new Set((entry.definitions ?? []).map((definition) => String(definition ?? "").trim()).filter(Boolean))];
  if (definitions.length === 0) return "";
  const dictionary = String(entry.dictionary ?? "").trim();
  const body = definitions.slice(0, 8).join("; ");
  return dictionary ? `${dictionary}: ${body}` : body;
}

function isEmptyFieldPayload(fields = {}) {
  return Object.values(fields).every((value) => stripHtml(String(value ?? "")).trim() === "");
}

function stripHtml(value = "") {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ");
}

function toHiragana(value = "") {
  return String(value ?? "").replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

async function renderCardSentenceHtml(sentence = "", target = "", renderSentenceHtml = null, context = {}) {
  if (typeof renderSentenceHtml === "function") {
    try {
      const rendered = await renderSentenceHtml(sentence, target, context);
      if (typeof rendered === "string" && rendered.trim()) return rendered;
    } catch {
      // Fall back to escaped highlighted text so Anki export remains available if token analysis fails.
    }
  }
  return highlightSentenceTarget(sentence, target);
}

function highlightSentenceTarget(sentence = "", target = "") {
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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function quoteAnkiSearchTerm(value = "") {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isAnkiConnectUnreachable(error) {
  const message = String(error?.message ?? "");
  return error?.name === "TypeError" ||
    /fetch failed|failed to fetch|networkerror|econnrefused|econnreset|enotfound|etimedout|unable to connect/i.test(message);
}
