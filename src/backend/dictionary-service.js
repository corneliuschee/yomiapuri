import AdmZip from "adm-zip";
import path from "node:path";

export function createDictionaryService({ store, normalizeJapaneseTerm, repairMojibake, crypto, deferStoreSave = false, dictionaryStore = null }) {
  const getState = () => store.getState();
  const indexCache = new Map();
  const storeUpdateOptions = deferStoreSave ? { save: false } : {};

  return {
    listMetadata() {
      repairDictionaryState(getState(), { normalizeJapaneseTerm });
      return dictionaryMetadata(getState().dictionaries);
    },

    async importDictionary(file, displayName = "") {
      const parsed = parseDictionaryUpload(file, { normalizeJapaneseTerm, repairMojibake });
      if (parsed.entries.length === 0 && parsed.frequencyEntries.length === 0) {
        throw Object.assign(new Error("No valid dictionary terms or frequency rows were found."), { status: 422 });
      }

      let created;
      await store.update((state) => {
        repairDictionaryState(state, { normalizeJapaneseTerm });
        const type = parsed.frequencyEntries.length > 0 && parsed.entries.length === 0 ? "frequency" : "term";
        const sortOrder = nextSortOrder(state.dictionaries, type);
        created = {
          id: crypto.randomUUID(),
          name: displayName.trim() || parsed.title || path.parse(repairMojibake(file.originalname)).name,
          filename: repairMojibake(file.originalname),
          importedAt: new Date().toISOString(),
          type,
          language: parsed.language,
          format: parsed.format,
          enabledForLookup: true,
          selectedForWordBank: type === "term" && !state.dictionaries.some((item) => item.type === "term" && item.selectedForWordBank),
          sortOrder,
          validationStatus: "valid",
          entries: parsed.entries,
          frequencyEntries: parsed.frequencyEntries
        };
        state.dictionaries.push(created);
        enforceDictionaryRoles(state);
        return created;
      }, storeUpdateOptions);
      return { dictionary: dictionaryMetadata([created])[0], validation: parsed.validation };
    },

    async updateSettings(id, patch = {}) {
      let updated;
      await store.update((state) => {
        repairDictionaryState(state, { normalizeJapaneseTerm });
        const dictionary = state.dictionaries.find((item) => item.id === id);
        if (!dictionary) throw Object.assign(new Error("Dictionary not found."), { status: 404 });
        if (typeof patch.enabledForLookup === "boolean") dictionary.enabledForLookup = patch.enabledForLookup;
        if (typeof patch.selectedForWordBank === "boolean") dictionary.selectedForWordBank = patch.selectedForWordBank;
        if (Number.isFinite(Number(patch.sortOrder))) dictionary.sortOrder = Number(patch.sortOrder);
        if (dictionary.type === "frequency") dictionary.selectedForWordBank = false;
        enforceDictionaryRoles(state, dictionary.id);
        updated = dictionaryMetadata([dictionary])[0];
        return updated;
      }, storeUpdateOptions);
      return updated;
    },

    async deleteDictionary(id) {
      let deleted;
      await store.update((state) => {
        repairDictionaryState(state, { normalizeJapaneseTerm });
        const index = state.dictionaries.findIndex((item) => item.id === id);
        if (index < 0) throw Object.assign(new Error("Dictionary not found."), { status: 404 });
        deleted = dictionaryMetadata([state.dictionaries[index]])[0];
        state.dictionaries.splice(index, 1);
        enforceDictionaryRoles(state);
        return deleted;
      }, storeUpdateOptions);
      return deleted;
    },

    lookup(term, options = {}) {
      const state = getState();
      repairDictionaryState(state, { normalizeJapaneseTerm });
      const normalized = normalizeJapaneseTerm(term);
      if (!normalized) return { entries: [], frequencies: [] };
      const prefix = Boolean(options.prefix && state.dictionarySettings?.prefixWildcardSearch);
      const termDictionaries = orderedDictionaries(state.dictionaries).filter((dictionary) => dictionary.type === "term" && dictionary.enabledForLookup);
      const entries = lookupSqlTermDictionaries(dictionaryStore, termDictionaries, normalized, { prefix, limit: 24 })
        ?? lookupTermDictionaries(termDictionaries, normalized, { prefix, indexCache }).slice(0, 24);
      const frequencies = options.includeFrequencies === false
        ? []
        : (lookupSqlFrequencyDictionaries(dictionaryStore, state.dictionaries, normalized, { limit: 24 })
          ?? lookupFrequencyDictionaries(state.dictionaries, normalized, { indexCache }).slice(0, 24));
      return { entries, frequencies };
    },

    exactTerm(term) {
      const state = getState();
      repairDictionaryState(state, { normalizeJapaneseTerm });
      const normalized = normalizeJapaneseTerm(term);
      if (!normalized) return null;
      const dictionaries = orderedDictionaries(state.dictionaries).filter((item) => item.type === "term" && item.enabledForLookup);
      const sqlEntry = lookupSqlTermDictionaries(dictionaryStore, dictionaries, normalized, { prefix: false, limit: 1 })?.[0];
      if (sqlEntry) {
        return {
          term: sqlEntry.term,
          reading: sqlEntry.reading,
          redirectTargets: sqlEntry.redirectTargets ?? [],
          dictionary: sqlEntry.dictionary,
          dictionaryId: sqlEntry.dictionaryId,
          sortOrder: sqlEntry.sortOrder
        };
      }
      for (const dictionary of dictionaries) {
        const entry = exactTermDictionaryEntry(dictionary, normalized, { indexCache });
        if (entry) return entry;
      }
      return null;
    },

    lookupWordBank(term, dictionaryId = "") {
      const state = getState();
      repairDictionaryState(state, { normalizeJapaneseTerm });
      const normalized = normalizeJapaneseTerm(term);
      const dictionary = dictionaryId
        ? state.dictionaries.find((item) => item.id === dictionaryId && item.type === "term")
        : selectedWordBankDictionary(state.dictionaries);
      if (!normalized || !dictionary) return [];
      return lookupSqlTermDictionaries(dictionaryStore, [dictionary], normalized, { prefix: false, limit: 3 })
        ?? lookupTermDictionaries([dictionary], normalized, { prefix: false, indexCache }).slice(0, 3);
    },

    lookupWordBankMany(terms = [], dictionaryId = "") {
      const state = getState();
      repairDictionaryState(state, { normalizeJapaneseTerm });
      const normalizedTerms = [...new Set((Array.isArray(terms) ? terms : [])
        .map(normalizeJapaneseTerm)
        .filter(Boolean))];
      const dictionary = dictionaryId
        ? state.dictionaries.find((item) => item.id === dictionaryId && item.type === "term")
        : selectedWordBankDictionary(state.dictionaries);
      const result = new Map(normalizedTerms.map((term) => [term, []]));
      if (normalizedTerms.length === 0 || !dictionary) return result;
      const sqlRows = lookupSqlTermDictionariesBatch(dictionaryStore, dictionary, normalizedTerms, { limitPerTerm: 3 });
      if (sqlRows) return sqlRows;
      for (const term of normalizedTerms) {
        result.set(term, lookupTermDictionaries([dictionary], term, { prefix: false, indexCache }).slice(0, 3));
      }
      return result;
    },

    async updateLookupSettings(patch = {}) {
      let settings;
      await store.update((state) => {
        state.dictionarySettings = {
          prefixWildcardSearch: false,
          ...(state.dictionarySettings ?? {}),
          ...(typeof patch.prefixWildcardSearch === "boolean" ? { prefixWildcardSearch: patch.prefixWildcardSearch } : {})
        };
        settings = state.dictionarySettings;
        return settings;
      }, storeUpdateOptions);
      return settings;
    }
  };
}

export function repairDictionaryState(state, { normalizeJapaneseTerm }) {
  state.dictionarySettings = { prefixWildcardSearch: false, ...(state.dictionarySettings ?? {}) };
  state.dictionaries = Array.isArray(state.dictionaries) ? state.dictionaries : [];
  let repaired = false;
  state.dictionaries.forEach((dictionary, index) => {
    dictionary.type ??= Array.isArray(dictionary.frequencyEntries) && dictionary.frequencyEntries.length > 0 && !Array.isArray(dictionary.entries) ? "frequency" : "term";
    dictionary.language ??= "unknown";
    dictionary.format ??= dictionary.format || "legacy";
    dictionary.enabledForLookup = typeof dictionary.enabledForLookup === "boolean" ? dictionary.enabledForLookup : true;
    dictionary.selectedForWordBank = Boolean(dictionary.selectedForWordBank && dictionary.type === "term");
    dictionary.sortOrder = Number.isFinite(Number(dictionary.sortOrder)) ? Number(dictionary.sortOrder) : index;
    dictionary.validationStatus ??= "valid";
    dictionary.entries = Array.isArray(dictionary.entries) ? dictionary.entries : [];
    dictionary.frequencyEntries = Array.isArray(dictionary.frequencyEntries) ? dictionary.frequencyEntries : [];
    if (!dictionary.__lookupNormalized) {
      dictionary.entries = dictionary.entries
        .map((entry) => ({
          term: normalizeJapaneseTerm(entry.term ?? ""),
          reading: normalizeJapaneseTerm(entry.reading ?? ""),
          definitions: Array.isArray(entry.definitions) ? entry.definitions : [],
          details: Array.isArray(entry.details) ? entry.details : [],
          tags: Array.isArray(entry.tags) ? entry.tags : []
        }))
        .filter((entry) => entry.term);
      dictionary.frequencyEntries = dictionary.frequencyEntries
        .map((entry) => ({
          term: normalizeJapaneseTerm(entry.term ?? ""),
          reading: normalizeJapaneseTerm(entry.reading ?? ""),
          value: storedFrequencyDisplay(entry),
          displayValue: storedFrequencyDisplay(entry)
        }))
        .filter((entry) => entry.term && entry.displayValue);
      Object.defineProperty(dictionary, "__lookupNormalized", {
        configurable: true,
        enumerable: false,
        value: true,
        writable: true
      });
    }
  });
  if (enforceDictionaryRoles(state)) repaired = true;
  return repaired;
}

export function toPlainGlossary(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(toPlainGlossary).filter(Boolean).join("; ");
  if (value && typeof value === "object") {
    if (value.content) return toPlainGlossary(value.content);
    if (value.text) return toPlainGlossary(value.text);
    if (value.glossary) return toPlainGlossary(value.glossary);
    return Object.values(value).map(toPlainGlossary).filter(Boolean).join("; ");
  }
  return "";
}

export function glossaryDetails(value) {
  const details = toDetailLines(value)
    .map(normalizeDetailLine)
    .filter(Boolean);
  const seen = new Set();
  return details.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toDetailLines(value, depth = 0) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text ? [detailPrefix(depth, text)] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => toDetailLines(item, depth));
  if (typeof value === "object") {
    if (value.text !== undefined) return toDetailLines(value.text, depth);
    if (value.glossary !== undefined) return toDetailLines(value.glossary, depth);
    if (value.content !== undefined) {
      const contentLines = toDetailLines(value.content, depth + detailDepthIncrement(value));
      const marker = detailMarker(value);
      return marker ? contentLines.map((line) => `${marker} ${line}`.trim()) : contentLines;
    }
    return Object.entries(value)
      .filter(([key]) => !["tag", "type", "style", "class", "className", "data", "lang", "href"].includes(key))
      .flatMap(([, child]) => toDetailLines(child, depth));
  }
  return [];
}

function detailDepthIncrement(value = {}) {
  const tag = String(value.tag ?? value.type ?? "").toLowerCase();
  return /^(li|ul|ol|div|p|details|table|tr)$/.test(tag) ? 1 : 0;
}

function detailMarker(value = {}) {
  const tag = String(value.tag ?? "").toLowerCase();
  if (tag === "li") return "•";
  return "";
}

function detailPrefix(depth, text) {
  return `${"  ".repeat(Math.max(0, Math.min(depth, 4)))}${text}`;
}

export function cleanDictionaryDefinitions(definitions = []) {
  const seen = new Set();
  const cleaned = [];
  for (const value of definitions.map(toPlainGlossary)) {
    const definition = String(value).replace(/\s+/g, " ").trim();
    if (!definition) continue;
    const candidates = isNoisyDictionaryDefinition(definition) ? cleanFlattenedDictionaryDefinition(definition) : [definition];
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (!candidate || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(candidate);
    }
  }
  return cleaned;
}

function cleanFlattenedDictionaryDefinition(definition = "") {
  const chunks = definition
    .split(";")
    .map((chunk) => cleanDefinitionChunk(chunk))
    .filter(Boolean)
    .filter((chunk) => !isDefinitionTag(chunk));
  const seen = new Set();
  return chunks.filter((chunk) => {
    const key = chunk.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function cleanDefinitionChunk(value = "") {
  const withoutJapanese = String(value)
    .replace(/[\u3040-\u30ff\u3400-\u9fff々〆ヵヶー]+/gu, " ")
    .replace(/[【】〔〕「」『』（）()［］\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z]/i.test(withoutJapanese)) return "";
  return withoutJapanese.replace(/^[,.;:|/\-\s]+|[,.;:|/\-\s]+$/g, "").trim();
}

function isDefinitionTag(value = "") {
  const normalized = value.toLowerCase();
  return /^(noun|verb|adjective|adverb|suru|transitive|intransitive|no-adj|na-adj|i-adj|forms?|see|jmdict|tatoeba|priority|irregular|form|normal|center|th|\d+(?:\.\d+)?em)$/i.test(normalized);
}

function parseDictionaryUpload(file, { normalizeJapaneseTerm, repairMojibake }) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".zip") return parseYomitanZip(file, { normalizeJapaneseTerm, repairMojibake });
  if (ext === ".json") return parseLegacyJson(file, { normalizeJapaneseTerm });
  throw Object.assign(new Error("Unsupported dictionary format. Upload a Yomitan ZIP or JSON dictionary."), { status: 415 });
}

function parseYomitanZip(file, { normalizeJapaneseTerm, repairMojibake }) {
  const zip = new AdmZip(file.buffer);
  const indexEntry = zip.getEntry("index.json");
  const index = indexEntry ? JSON.parse(indexEntry.getData().toString("utf8")) : {};
  const entries = [];
  const frequencyEntries = [];

  for (const entry of zip.getEntries()) {
    if (/term_bank_\d+\.json$/i.test(entry.entryName)) {
      const rows = JSON.parse(entry.getData().toString("utf8"));
      for (const row of rows) {
        const parsed = parseTermRow(row, normalizeJapaneseTerm);
        if (parsed) entries.push(parsed);
      }
    }
    if (/term_meta_bank_\d+\.json$/i.test(entry.entryName)) {
      const rows = JSON.parse(entry.getData().toString("utf8"));
      for (const row of rows) {
        const parsed = parseFrequencyRow(row, normalizeJapaneseTerm);
        if (parsed) frequencyEntries.push(parsed);
      }
    }
  }

  return {
    title: repairMojibake(String(index.title || index.name || "")),
    language: String(index.targetLanguage || index.language || index.lang || "unknown"),
    format: indexEntry ? "yomitan" : "legacy",
    entries,
    frequencyEntries,
    validation: {
      termRows: entries.length,
      frequencyRows: frequencyEntries.length,
      hasIndex: Boolean(indexEntry)
    }
  };
}

function parseLegacyJson(file, { normalizeJapaneseTerm }) {
  const parsed = JSON.parse(file.buffer.toString("utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.terms ?? parsed.entries ?? [];
  const entries = [];
  for (const row of rows) {
    const entry = Array.isArray(row) ? parseTermRow(row, normalizeJapaneseTerm) : parseObjectTerm(row, normalizeJapaneseTerm);
    if (entry) entries.push(entry);
  }
  return {
    title: String(parsed.title || parsed.name || ""),
    language: String(parsed.language || "unknown"),
    format: "legacy",
    entries,
    frequencyEntries: [],
    validation: { termRows: entries.length, frequencyRows: 0, hasIndex: false }
  };
}

function parseTermRow(row, normalizeJapaneseTerm) {
  if (!Array.isArray(row)) return null;
  const term = normalizeJapaneseTerm(row[0] ?? "");
  if (!term) return null;
  const glossary = Array.isArray(row[5]) ? row[5] : [row[5]].filter((value) => value !== undefined);
  const definitions = glossary.map(toPlainGlossary).filter(Boolean);
  if (definitions.length === 0) return null;
  const details = glossaryDetails(glossary);
  const tags = String(row[2] ?? "").split(/\s+/).filter(Boolean);
  return {
    term,
    reading: normalizeJapaneseTerm(row[1] ?? ""),
    definitions,
    details,
    tags
  };
}

function parseObjectTerm(row, normalizeJapaneseTerm) {
  if (!row || typeof row !== "object") return null;
  const term = normalizeJapaneseTerm(row.term ?? row.expression ?? row.word ?? "");
  if (!term) return null;
  const definitions = Array.isArray(row.definitions)
    ? row.definitions.map(toPlainGlossary).filter(Boolean)
    : [toPlainGlossary(row.definition ?? row.meaning ?? "")].filter(Boolean);
  if (definitions.length === 0) return null;
  const detailsSource = row.details ?? row.fullDefinitions ?? row.fullDefinition ?? row.glossary ?? row.definitions ?? row.definition ?? row.meaning ?? [];
  const details = glossaryDetails(detailsSource);
  return {
    term,
    reading: normalizeJapaneseTerm(row.reading ?? ""),
    definitions,
    details,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : []
  };
}

function parseFrequencyRow(row, normalizeJapaneseTerm) {
  if (!Array.isArray(row)) return null;
  const term = normalizeJapaneseTerm(row[0] ?? "");
  if (!term) return null;
  const raw = row[2] ?? row[1] ?? "";
  const reading = typeof raw === "object" && raw !== null ? raw.reading ?? raw.readingTerm ?? "" : "";
  const displayValue = frequencyDisplay(raw);
  if (!displayValue) return null;
  return { term, reading: normalizeJapaneseTerm(reading), value: displayValue, displayValue };
}

function frequencyDisplay(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return String(value).trim();
  if (Array.isArray(value)) return value.map(frequencyDisplay).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if (value.displayValue !== undefined) return frequencyDisplay(value.displayValue);
    if (value.value !== undefined && typeof value.value !== "object") return frequencyDisplay(value.value);
    if (value.frequency !== undefined) return frequencyDisplay(value.frequency);
    if (value.rank !== undefined) return frequencyDisplay(value.rank);
    if (value.score !== undefined) return frequencyDisplay(value.score);
    const compact = Object.entries(value)
      .filter(([key]) => !["reading", "readingTerm", "term", "dictionary", "dictionaryId"].includes(key))
      .map(([key, child]) => {
        const childValue = frequencyDisplay(child);
        return childValue ? `${key}: ${childValue}` : "";
      })
      .filter(Boolean);
    return compact.join(", ");
  }
  return "";
}

function storedFrequencyDisplay(entry = {}) {
  const display = frequencyDisplay(entry.displayValue);
  if (display && display !== "[object Object]") return display;
  return frequencyDisplay(entry.value);
}

function lookupTermDictionaries(dictionaries, normalized, { prefix, indexCache }) {
  return dictionaries.flatMap((dictionary) =>
    termLookupEntries(dictionary, normalized, { prefix, indexCache })
      .map((entry) => ({
        term: entry.term,
        reading: entry.reading,
        definitions: cleanDictionaryDefinitions(entry.definitions),
        details: dictionaryLookupDetails(entry),
        redirectTargets: redirectTargetsFromEntry(entry),
        tags: entry.tags ?? [],
        dictionary: dictionary.name,
        dictionaryId: dictionary.id,
        language: dictionary.language,
        sortOrder: dictionary.sortOrder
      }))
      .filter((entry) => entry.definitions.length > 0 || entry.details.length > 0)
      .filter((entry, index, list) => index === list.findIndex((candidate) =>
        candidate.term === entry.term &&
        candidate.reading === entry.reading &&
        candidate.definitions.join("\u0000").toLowerCase() === entry.definitions.join("\u0000").toLowerCase()
      ))
  );
}

function lookupSqlTermDictionaries(dictionaryStore, dictionaries, normalized, { prefix, limit }) {
  if (typeof dictionaryStore?.lookupDictionaryEntries !== "function") return null;
  const dictionaryIds = orderedDictionaries(dictionaries).map((dictionary) => dictionary.id).filter(Boolean);
  if (dictionaryIds.length === 0) return [];
  try {
    const rows = dictionaryStore.lookupDictionaryEntries(dictionaryIds, normalized, { prefix, limit });
    if (rows.length === 0 && dictionaries.some((dictionary) => (dictionary.entries?.length ?? 0) > 0)) return null;
    return rows
      .map(normalizeSqlDictionaryEntry)
      .filter((entry) => entry.definitions.length > 0 || entry.details.length > 0)
      .filter((entry, index, list) => index === list.findIndex((candidate) =>
        candidate.term === entry.term &&
        candidate.reading === entry.reading &&
        candidate.dictionaryId === entry.dictionaryId &&
        candidate.definitions.join("\u0000").toLowerCase() === entry.definitions.join("\u0000").toLowerCase()
      ));
  } catch {
    return null;
  }
}

function lookupSqlTermDictionariesBatch(dictionaryStore, dictionary, normalizedTerms, { limitPerTerm }) {
  if (typeof dictionaryStore?.lookupDictionaryEntriesBatch !== "function") return null;
  try {
    const rowsByTerm = dictionaryStore.lookupDictionaryEntriesBatch(dictionary.id, normalizedTerms, { limitPerTerm });
    const result = new Map(normalizedTerms.map((term) => [term, []]));
    for (const [term, rows] of rowsByTerm.entries()) {
      result.set(term, rows
        .map(normalizeSqlDictionaryEntry)
        .filter((entry) => entry.definitions.length > 0 || entry.details.length > 0)
        .filter((entry, index, list) => index === list.findIndex((candidate) =>
          candidate.term === entry.term &&
          candidate.reading === entry.reading &&
          candidate.dictionaryId === entry.dictionaryId &&
          candidate.definitions.join("\u0000").toLowerCase() === entry.definitions.join("\u0000").toLowerCase()
        )));
    }
    if ([...result.values()].every((entries) => entries.length === 0) && (dictionary.entries?.length ?? 0) > 0) return null;
    return result;
  } catch {
    return null;
  }
}

function normalizeSqlDictionaryEntry(entry = {}) {
  return {
    term: entry.term,
    reading: entry.reading,
    definitions: cleanDictionaryDefinitions(entry.definitions),
    details: dictionaryLookupDetails(entry),
    redirectTargets: redirectTargetsFromEntry(entry),
    tags: entry.tags ?? [],
    dictionary: entry.dictionary,
    dictionaryId: entry.dictionaryId,
    language: entry.language,
    sortOrder: entry.sortOrder
  };
}

function dictionaryLookupDetails(entry = {}) {
  if (Array.isArray(entry.details) && entry.details.length > 0) {
    const details = glossaryDetails(entry.details);
    if (details.length > 0) return details;
  }
  return cleanDictionaryDefinitions(entry.definitions);
}

function redirectTargetsFromEntry(entry = {}) {
  const targets = new Set([
    ...redirectTargetsFromDefinitions(entry.definitions, entry.term),
    ...redirectTargetsFromDefinitions(entry.details, entry.term),
    ...redirectTargetsFromSeeDetails(entry.details, entry.term)
  ]);
  return [...targets].filter((target) => isUsableRedirectTarget(target, entry.term));
}

function lookupFrequencyDictionaries(dictionaries, normalized, { indexCache }) {
  return orderedDictionaries(dictionaries)
    .filter((dictionary) => dictionary.type === "frequency" && dictionary.enabledForLookup)
    .flatMap((dictionary) =>
      frequencyLookupEntries(dictionary, normalized, { indexCache })
        .map((entry) => ({
          dictionary: dictionary.name,
          dictionaryId: dictionary.id,
          value: entry.value,
          displayValue: entry.displayValue
        }))
    );
}

function lookupSqlFrequencyDictionaries(dictionaryStore, dictionaries, normalized, { limit }) {
  if (typeof dictionaryStore?.lookupDictionaryFrequencies !== "function") return null;
  const dictionaryIds = orderedDictionaries(dictionaries)
    .filter((dictionary) => dictionary.type === "frequency" && dictionary.enabledForLookup)
    .map((dictionary) => dictionary.id)
    .filter(Boolean);
  if (dictionaryIds.length === 0) return [];
  try {
    const rows = dictionaryStore.lookupDictionaryFrequencies(dictionaryIds, normalized, { limit });
    if (rows.length === 0 && dictionaries.some((dictionary) => (dictionary.frequencyEntries?.length ?? 0) > 0)) return null;
    return rows
      .map((entry) => ({
        dictionary: entry.dictionary,
        dictionaryId: entry.dictionaryId,
        value: entry.value,
        displayValue: entry.displayValue
      }));
  } catch {
    return null;
  }
}

function redirectTargetsFromDefinitions(definitions = [], sourceTerm = "") {
  const targets = new Set();
  for (const definition of definitions.map(toPlainGlossary)) {
    const text = String(definition);
    for (const match of text.matchAll(/([\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]+)\s*;\s*redirected from/giu)) {
      if (match[1] && match[1] !== sourceTerm) targets.add(match[1]);
    }
    for (const match of text.matchAll(/[⟶→]\s*;\s*([\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]+)/gu)) {
      if (match[1] && match[1] !== sourceTerm) targets.add(match[1]);
    }
  }
  return [...targets].filter((target) => isUsableRedirectTarget(target, sourceTerm));
}

function redirectTargetsFromSeeDetails(details = [], sourceTerm = "") {
  const lines = Array.isArray(details) ? details.map(normalizeDetailLine).filter(Boolean) : [];
  const targets = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^see:?$/i.test(lines[index])) continue;
    const chunks = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].replace(/^[•・]\s*/, "").trim();
      if (!line || /^(jmdict|forms?|noun|verb|adjective|adverb)$/i.test(line) || /^[①②③④⑤⑥⑦⑧⑨\d]+[.)、\s]/.test(line)) break;
      if (!/[\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]/u.test(line)) break;
      chunks.push(line);
    }
    for (const candidate of seeTargetCandidates(chunks)) {
      if (candidate && candidate !== sourceTerm) targets.add(candidate);
    }
  }
  return [...targets];
}

function seeTargetCandidates(chunks = []) {
  const cleaned = chunks.map((chunk) => chunk.replace(/\s+/g, "").trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const candidates = new Set([cleaned.join("")]);
  const compact = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    const current = cleaned[index];
    const previous = cleaned[index - 1] ?? "";
    const next = cleaned[index + 1] ?? "";
    if (!/[\u3400-\u9fff]/u.test(current) && /[\u3400-\u9fff]/u.test(next)) continue;
    if (!/[\u3400-\u9fff]/u.test(current) && /[\u3400-\u9fff]/u.test(previous) && current.length <= 2 && next) continue;
    compact.push(current);
  }
  if (compact.length > 0) candidates.add(compact.join(""));
  for (let index = 0; index < cleaned.length; index += 1) {
    const suffix = cleaned.slice(index).join("");
    if (suffix.length > 1) candidates.add(suffix);
  }
  return [...candidates];
}

function isUsableRedirectTarget(target = "", sourceTerm = "") {
  return target && target !== sourceTerm && target.length > 1 && /[\u3400-\u9fff]/u.test(target);
}

function normalizeDetailLine(line = "") {
  return String(line)
    .replace(/\s+/g, " ")
    .replace(/^(?:[•・]\s*)+/, "• ")
    .trim();
}

function termLookupEntries(dictionary, normalized, { prefix, indexCache }) {
  const index = dictionaryIndex(dictionary, indexCache);
  if (prefix) {
    return uniqueEntries([
      ...dictionary.entries.filter((entry) => entry.term === normalized),
      ...dictionary.entries.filter((entry) => entry.reading === normalized),
      ...dictionary.entries.filter((entry) => entry.term !== normalized && entry.term.startsWith(normalized)),
      ...dictionary.entries.filter((entry) => entry.reading !== normalized && entry.reading.startsWith(normalized))
    ]);
  }
  return uniqueEntries([
    ...(index.terms.get(normalized) ?? []),
    ...(index.readings.get(normalized) ?? [])
  ]);
}

function frequencyLookupEntries(dictionary, normalized, { indexCache }) {
  const index = dictionaryIndex(dictionary, indexCache).frequencies;
  return index.get(normalized) ?? [];
}

function exactTermDictionaryEntry(dictionary, normalized, { indexCache }) {
  const index = dictionaryIndex(dictionary, indexCache);
  const entry = (index.terms.get(normalized) ?? []).find((item) => item.reading) ?? (index.terms.get(normalized) ?? [])[0];
  if (!entry) return null;
  return {
    term: entry.term,
    reading: entry.reading,
    redirectTargets: redirectTargetsFromEntry(entry),
    dictionary: dictionary.name,
    dictionaryId: dictionary.id,
    sortOrder: dictionary.sortOrder
  };
}

function dictionaryIndex(dictionary, indexCache) {
  const signature = `${dictionary.id}:${dictionary.entries?.length ?? 0}:${dictionary.frequencyEntries?.length ?? 0}:${dictionary.importedAt ?? ""}`;
  const cached = indexCache.get(dictionary.id);
  if (cached?.signature === signature) return cached;
  const terms = new Map();
  const readings = new Map();
  const frequencies = new Map();
  for (const entry of dictionary.entries ?? []) {
    appendIndexValue(terms, entry.term, entry);
    appendIndexValue(readings, entry.reading, entry);
  }
  for (const entry of dictionary.frequencyEntries ?? []) {
    appendIndexValue(frequencies, entry.term, entry);
    appendIndexValue(frequencies, entry.reading, entry);
  }
  const next = { signature, terms, readings, frequencies };
  indexCache.set(dictionary.id, next);
  return next;
}

function uniqueEntries(entries = []) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = [
      entry.term,
      entry.reading,
      (entry.definitions ?? []).join("\u0000")
    ].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function appendIndexValue(index, key, value) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

function dictionaryMetadata(dictionaries) {
  return orderedDictionaries(dictionaries).map(({ entries, frequencyEntries, ...dictionary }) => ({
    ...dictionary,
    entriesCount: entries?.length ?? 0,
    frequencyCount: frequencyEntries?.length ?? 0
  }));
}

function selectedWordBankDictionary(dictionaries) {
  return orderedDictionaries(dictionaries).find((dictionary) => dictionary.type === "term" && dictionary.selectedForWordBank);
}

function orderedDictionaries(dictionaries) {
  return [...dictionaries].sort((a, b) =>
    dictionaryTypeOrder(a) - dictionaryTypeOrder(b) ||
    Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)
  );
}

function dictionaryTypeOrder(dictionary) {
  return dictionary.type === "frequency" ? 1 : 0;
}

function nextSortOrder(dictionaries, type = "term") {
  const sameType = dictionaries.filter((dictionary) => (dictionary.type === "frequency" ? "frequency" : "term") === type);
  if (sameType.length === 0) return 0;
  return Math.max(...sameType.map((dictionary) => Number(dictionary.sortOrder ?? 0))) + 1;
}

function enforceDictionaryRoles(state, preferredId = "") {
  let repaired = false;
  const termDictionaries = orderedDictionaries(state.dictionaries).filter((dictionary) => dictionary.type === "term");
  const selected = termDictionaries.filter((dictionary) => dictionary.selectedForWordBank);
  const selectedId = preferredId && termDictionaries.some((dictionary) => dictionary.id === preferredId && dictionary.selectedForWordBank)
    ? preferredId
    : selected[0]?.id ?? termDictionaries[0]?.id ?? "";
  for (const dictionary of state.dictionaries) {
    const nextSelected = dictionary.type === "term" && dictionary.id === selectedId;
    if (dictionary.selectedForWordBank !== nextSelected) repaired = true;
    dictionary.selectedForWordBank = nextSelected;
  }
  return repaired;
}

function isNoisyDictionaryDefinition(value = "") {
  const text = String(value).trim();
  if (!text) return true;
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(text);
  const metadataMarkers = /[★⛬â˜…â›¬]|;/.test(text);
  const languagePrefix = /^[a-z]{2,3};\s/u.test(text);
  return hasJapanese && (metadataMarkers || languagePrefix);
}
