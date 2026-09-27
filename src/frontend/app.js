// Frontend startup. Feature modules register their listeners only when called here.
import { bindCardEvents } from "./js/anki/cards.js";
import { elements } from "./js/core/dom.js";
import { bindNavigationEvents } from "./js/core/navigation.js";
import { loadState } from "./js/core/session.js";
import { bindAiEvents } from "./js/integrations/ai.js";
import { bindAnkiEvents } from "./js/integrations/anki.js";
import { bindDictionaryEvents } from "./js/integrations/dictionaries.js";
import { bindMediaEvents } from "./js/integrations/media.js";
import { bindSyncEvents } from "./js/integrations/sync.js";
import { bindLibraryEvents } from "./js/library/books.js";
import { bindTrashEvents } from "./js/library/trash.js";
import { bindAssistantEvents } from "./js/reader/assistant.js";
import { bindDocumentEvents } from "./js/reader/document.js";
import { bindHighlightEvents } from "./js/reader/highlights.js";
import { bindLookupEvents } from "./js/reader/lookup.js";
import { bindReaderNavigationEvents } from "./js/reader/navigation.js";
import { initPdfRenderer } from "./js/reader/pdf.js";
import { bindReaderSearchEvents } from "./js/reader/search.js";
import { bindReaderSidebarEvents, initReaderSidebarResize } from "./js/reader/sidebar.js";
import { loadVoices } from "./js/shared/speech.js";
import { bindTooltipEvents } from "./js/shared/ui.js";
import { escapeHtml } from "./js/shared/utils.js";

initPdfRenderer();
bindNavigationEvents();
bindAssistantEvents();
bindReaderSidebarEvents();
bindLibraryEvents();
bindReaderNavigationEvents();
bindReaderSearchEvents();
bindHighlightEvents();
bindDocumentEvents();
bindLookupEvents();
bindTrashEvents();
bindAnkiEvents();
bindMediaEvents();
bindAiEvents();
bindSyncEvents();
bindCardEvents();
bindTooltipEvents();
bindDictionaryEvents();

loadVoices();
initReaderSidebarResize();
window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
loadState().catch((error) => {
  elements.reader.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
