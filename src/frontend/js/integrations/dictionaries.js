// Dictionary import, ordering, settings, and deletion.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { loadState } from "../core/session.js";
import { clearLookupRelatedCaches, state } from "../core/state.js";
import { openDocument } from "../reader/document.js";
import { confirmAction, showDictionaryNotice } from "../shared/ui.js";
import { escapeHtml } from "../shared/utils.js";

let draggedDictionaryId = "";

function renderDictionaries() {
  elements.dictionaryList.innerHTML = "";
  elements.dictionaryPrefixToggle.checked = Boolean(state.dictionarySettings?.prefixWildcardSearch);

  if (state.dictionaries.length === 0) {
    elements.dictionaryList.innerHTML = `<p class="empty">No dictionaries imported.</p>`;
    return;
  }

  state.dictionaries = orderedDictionariesForUi(state.dictionaries);
  for (const dictionary of state.dictionaries) {
    const row = document.createElement("div");
    row.className = `dictionary-row dictionary-manager-row ${dictionary.enabledForLookup ? "enabled" : ""}`;
    row.dataset.dictionaryId = dictionary.id;
    row.draggable = true;
    const isTerm = dictionary.type === "term";
    const count = isTerm ? dictionary.entriesCount ?? 0 : dictionary.frequencyCount ?? 0;
    row.innerHTML = `
      <button class="dictionary-drag-handle" type="button" title="Drag to reorder" aria-label="Drag ${escapeHtml(dictionary.name)} to reorder">
        <span></span><span></span><span></span>
      </button>
      <label class="dictionary-check" title="Show this dictionary in reader lookup">
        <input data-dictionary-toggle="${escapeHtml(dictionary.id)}" type="checkbox"${dictionary.enabledForLookup ? " checked" : ""} />
      </label>
      <button class="dictionary-delete" data-dictionary-delete="${escapeHtml(dictionary.id)}" type="button" title="Delete dictionary" aria-label="Delete ${escapeHtml(dictionary.name)}">×</button>
      <div class="dictionary-main">
        <strong>${escapeHtml(dictionary.name)}</strong>
        <span>${escapeHtml(dictionary.filename ?? "")}</span>
      </div>
      <span class="dictionary-badge">${escapeHtml(dictionary.type ?? "term")}</span>
      <span class="dictionary-count">${Number(count).toLocaleString()} ${isTerm ? "terms" : "freq"}</span>
      <span class="dictionary-language">${escapeHtml(dictionary.language ?? "unknown")}</span>
    `;
    row.addEventListener("dragstart", (event) => startDictionaryDrag(event, dictionary.id));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => dropDictionary(event, dictionary.id));
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.querySelector("[data-dictionary-toggle]")?.addEventListener("change", (event) => {
      updateDictionarySettings(dictionary.id, { enabledForLookup: event.target.checked });
    });
    row.querySelector("[data-dictionary-delete]")?.addEventListener("click", () => deleteDictionary(dictionary));
    elements.dictionaryList.append(row);
  }
}

function orderedDictionariesForUi(dictionaries = []) {
  return [...dictionaries].sort((a, b) =>
    Number(a.type === "frequency") - Number(b.type === "frequency") ||
    Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)
  );
}

async function updateDictionarySettings(id, patch, options = {}) {
  if (options.clearCache !== false && (Object.hasOwn(patch, "enabledForLookup"))) clearLookupRelatedCaches();
  const result = await api(`/api/dictionaries/${encodeURIComponent(id)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  state.dictionaries = result.dictionaries ?? state.dictionaries;
  state.dictionarySettings = result.settings ?? state.dictionarySettings;
  if (options.render !== false) renderDictionaries();
  return result;
}

function startDictionaryDrag(event, id) {
  draggedDictionaryId = id;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
}

async function dropDictionary(event, targetId) {
  event.preventDefault();
  const sourceId = draggedDictionaryId || event.dataTransfer.getData("text/plain");
  draggedDictionaryId = "";
  if (!sourceId || sourceId === targetId) return;
  const source = state.dictionaries.find((dictionary) => dictionary.id === sourceId);
  const target = state.dictionaries.find((dictionary) => dictionary.id === targetId);
  if (!source || !target || source.type !== target.type) return;
  const previousDictionaries = state.dictionaries.map((dictionary) => ({ ...dictionary }));

  const group = orderedDictionariesForUi(state.dictionaries).filter((dictionary) => dictionary.type === source.type);
  const sourceIndex = group.findIndex((dictionary) => dictionary.id === sourceId);
  const targetIndex = group.findIndex((dictionary) => dictionary.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = group.splice(sourceIndex, 1);
  group.splice(targetIndex, 0, moved);
  group.forEach((dictionary, index) => {
    const live = state.dictionaries.find((item) => item.id === dictionary.id);
    if (live) live.sortOrder = index;
  });
  renderDictionaries();
  try {
    const results = await Promise.all(group.map((dictionary, index) =>
      updateDictionarySettings(dictionary.id, { sortOrder: index }, { render: false })
    ));
    state.dictionaries = results.at(-1)?.dictionaries ?? state.dictionaries;
    renderDictionaries();
  } catch (error) {
    state.dictionaries = previousDictionaries;
    renderDictionaries();
    showDictionaryNotice(error.message, "error");
  }
}

function setDictionaryImportLoading(loading) {
  if (!elements.dictionaryImportButton) return;
  elements.dictionaryImportButton.disabled = loading;
  elements.dictionaryImportButton.classList.toggle("loading", loading);
  elements.dictionaryImportButton.innerHTML = loading
    ? `<span class="button-spinner" aria-hidden="true"></span><span>Importing dictionaries</span>`
    : "Import dictionary";
  elements.dictionaryForm.querySelectorAll("input, select").forEach((input) => {
    input.disabled = loading;
  });
  elements.dictionaryAttachment?.querySelector("button")?.toggleAttribute("disabled", loading);
}

function formatFileSize(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function renderDictionaryAttachment() {
  if (!elements.dictionaryAttachment || !elements.dictionaryFile) return;
  const files = [...(elements.dictionaryFile.files ?? [])];
  if (files.length === 0) {
    elements.dictionaryAttachment.classList.add("hidden");
    elements.dictionaryAttachment.innerHTML = "";
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const fileLabel = files.length === 1 ? files[0].name : `${files.length} dictionaries selected`;
  const sizeLabel = files.length === 1 ? formatFileSize(files[0].size) : `${formatFileSize(totalSize)} total`;
  const fileList = files.length > 1
    ? `<span>${files.slice(0, 4).map((file) => escapeHtml(file.name)).join(", ")}${files.length > 4 ? `, +${files.length - 4} more` : ""}</span>`
    : `<span>${escapeHtml(sizeLabel)}</span>`;
  elements.dictionaryAttachment.classList.remove("hidden");
  elements.dictionaryAttachment.innerHTML = `
    <div class="file-attachment-main">
      <strong>${escapeHtml(fileLabel)}</strong>
      ${files.length > 1 ? `<span>${escapeHtml(sizeLabel)}</span>${fileList}` : fileList}
    </div>
    <button type="button" aria-label="Remove selected dictionary files">&times;</button>
  `;
  elements.dictionaryAttachment.querySelector("button")?.addEventListener("click", () => {
    elements.dictionaryFile.value = "";
    renderDictionaryAttachment();
  });
}

async function deleteDictionary(dictionary) {
  const confirmed = await confirmAction(`Delete "${dictionary.name}" from dictionaries?`, { title: "Delete dictionary?", confirmText: "Delete" });
  if (!confirmed) return;
  try {
    const result = await api(`/api/dictionaries/${encodeURIComponent(dictionary.id)}`, { method: "DELETE" });
    state.dictionaries = result.dictionaries ?? state.dictionaries.filter((item) => item.id !== dictionary.id);
    state.dictionarySettings = result.settings ?? state.dictionarySettings;
    clearLookupRelatedCaches();
    renderDictionaries();
    showDictionaryNotice("Dictionary deleted", "success");
  } catch (error) {
    showDictionaryNotice(error.message, "error");
  }
}

function bindDictionaryEvents() {
  elements.dictionaryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    
    if (!elements.dictionaryFile?.files?.length) {
      showDictionaryNotice("Choose a dictionary ZIP or JSON before importing.", "error");
      renderDictionaryAttachment();
      return;
    }
    const formData = new FormData(elements.dictionaryForm);
    const selectedCount = elements.dictionaryFile.files?.length ?? 0;
    setDictionaryImportLoading(true);
    try {
      const result = await api("/api/dictionaries", { method: "POST", body: formData });
      elements.dictionaryForm.reset();
      renderDictionaryAttachment();
      await loadState();
      const imported = result.dictionaries ?? (result.dictionary ? [result.dictionary] : []);
      if (imported.length > 1 || selectedCount > 1) {
        showDictionaryNotice(`${imported.length.toLocaleString()} dictionaries imported`, "success");
      } else {
        const dictionary = imported[0];
        const importedCount = dictionary?.type === "frequency" ? dictionary.frequencyCount : dictionary?.entriesCount;
        showDictionaryNotice(`${dictionary?.name ?? "Dictionary"} imported (${Number(importedCount ?? 0).toLocaleString()} rows)`, "success");
      }
      if (state.activeDocumentId) await openDocument(state.activeDocumentId);
    } catch (error) {
      showDictionaryNotice(error.message, "error");
    } finally {
      setDictionaryImportLoading(false);
    }
  });
  elements.dictionaryFile?.addEventListener("change", renderDictionaryAttachment);
  elements.dictionaryPrefixToggle.addEventListener("change", async () => {
    const result = await api("/api/dictionaries/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefixWildcardSearch: elements.dictionaryPrefixToggle.checked })
    });
    state.dictionarySettings = result.settings ?? state.dictionarySettings;
    renderDictionaries();
  });
}

export { bindDictionaryEvents, renderDictionaries };
