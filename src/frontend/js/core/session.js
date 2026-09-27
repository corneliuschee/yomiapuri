// Refresh the application read model and integration status from the backend.
import { api } from "./api.js";
import { elements } from "./dom.js";
import { clearLookupRelatedCaches, state } from "./state.js";
import { loadAiProviders } from "../integrations/ai.js";
import { renderVocabularyStatus, syncAnkiLaunchControls, updateAnkiConnectionUi } from "../integrations/anki.js";
import { renderDictionaries } from "../integrations/dictionaries.js";
import { loadMediaProviders } from "../integrations/media.js";
import { renderSyncStatus } from "../integrations/sync.js";
import { renderBooksGrid, renderDocuments } from "../library/books.js";
import { renderTrash } from "../library/trash.js";

async function loadState() {
  const snapshot = await api("/api/state");
  state.documents = snapshot.documents;
  state.dictionaries = snapshot.dictionaries ?? [];
  state.dictionarySettings = snapshot.dictionarySettings ?? { prefixWildcardSearch: false };
  state.reader = snapshot.reader ?? state.reader;
  if (elements.hideInferredFurigana) elements.hideInferredFurigana.checked = Boolean(state.reader.hideInferredReadableFurigana);
  clearLookupRelatedCaches();
  state.cards = snapshot.cards ?? [];
  state.progress = snapshot.progress ?? {};
  state.trash = snapshot.trash ?? { documents: [], knownTerms: [] };
  state.anki = snapshot.anki;
  state.media = snapshot.media ?? state.media;
  state.ai = snapshot.ai ?? state.ai;

  state.sync = snapshot.sync ?? state.sync;
  state.knownTermsCount = snapshot.knownTermsCount ?? 0;
  elements.knownCount.textContent = `${state.knownTermsCount.toLocaleString()} words`;
  elements.knownCount.classList.add("hidden");
  elements.ankiSettingsForm.connectUrl.value = state.anki?.connectUrl ?? "http://127.0.0.1:8765";
  syncAnkiLaunchControls();
  elements.ankiImportForm.elements.preset.value = state.anki?.vocabularyPreset || "reviewed-once";
  renderVocabularyStatus();
  if (elements.instantAnkiToggle) elements.instantAnkiToggle.checked = Boolean(state.anki?.instantExport);
  renderDocuments();
  renderBooksGrid();
  renderDictionaries();
  renderSyncStatus();
  await loadMediaProviders();
  await loadAiProviders();
  updateAnkiConnectionUi(false);
  renderTrash();
}

async function refreshStateMetadataOnly() {
  const snapshot = await api("/api/state");
  state.cards = snapshot.cards ?? state.cards;
  state.anki = snapshot.anki ?? state.anki;
  state.knownTermsCount = snapshot.knownTermsCount ?? state.knownTermsCount;
  elements.knownCount.textContent = `${state.knownTermsCount.toLocaleString()} words`;
  clearLookupRelatedCaches();
}

export { loadState, refreshStateMetadataOnly };
