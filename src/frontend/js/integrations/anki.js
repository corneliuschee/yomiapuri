// Anki connection, deck/note settings, field mapping, and vocabulary sync.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { clearLookupRelatedCaches, state } from "../core/state.js";
import { showAnkiNotice } from "../shared/ui.js";
import { escapeHtml, formatDateTime, populateSelect } from "../shared/utils.js";

function syncAnkiLaunchControls() {
  if (elements.ankiAutoLaunch) elements.ankiAutoLaunch.checked = state.anki?.autoLaunchAnki !== false;
  if (!elements.ankiExecutablePath) return;
  elements.ankiExecutablePath.value = state.anki?.ankiExecutablePath ?? "";
  const detected = Boolean(state.anki?.ankiExecutablePathDetected && state.anki?.ankiExecutablePath);
  elements.ankiExecutablePath.readOnly = detected;
  elements.ankiExecutablePath.placeholder = detected ? "Detected Anki executable" : "Enter path to anki.exe";
}

async function saveAnkiLaunchSettings() {
  state.anki = await api("/api/anki/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectUrl: elements.ankiSettingsForm.connectUrl.value,
      autoLaunchAnki: elements.ankiAutoLaunch?.checked ?? true,
      ankiExecutablePath: elements.ankiExecutablePath?.value ?? ""
    })
  });
  syncAnkiLaunchControls();
}

function updateAnkiConnectionUi(connected = false) {
  const deckName = state.anki?.deckName || "";
  const modelName = state.anki?.modelName || "";
  elements.settingsGrid?.classList.toggle("anki-connected", connected);
  elements.ankiConnectedArea?.classList.toggle("hidden", !connected);
  elements.ankiFieldStatus?.classList.toggle("hidden", !connected);
  if (elements.selectedDeckLabel) elements.selectedDeckLabel.textContent = `Current Selected Deck: ${deckName || "None"}`;
  if (elements.selectedNoteLabel) elements.selectedNoteLabel.textContent = `Current Selected Note: ${modelName || "None"}`;
  if (elements.ankiImportDeck) elements.ankiImportDeck.textContent = `Importing from: ${deckName || "No deck selected"}`;
  elements.ankiImportForm?.querySelector("button[type='submit']")?.toggleAttribute("disabled", !deckName);
}

function setAnkiImportLoading(loading) {
  if (!elements.ankiImportButton) return;
  elements.ankiImportButton.disabled = loading || !(state.anki?.deckName);
  elements.ankiImportButton.classList.toggle("loading", loading);
  elements.ankiImportButton.innerHTML = loading
    ? `<span class="button-spinner" aria-hidden="true"></span><span>Importing vocabulary</span>`
    : "Sync Anki";
}

async function loadModelFields() {
  if (!elements.modelSelect?.value && !state.anki?.modelName) {
    renderAnkiFieldStatus(null);
    return;
  }
  try {
    const modelName = elements.modelSelect.value || state.anki?.modelName || "";
    const result = await api(`/api/anki/model-fields?modelName=${encodeURIComponent(modelName)}`);
    state.ankiModelFields = result.fields ?? [];
    renderAnkiFieldStatus(result);
  } catch (error) {
    elements.ankiFieldStatus.textContent = error.message;
  }
}

function renderAnkiFieldStatus(result) {
  if (!elements.ankiFieldStatus) return;
  if (!result?.fields?.length) {
    elements.ankiFieldStatus.textContent = "Connect to Anki to inspect note fields.";
    return;
  }
  const mapped = result.fieldMap ?? {};
  const rows = result.fields.map((field) => {
    const canonical = Object.entries(mapped).find(([, ankiField]) => ankiField === field)?.[0] || "Unmapped";
    return `<tr><td>${escapeHtml(field)}</td><td>${escapeHtml(canonical)}</td></tr>`;
  }).join("");
  elements.ankiFieldStatus.innerHTML = `
    <div class="mapping-scroll">
      <table class="mapping-table">
        <thead>
          <tr>
            <th>Anki field <span class="help-dot" tabindex="0" data-tooltip="The field names from your selected Anki note type/template.">?</span></th>
            <th>Detected value <span class="help-dot" tabindex="0" data-tooltip="The app's best guess for which card data should fill that Anki field. You can correct this in the card preview.">?</span></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderVocabularyStatus() {
  const stamp = state.anki?.lastVocabularySyncAt;
  elements.ankiVocabularyStatus.textContent = `${state.knownTermsCount.toLocaleString()} known words · Last synced: ${stamp ? formatDateTime(stamp) : "Never"}`;
}

function bindAnkiEvents() {
  elements.connectAnki.addEventListener("click", async () => {
    await api("/api/anki/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectUrl: elements.ankiSettingsForm.connectUrl.value })
    });
    try {
      const result = await api("/api/anki/connect");
      elements.ankiStatus.textContent = "Connected";
      state.anki = result.settings;
      populateSelect(elements.deckSelect, result.decks, state.anki?.deckName, "None");
      populateSelect(elements.modelSelect, result.models, state.anki?.modelName, "None");
      updateAnkiConnectionUi(true);
      renderAnkiFieldStatus(null);
    } catch (error) {
      elements.ankiStatus.textContent = error.message;
    }
  });
  elements.ankiSettingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  elements.ankiAutoLaunch?.addEventListener("change", async () => {
    try {
      await saveAnkiLaunchSettings();
      elements.ankiStatus.textContent = "Auto-launch setting saved";
    } catch (error) {
      elements.ankiStatus.textContent = error.message;
    }
  });
  elements.ankiExecutablePath?.addEventListener("change", async () => {
    if (elements.ankiExecutablePath.readOnly) return;
    try {
      await saveAnkiLaunchSettings();
      elements.ankiStatus.textContent = "Anki path saved";
    } catch (error) {
      elements.ankiStatus.textContent = error.message;
    }
  });
  elements.saveDeck?.addEventListener("click", async () => {
    const deckName = elements.deckSelect.value;
    state.anki = await api("/api/anki/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectUrl: elements.ankiSettingsForm.connectUrl.value, deckName })
    });
    elements.ankiStatus.textContent = "Deck saved";
    updateAnkiConnectionUi(true);
  });
  elements.saveNote?.addEventListener("click", async () => {
    const modelName = elements.modelSelect.value;
    state.anki = await api("/api/anki/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectUrl: elements.ankiSettingsForm.connectUrl.value, modelName })
    });
    elements.ankiStatus.textContent = "Note saved";
    updateAnkiConnectionUi(true);
    await loadModelFields();
  });
  elements.ankiImportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements.ankiImportButton.disabled) return;
    const deckName = state.anki?.deckName || "";
    if (!deckName) {
      showAnkiNotice("Choose and save an Anki deck first.", "error");
      return;
    }
    setAnkiImportLoading(true);
    try {
      const preset = elements.ankiImportForm.elements.preset.value;
      const result = await api("/api/anki/sync-vocabulary", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset, deckName })
      });
      state.knownTermsCount = result.total;
      state.anki.lastVocabularySyncAt = result.syncedAt;
      state.anki.vocabularyPreset = preset;
      clearLookupRelatedCaches();
      renderVocabularyStatus();
      showAnkiNotice(`${Number(result.added).toLocaleString()} new words imported from ${deckName}.`, "success");
    } catch (error) {
      showAnkiNotice(error.message, "error");
    } finally {
      setAnkiImportLoading(false);
    }
  });
  elements.instantAnkiToggle?.addEventListener("change", async () => {
    state.anki = await api("/api/anki/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectUrl: elements.ankiSettingsForm.connectUrl.value,
        instantExport: elements.instantAnkiToggle.checked
      })
    });
    elements.instantAnkiToggle.checked = Boolean(state.anki?.instantExport);
  });
}

export {
  bindAnkiEvents,
  loadModelFields,
  renderVocabularyStatus,
  syncAnkiLaunchControls,
  updateAnkiConnectionUi,
};
