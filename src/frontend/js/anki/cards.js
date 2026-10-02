// Anki card preview, editable fields, export, and known-vocabulary updates.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { loadState, refreshStateMetadataOnly } from "../core/session.js";
import { state } from "../core/state.js";
import { refreshActiveDocumentForKnownTerms } from "../reader/document.js";
import { renderDictionaryLookup } from "../reader/lookup.js";
import { escapeHtml } from "../shared/utils.js";
import { finishMotion, reveal } from "../shared/motion.js";

async function openAnkiPreview(candidate, node) {
  const preview = await api("/api/anki/card-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentId: state.activeDocumentId,
      deckName: state.anki?.deckName || "",
      modelName: state.anki?.modelName || "",
      ...candidate
    })
  });
  if (state.anki?.instantExport) {
    await exportPreviewDirectly(preview, candidate, node);
    return;
  }
  state.activeCardPreview = preview;
  state.activeCardCandidate = candidate;
  state.activeCandidateNode = node;
  renderCardPreview(preview);
  elements.cardDialog.classList.remove("hidden");
  reveal(elements.cardDialog.querySelector(".card-dialog"));
}

async function exportPreviewDirectly(preview, candidate, node) {
  const statusNode = node?.querySelector(".definition");
  if (statusNode) statusNode.textContent = "Creating Anki note...";
  try {
    const fieldMapUpdates = {};
    for (const [canonical, ankiField] of Object.entries(preview.fieldMap ?? {})) {
      if (canonical && ankiField) fieldMapUpdates[canonical] = ankiField;
    }
    const exported = await api("/api/anki/export-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: state.activeDocumentId,
        deckName: preview.deckName,
        modelName: preview.modelName,
        ...candidate,
        fields: preview.values ?? {},
        fieldMapUpdates
      })
    });
    if (statusNode) statusNode.textContent = exportResultMessage(exported);
    node?.remove();
    if (!node && elements.dictionaryLookup) {
      elements.dictionaryLookup.insertAdjacentHTML("beforeend", `<p class="empty">Exported ${escapeHtml(exported.expression || candidate.expression || "card")} to Anki.</p>`);
    }
    if (node) {
      await loadState();
      await refreshActiveDocumentForKnownTerms(exportedKnownTerm(exported, candidate));
    } else {
      await refreshStateMetadataOnly();
      await refreshLookupAfterAnkiExport(exported, candidate);
    }
  } catch (error) {
    if (statusNode) statusNode.textContent = exportFailureMessage(error);
    else if (elements.cardStatus) elements.cardStatus.textContent = exportFailureMessage(error);
    throw error;
  }
}

async function refreshLookupAfterAnkiExport(exported, candidate = {}) {
  if (elements.dictionaryLookup.classList.contains("hidden")) return;
  const lookupTerm = candidate.surface || candidate.expression || exported.expression;
  if (!lookupTerm) return;
  const prefix = state.dictionarySettings?.prefixWildcardSearch ? "&prefix=true" : "";
  const result = await api(`/api/dictionary/lookup?term=${encodeURIComponent(lookupTerm)}${prefix}`);
  renderDictionaryLookup(lookupTerm, result, null);
}

function renderCardPreview(preview) {
  elements.cardStatus.textContent = `${preview.deckName || "No deck"} - ${preview.modelName || "No note type"}`;
  const firstEntry = preview.dictionaryEntries?.[0];
  elements.cardDictionary.textContent = firstEntry
    ? `${firstEntry.term} ${firstEntry.reading || ""} - ${firstEntry.definitions?.slice(0, 2).join("; ") || ""}`
    : "No dictionary match. Imported dictionaries are used for meaning and reading suggestions.";
  elements.cardFields.innerHTML = "";
  const canonicalOptions = [
    "",
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
  for (const field of preview.fields) {
    const row = document.createElement("div");
    row.className = "card-field-row";
    const mappedCanonical = Object.entries(preview.fieldMap ?? {}).find(([, ankiField]) => ankiField === field)?.[0] || "";
    row.innerHTML = `
      <strong>${escapeHtml(field)}</strong>
      <label>
        Value
        <textarea data-anki-field="${escapeHtml(field)}">${escapeHtml(preview.values?.[field] ?? "")}</textarea>
      </label>
      <label>
        Maps to
        <select data-map-field="${escapeHtml(field)}">
          ${canonicalOptions.map((option) => `<option value="${escapeHtml(option)}"${option === mappedCanonical ? " selected" : ""}>${option || "Unmapped"}</option>`).join("")}
        </select>
      </label>
    `;
    row.querySelector("select").addEventListener("change", (event) => {
      const canonical = event.target.value;
      const textarea = row.querySelector("textarea");
      if (canonical && preview.canonical?.[canonical] !== undefined) textarea.value = preview.canonical[canonical] ?? "";
    });
    elements.cardFields.append(row);
  }
}

function closeCardPreview() {
  finishMotion(elements.cardDialog);
  elements.cardDialog.classList.add("hidden");
  state.activeCardPreview = null;
  state.activeCardCandidate = null;
  state.activeCandidateNode = null;
}

async function exportReviewedCard(event) {
  event.preventDefault();
  if (!state.activeCardPreview || !state.activeCardCandidate) return;
  const fields = {};
  const fieldMapUpdates = {};
  for (const textarea of elements.cardFields.querySelectorAll("[data-anki-field]")) {
    fields[textarea.dataset.ankiField] = textarea.value;
  }
  for (const select of elements.cardFields.querySelectorAll("[data-map-field]")) {
    if (select.value) fieldMapUpdates[select.value] = select.dataset.mapField;
  }
  elements.cardExport.disabled = true;
  const originalExportLabel = elements.cardExport.textContent;
  elements.cardExport.textContent = "Exporting...";
  elements.cardStatus.textContent = "Creating Anki note...";
  try {
    const exported = await api("/api/anki/export-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: state.activeDocumentId,
        deckName: state.activeCardPreview.deckName,
        modelName: state.activeCardPreview.modelName,
        ...state.activeCardCandidate,
        fields,
        fieldMapUpdates
      })
    });
    elements.cardStatus.textContent = exportResultMessage(exported);
    const exportedFromLookup = !state.activeCandidateNode;
    const exportedCandidate = state.activeCardCandidate;
    state.activeCandidateNode?.remove();
    closeCardPreview();
    if (exportedFromLookup) {
      await refreshStateMetadataOnly();
      await refreshLookupAfterAnkiExport({ expression: exportedCandidate?.expression }, exportedCandidate);
    } else {
      await loadState();
      await refreshActiveDocumentForKnownTerms(exportedKnownTerm(exported, exportedCandidate));
    }
  } catch (error) {
    elements.cardStatus.textContent = exportFailureMessage(error);
  } finally {
    elements.cardExport.disabled = false;
    elements.cardExport.textContent = originalExportLabel;
  }
}

function exportResultMessage(exported = {}) {
  const skipped = exported.media?.skippedAudioFields ?? [];
  const pending = exported.media?.pendingAudioFields ?? [];
  if (pending.length > 0) return `Created Anki note. Audio will be added shortly: ${pending.join(", ")}.`;
  if (skipped.length > 0) return `Created Anki note. Uncached audio skipped: ${skipped.join(", ")}.`;
  return "Created Anki note.";
}

function exportedKnownTerm(exported = {}, candidate = {}) {
  return candidate.dictionaryForm || candidate.expression || candidate.surface || exported.expression || "";
}

function exportFailureMessage(error) {
  const reason = String(error?.message || "Unknown error").trim();
  if (/fetch|failed to fetch|networkerror|load failed/i.test(reason)) {
    return "Export failed (AnkiConnect unreachable. Open Anki Desktop with AnkiConnect enabled, then try again.)";
  }
  return `Export failed (${reason || "Unknown error"})`;
}

function bindCardEvents() {
  elements.cardForm?.addEventListener("submit", exportReviewedCard);
  elements.cardCancel?.addEventListener("click", closeCardPreview);
  elements.cardDialog?.addEventListener("click", (event) => {
    if (event.target === elements.cardDialog) closeCardPreview();
  });
}

export { bindCardEvents, openAnkiPreview };
