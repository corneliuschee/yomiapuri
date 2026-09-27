const state = {
  documents: [],
  dictionaries: [],
  dictionarySettings: { prefixWildcardSearch: false },
  reader: { hideInferredReadableFurigana: false },
  media: { image: { enabled: false, provider: "local-mnemonic" } },
  mediaProviders: { status: null },
  ai: { translation: { enabled: true, modelId: "sugoi-14b-ultra-q4-k-m" }, models: [] },
  aiProviders: { status: null, models: [] },
  sync: { enabled: false, configured: false, signedIn: false, status: "disabled" },
  cards: [],
  progress: {},
  trash: { documents: [], knownTerms: [] },
  anki: null,
  ankiModelFields: [],
  activeCardPreview: null,
  activeCardCandidate: null,
  activeCandidateNode: null,
  knownTermsCount: 0,
  activeDocumentId: null,
  activeDocumentTitle: "",
  activeHtml: "",
  activePages: [""],
  activeChapters: [],
  activeChapterId: "",
  highlightColor: "#f6c453",
  highlightMode: "select",
  highlights: { pages: {}, scrollHtml: "" },
  bookmarks: [],
  highlightUndo: [],
  highlightRedo: [],
  readerMode: "scroll",
  readerSideTab: "chapters",
  readerSearchQuery: "",
  readerSearchResults: [],
  readerZoom: 100,
  libraryZoom: 140,
  libraryQuery: "",
  dictionaryLookupCache: new Map(),
  trashTab: "books",
  selectedTrashDocuments: new Set(),
  currentPage: 0,
  voices: [],
};

const $ = (selector) => document.querySelector(selector);
const pdfDocuments = new Map();
let hoverLookupTimer;
let hoverLookupLastTerm = "";
let hoverLookupRequest = 0;
let readerAssistantTimer = null;
let readerAssistantMessageId = 0;
let readerAssistantHistory = [];
let readerOpenRequestId = 0;
let readerIngestionAbortController = null;
const readerPageWindowRequests = new Map();
let shiftLookupAnchorRange = null;
let shiftHoverAnchorRange = null;
let lookupPreviewElement = null;
let draggedDictionaryId = "";
let mediaSettingsSaveTimer = null;

const elements = {
  shell: $("#shell"),
  sidebar: $("#sidebar"),
  navItems: document.querySelectorAll(".nav-item"),
  pageLinks: document.querySelectorAll("[data-page-link]"),
  pages: document.querySelectorAll(".page"),
  settingsGrid: $("#settings-grid"),
  pageEyebrow: $("#page-eyebrow"),
  pageTitle: $("#page-title"),
  knownCount: $("#known-count"),
  bookForm: $("#book-form"),
  readerSidebarToggle: $("#reader-sidebar-toggle"),
  readerLibrary: $("#reader-library"),
  readerSidePanel: $("#reader-side-panel"),
  readerSideBook: $("#reader-side-book"),
  readerSideTabs: document.querySelectorAll("[data-reader-side-tab]"),
  readerSideChapters: $("#reader-side-chapters"),
  readerSideBookmarks: $("#reader-side-bookmarks"),
  readerSideSearch: $("#reader-side-search"),
  libraryBookForm: $("#library-book-form"),
  libraryNotice: $("#library-notice"),
  librarySearch: $("#library-search"),
  quickBookFile: $("#quick-book-file"),
  booksGrid: $("#books-grid"),
  documentList: $("#document-list"),
  readerLayout: $("#reader-layout"),
  chapterPanel: $("#chapter-panel"),
  chapterList: $("#chapter-list"),
  bookmarkList: $("#bookmark-list"),
  assistantPanel: $("#assistant-panel"),
  readerAssistantForm: $("#reader-assistant-form"),
  readerAssistantModel: $("#reader-assistant-model"),
  readerAssistantContext: $("#reader-assistant-context"),
  readerAssistantQuestion: $("#reader-assistant-question"),
  readerAssistantAnswer: $("#reader-assistant-answer"),
  readerAssistantSubmit: $("#reader-assistant-submit"),
  panelTabs: document.querySelectorAll("[data-panel-tab]"),
  hideChapters: $("#hide-chapters"),
  showChapters: $("#show-chapters"),
  reader: $("#reader"),
  progressLabel: $("#progress-label"),
  progressBar: $("#progress-bar"),
  pageLabel: $("#page-label"),
  modeScroll: $("#mode-scroll"),
  modePaged: $("#mode-paged"),
  readerZoom: $("#reader-zoom"),
  zoomLabel: $("#zoom-label"),
  toggleZoom: $("#toggle-zoom"),
  readerAiToggle: $("#reader-ai-toggle"),
  hideInferredFurigana: $("#hide-inferred-furigana"),
  pageJumpForm: $("#page-jump-form"),
  pageJumpInput: $("#page-jump-input"),
  prevPage: $("#prev-page"),
  nextPage: $("#next-page"),
  selectTool: $("#select-tool"),
  highlightTool: $("#highlight-tool"),
  highlightColor: $("#highlight-color"),
  eraserTool: $("#eraser-tool"),
  undoHighlight: $("#undo-highlight"),
  redoHighlight: $("#redo-highlight"),
  refreshReader: $("#refresh-reader"),
  chapterResizeHandle: $("#chapter-resize-handle"),
  bookmarkPage: $("#bookmark-page"),
  bookmarkFeedback: $("#bookmark-feedback"),
  trashDeleteSelected: $("#trash-delete-selected"),
  trashDeleteAll: $("#trash-delete-all"),
  trashBooks: $("#trash-books"),
  ankiSettingsForm: $("#anki-settings-form"),
  ankiAutoLaunch: $("#anki-auto-launch"),
  ankiExecutablePath: $("#anki-executable-path"),
  ankiImportForm: $("#anki-import-form"),
  ankiImportButton: $("#anki-import-button"),
  connectAnki: $("#connect-anki"),
  ankiStatus: $("#anki-status"),
  ankiConnectedArea: $("#anki-connected-area"),
  saveDeck: $("#save-deck"),
  saveNote: $("#save-note"),
  selectedDeckLabel: $("#selected-deck-label"),
  selectedNoteLabel: $("#selected-note-label"),
  ankiImportDeck: $("#anki-import-deck"),
  ankiImportNotice: $("#anki-import-notice"),
  ankiVocabularyStatus: $("#anki-vocabulary-status"),
  deckSelect: $("#deck-select"),
  modelSelect: $("#model-select"),
  ankiFieldStatus: $("#anki-field-status"),
  mediaSettingsForm: $("#media-settings-form"),
  mediaStatus: $("#media-status"),
  mediaImageEnabled: $("#media-image-enabled"),
  mediaPreview: $("#media-preview"),
  saveMediaSettings: $("#save-media-settings"),
  testMediaImage: $("#test-media-image"),
  aiModelForm: $("#ai-model-form"),
  aiStatus: $("#ai-status"),
  aiPreview: $("#ai-preview"),
  aiModelUrl: $("#ai-model-url"),
  aiModelList: $("#ai-model-list"),
  importAiModel: $("#import-ai-model"),
  stopAiRuntime: $("#stop-ai-runtime"),
  dictionaryForm: $("#dictionary-form"),
  dictionaryFile: $("#dictionary-file"),
  dictionaryAttachment: $("#dictionary-attachment"),
  dictionaryImportButton: $("#dictionary-import-button"),
  dictionaryNotice: $("#dictionary-notice"),
  dictionaryList: $("#dictionary-list"),
  dictionaryPrefixToggle: $("#dictionary-prefix-toggle"),
  instantAnkiToggle: $("#instant-anki-toggle"),
  dictionaryLookup: $("#dictionary-lookup"),
  syncSettingsForm: $("#sync-settings-form"),
  syncStatus: $("#sync-status"),
  syncUrl: $("#sync-url"),
  syncAnonKey: $("#sync-anon-key"),
  syncDeviceName: $("#sync-device-name"),
  syncEnabled: $("#sync-enabled"),
  syncEmail: $("#sync-email"),
  syncPassword: $("#sync-password"),
  syncSaveSettings: $("#sync-save-settings"),
  syncSignIn: $("#sync-sign-in"),
  syncSignOut: $("#sync-sign-out"),
  syncPush: $("#sync-push"),
  syncPull: $("#sync-pull"),
  syncNow: $("#sync-now"),
  syncSummary: $("#sync-summary"),
  cardDialog: $("#card-dialog"),
  cardForm: $("#card-preview-form"),
  cardStatus: $("#card-status"),
  cardDictionary: $("#card-dictionary"),
  cardFields: $("#card-fields"),
  cardCancel: $("#card-cancel"),
  cardExport: $("#card-export"),
  confirmDialog: $("#confirm-dialog"),
  confirmTitle: $("#confirm-title"),
  confirmMessage: $("#confirm-message"),
  confirmCancel: $("#confirm-cancel"),
  confirmDelete: $("#confirm-delete")
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

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

function setPage(pageId) {
  elements.pages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  const activeNavPage = pageId === "reader-page" ? "books-page" : pageId;
  elements.navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === activeNavPage));
  elements.shell.classList.toggle("reader-sidebar-mode", pageId === "reader-page");
  setSidebarHidden(pageId === "reader-page", { readerMode: pageId === "reader-page" });
  updateReaderToolbar();
  renderReaderSidePanel();
  syncReaderModeButtons();
  elements.knownCount.classList.add("hidden");
  const labels = {
    "books-page": ["Books", "Library"],
    "reader-page": ["Reader", state.activeDocumentTitle || "Choose a book"],
    "trash-page": ["Trash", "Deleted items"],
    "integrations-page": ["Integrations", "Anki and dictionaries"]
  };
  elements.pageEyebrow.textContent = labels[pageId]?.[0] ?? "";
  elements.pageTitle.textContent = labels[pageId]?.[1] ?? "";
  if (pageId === "trash-page") renderTrash();
}

function setSidebarHidden(hidden, options = {}) {
  elements.shell.classList.toggle("sidebar-hidden", hidden);
  elements.sidebar.classList.toggle("collapsed", hidden);
  if (elements.readerSidebarToggle) {
    elements.readerSidebarToggle.classList.toggle("sidebar-toggle-left-open", hidden);
    elements.readerSidebarToggle.classList.toggle("sidebar-toggle-left-close", !hidden);
    elements.readerSidebarToggle.setAttribute("aria-pressed", String(!hidden));
    elements.readerSidebarToggle.title = hidden ? "Show sidebar" : "Hide sidebar";
    elements.readerSidebarToggle.setAttribute("aria-label", hidden ? "Show sidebar" : "Hide sidebar");
  }
}

function renderDocuments() {
  if (!elements.documentList) return;
  elements.documentList.innerHTML = "";
  if (state.documents.length === 0) {
    elements.documentList.innerHTML = `<p class="empty">No books yet.</p>`;
    return;
  }

  for (const item of state.documents) {
    const row = document.createElement("div");
    row.className = `book-item${item.id === state.activeDocumentId ? " active" : ""}`;
    row.innerHTML = `
      <button class="book-open" type="button">
        ${coverMarkup(item, "book-thumb")}
        <span class="book-meta">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${Math.round(state.progress[item.id]?.percentage ?? 0)}% - ${escapeHtml(item.type.toUpperCase())}</span>
        </span>
      </button>
      <div class="book-actions">
        <button class="rename" type="button">Edit</button>
        <button class="delete" type="button">Delete</button>
      </div>
    `;
    row.querySelector(".book-open").addEventListener("click", () => openDocument(item.id));
    row.querySelector(".rename").addEventListener("click", () => renameDocument(item));
    row.querySelector(".delete").addEventListener("click", () => deleteDocument(item));
    elements.documentList.append(row);
  }
}

function renderBooksGrid() {
  if (!elements.booksGrid) return;
  applyLibraryZoom();
  elements.booksGrid.innerHTML = "";
  const visibleDocuments = visibleLibraryDocuments();
  if (state.documents.length === 0) {
    elements.booksGrid.innerHTML = `<p class="empty">No books imported yet.</p>`;
    return;
  }
  if (visibleDocuments.length === 0) {
    elements.booksGrid.innerHTML = `<p class="empty">No books match your search.</p>`;
    return;
  }

  for (const item of visibleDocuments) {
    const card = document.createElement("article");
    const dragHint = item.id === libraryDragOverId ? (libraryDragInsertAfter ? " drop-after" : " drop-before") : "";
    card.className = `library-book${item.id === state.activeDocumentId ? " active" : ""}${item.id === draggedBookId ? " dragging" : ""}${dragHint}`;
    card.draggable = true;
    card.dataset.documentId = item.id;
    card.innerHTML = `
      <div class="library-open" role="button" tabindex="0">
        ${coverMarkup(item, "library-cover")}
        <strong>${escapeHtml(item.title)}</strong>
        <span>${Math.round(state.progress[item.id]?.percentage ?? 0)}% read - ${escapeHtml(item.type.toUpperCase())}</span>
      </div>
      <div class="library-actions">
        <button class="rename" type="button">Edit</button>
        <button class="delete" type="button">Delete</button>
      </div>
    `;
    const openTarget = card.querySelector(".library-open");
    openTarget.addEventListener("click", () => openDocument(item.id));
    openTarget.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDocument(item.id);
    });
    card.querySelector(".rename").addEventListener("click", () => startLibraryRename(card, item));
    card.querySelector(".delete").addEventListener("click", () => deleteDocument(item));
    card.addEventListener("dragstart", (event) => startBookDrag(event, item.id));
    card.addEventListener("dragover", updateBookDragTarget);
    card.addEventListener("drop", dropBook);
    card.addEventListener("dragend", finishBookDrag);
    elements.booksGrid.append(card);
  }
  renderPdfCovers(elements.booksGrid);
}

function applyLibraryZoom() {
  if (!elements.booksGrid) return;
  elements.booksGrid.style.setProperty("--library-book-size", `${state.libraryZoom}px`);
}

function setLibraryZoom(value) {
  state.libraryZoom = Math.max(96, Math.min(240, Number(value) || 140));
  applyLibraryZoom();
  renderPdfCovers(elements.booksGrid);
}

function syncReaderModeButtons() {
  elements.modeScroll.classList.toggle("active", state.readerMode === "scroll");
  elements.modePaged.classList.toggle("active", state.readerMode === "paged");
}

let draggedBookId = "";
let libraryDragOverId = "";
let libraryDragInsertAfter = false;
let libraryNoticeTimer;
let ankiNoticeTimer;
let dictionaryNoticeTimer;

function showLibraryNotice(message, type = "success") {
  libraryNoticeTimer = showNotice(elements.libraryNotice, libraryNoticeTimer, message, type);
}

function showAnkiNotice(message, type = "success") {
  ankiNoticeTimer = showNotice(elements.ankiImportNotice, ankiNoticeTimer, message, type);
}

function showDictionaryNotice(message, type = "success") {
  dictionaryNoticeTimer = showNotice(elements.dictionaryNotice, dictionaryNoticeTimer, message, type);
}


function clearLookupRelatedCaches() {
  state.dictionaryLookupCache.clear();
}

function showNotice(target, timer, message, type = "success") {
  if (!target) return timer;
  clearTimeout(timer);
  const icon = type === "success" ? checkIcon() : "!";
  target.className = `${target.classList.contains("integration-notice") ? "library-notice integration-notice" : "library-notice"} ${type} visible`;
  target.innerHTML = `<span class="notice-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  return setTimeout(() => {
    target.classList.remove("visible");
    target.classList.add("fading");
    setTimeout(() => {
      target.className = target.classList.contains("integration-notice") ? "library-notice integration-notice" : "library-notice";
      target.innerHTML = "";
    }, 260);
  }, 5000);
}

function checkIcon() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5 6.4 11.5 2.5 7.7"/></svg>`;
}

function confirmAction(message, options = {}) {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = options.title ?? "Confirm action";
    elements.confirmMessage.textContent = message;
    elements.confirmDelete.textContent = options.confirmText ?? "Delete";
    elements.confirmDelete.classList.toggle("danger", options.variant !== "restore");
    elements.confirmDialog.classList.remove("hidden");
    elements.confirmDelete.focus();

    const cleanup = (value) => {
      elements.confirmDialog.classList.add("hidden");
      elements.confirmCancel.removeEventListener("click", onCancel);
      elements.confirmDelete.removeEventListener("click", onDelete);
      elements.confirmDialog.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKeydown);
      resolve(value);
    };
    const onCancel = () => cleanup(false);
    const onDelete = () => cleanup(true);
    const onBackdrop = (event) => {
      if (event.target === elements.confirmDialog) cleanup(false);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") cleanup(false);
    };

    elements.confirmCancel.addEventListener("click", onCancel);
    elements.confirmDelete.addEventListener("click", onDelete);
    elements.confirmDialog.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKeydown);
  });
}

function confirmDeleteBook(item) {
  return confirmAction(`Delete "${item.title}" from the library?`, { title: "Delete book?", confirmText: "Delete" });
}

function startBookDrag(event, id) {
  draggedBookId = id;
  libraryDragOverId = "";
  libraryDragInsertAfter = false;
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
}

function finishBookDrag() {
  draggedBookId = "";
  clearLibraryDropHints();
}

function clearLibraryDropHints() {
  libraryDragOverId = "";
  libraryDragInsertAfter = false;
  elements.booksGrid?.querySelectorAll(".library-book").forEach((card) => {
    card.classList.remove("dragging", "drop-before", "drop-after");
  });
}

function visibleLibraryDocuments() {
  const query = state.libraryQuery.trim().toLowerCase();
  return state.documents.filter((item) => !query || [item.title, item.filename, item.type].some((value) => String(value ?? "").toLowerCase().includes(query)));
}

function libraryDropSlot(event) {
  if (!elements.booksGrid) return null;
  const cards = [...elements.booksGrid.querySelectorAll(".library-book")]
    .filter((card) => card.dataset.documentId && card.dataset.documentId !== draggedBookId);
  if (cards.length === 0) return { index: 0, targetId: "", after: false };

  let best = { distance: Number.POSITIVE_INFINITY, index: cards.length, targetId: cards.at(-1)?.dataset.documentId ?? "", after: true };
  const slots = [
    { index: 0, targetId: cards[0].dataset.documentId, after: false, rect: cards[0].getBoundingClientRect(), side: "left" },
    ...cards.map((card, index) => ({
      index: index + 1,
      targetId: card.dataset.documentId,
      after: true,
      rect: card.getBoundingClientRect(),
      side: "right"
    }))
  ];

  for (const slot of slots) {
    const x = slot.side === "left" ? slot.rect.left : slot.rect.right;
    const y = slot.rect.top + slot.rect.height / 2;
    const distance = Math.hypot(event.clientX - x, event.clientY - y);
    if (distance < best.distance) best = { distance, index: slot.index, targetId: slot.targetId, after: slot.after };
  }
  return best;
}

function updateBookDragTarget(event) {
  if (!draggedBookId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const slot = libraryDropSlot(event);
  if (!slot) return;
  libraryDragOverId = slot.targetId;
  libraryDragInsertAfter = slot.after;
  elements.booksGrid?.querySelectorAll(".library-book").forEach((card) => {
    const isTarget = card.dataset.documentId === slot.targetId;
    card.classList.toggle("drop-before", isTarget && !slot.after);
    card.classList.toggle("drop-after", isTarget && slot.after);
  });
}

async function dropBook(event) {
  event.preventDefault();
  event.stopPropagation();
  const slot = libraryDropSlot(event);
  const sourceId = draggedBookId || event.dataTransfer.getData("text/plain");
  if (!sourceId || !slot?.targetId || sourceId === slot.targetId) {
    finishBookDrag();
    return;
  }
  const sourceIndex = state.documents.findIndex((item) => item.id === sourceId);
  const targetIndex = state.documents.findIndex((item) => item.id === slot.targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    finishBookDrag();
    return;
  }
  const [moved] = state.documents.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = state.documents.findIndex((item) => item.id === slot.targetId);
  const insertIndex = targetIndexAfterRemoval + (slot.after ? 1 : 0);
  state.documents.splice(insertIndex, 0, moved);
  finishBookDrag();
  renderBooksGrid();
  try {
    const result = await api("/api/documents/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: state.documents.map((item) => item.id) })
    });
    state.documents = result.documents;
    renderBooksGrid();
  } catch (error) {
    await loadState();
    showLibraryNotice(error.message, "error");
  }
}

function startLibraryRename(card, item) {
  card.classList.add("editing");
  card.innerHTML = `
    ${coverMarkup(item, "library-cover")}
    <form class="library-rename-form">
      <input name="title" type="text" value="${escapeHtml(item.title)}" />
      <div class="library-actions">
        <button type="submit">Save</button>
        <button class="cancel" type="button">Cancel</button>
      </div>
    </form>
  `;
  const form = card.querySelector(".library-rename-form");
  form.title.focus();
  form.title.select();
  form.querySelector(".cancel").addEventListener("click", renderBooksGrid);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await renameDocumentTitle(item, form.title.value);
  });
}

async function renameDocumentTitle(item, value) {
  const title = value.trim();
  if (!title || title === item.title) {
    renderBooksGrid();
    renderDocuments();
    return;
  }
  await api(`/api/documents/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });
  await loadState();
  if (state.activeDocumentId === item.id) {
    state.activeDocumentTitle = title;
    elements.pageTitle.textContent = title;
  }
}

async function renameDocument(item) {
  if (!elements.documentList) return renameDocumentPromptFallback(item);
  const row = [...elements.documentList.querySelectorAll(".book-item")].find((candidate) => candidate.querySelector(".book-open strong")?.textContent === item.title);
  if (!row) return;
  row.classList.add("editing");
  row.innerHTML = `
    <form class="rename-form">
      <input name="title" type="text" value="${escapeHtml(item.title)}" />
      <button type="submit">Save</button>
      <button class="cancel" type="button">Cancel</button>
    </form>
  `;
  const form = row.querySelector(".rename-form");
  form.title.focus();
  form.title.select();
  row.querySelector(".cancel").addEventListener("click", renderDocuments);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = form.title.value.trim();
    if (!title || title === item.title) {
      renderDocuments();
      return;
    }
    await renameDocumentTitle(item, title);
  });
}

async function renameDocumentPromptFallback(item) {
  const title = window.prompt("Rename book", item.title);
  if (!title || title.trim() === item.title) return;
  await renameDocumentTitle(item, title);
}

async function deleteDocument(item) {
  if (!(await confirmDeleteBook(item))) return;
  await api(`/api/documents/${item.id}`, { method: "DELETE" });
  if (state.activeDocumentId === item.id) {
    state.activeDocumentId = null;
    state.activeDocumentTitle = "";
    state.activeHtml = "";
    state.activePages = [""];
    state.activeChapters = [];
    state.activeChapterId = "";
    state.highlights = { pages: {}, scrollHtml: "" };
    state.bookmarks = [];
    elements.reader.innerHTML = `<p class="empty">Import or select a book.</p>`;
    renderChapters();
    renderBookmarks();
    renderBooksGrid();
    updateReaderToolbar();
    elements.pageTitle.textContent = "Choose a book";
  }
  await loadState();
  showLibraryNotice("Deletion successful", "success");
}

async function openDocument(id) {
  const openRequestId = ++readerOpenRequestId;
  readerIngestionAbortController?.abort();
  readerIngestionAbortController = new AbortController();
  const previousDocumentId = state.activeDocumentId;
  state.activeDocumentId = id;
  if (previousDocumentId !== id) readerAssistantHistory = [];
  setPage("reader-page");
  setAssistantPanelHidden(true);
  renderDocuments();
  renderReaderLoadStatus("Checking local book cache...", 0, 1);

  try {
    await streamDocumentIngestion(id, { signal: readerIngestionAbortController.signal });
  } catch (error) {
    if (openRequestId !== readerOpenRequestId || error.name === "AbortError") return;
    console.warn("Document ingestion stream failed; falling back to normal load.", error);
    renderReaderLoadStatus("Loading book without cache progress...", 0, 1);
  }
  if (openRequestId !== readerOpenRequestId) return;
  renderReaderLoadStatus("Rendering book...", 1, 1);
  const documentData = await api(`/api/documents/${id}?initial=1`);
  if (openRequestId !== readerOpenRequestId) return;
  
  state.activeChapters = documentData.chapters ?? [];

  state.activePages = documentData.pages?.length ? documentData.pages : [{ chapterId: "chapter-1", html: documentData.html ?? "" }];
  state.activeHtml = documentData.html ?? "";
  state.readerSearchQuery = "";
  state.readerSearchResults = [];
  state.activeChapterId = documentData.progress?.chapterId || state.activePages[0]?.chapterId || state.activeChapters[0]?.id || "";
  state.readerZoom = normalizeZoom(documentData.progress?.zoom ?? state.readerZoom);
  state.highlights = normalizeHighlights(documentData.progress?.highlights);
  pruneEmptyHighlightPages();
  state.bookmarks = Array.isArray(documentData.progress?.bookmarks) ? documentData.progress.bookmarks : [];
  state.highlightUndo = [];
  state.highlightRedo = [];
  state.activeDocumentTitle = documentData.title;
  const documentItem = state.documents.find((item) => item.id === id);
  if (documentItem) {
    documentItem.title = documentData.title || documentItem.title;
    documentItem.author = documentData.author || documentItem.author || "";
    documentItem.coverPath = documentData.coverPath || documentItem.coverPath || "";
  }
  elements.pageTitle.textContent = documentData.title;
  
  renderBooksGrid();
  renderChapters();
  renderBookmarks();
  updateReaderToolbar();
  renderReader(documentData.progress);
}

function renderReaderLoadStatus(label = "Loading book...", current = 0, total = 1) {
  const progress = total > 0 ? Math.max(0, Math.min(100, Math.round((Number(current) / Number(total)) * 100))) : 0;
  const existing = elements.reader.querySelector(".reader-load-status");
  if (existing) {
    const labelNode = existing.querySelector("strong");
    const track = existing.querySelector(".reader-load-track");
    const fill = existing.querySelector(".reader-load-fill");
    if (labelNode) labelNode.textContent = label;
    if (track) track.setAttribute("aria-valuenow", String(progress));
    if (fill) {
      fill.style.width = `${progress}%`;
      fill.style.transform = `scaleX(${progress / 100})`;
    }
    return;
  }
  elements.reader.innerHTML = `
    <div class="reader-load-status" aria-live="polite">
      <strong>${escapeHtml(label)}</strong>
      <div class="reader-load-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <span class="reader-load-fill" style="width: ${progress}%; transform: scaleX(${progress / 100})"></span>
      </div>
    </div>
  `;
}

async function streamDocumentIngestion(id, options = {}) {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}/ingest-stream`, { signal: options.signal });
  if (!response.ok) return;
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const eventName = handleDocumentIngestionBlock(block);
      if (eventName === "done") {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }
  if (buffer.trim()) handleDocumentIngestionBlock(buffer);
}

async function loadDocumentPagesAround(page = state.currentPage, limit = 8) {
  if (!state.activeDocumentId) return;
  const total = Math.max(1, state.activePages.length);
  const safeLimit = Math.max(1, Math.min(24, Number(limit) || 8));
  const safePage = Math.max(0, Math.min(Number(page) || 0, total - 1));
  const start = Math.max(0, Math.min(safePage - Math.floor(safeLimit / 2), Math.max(0, total - safeLimit)));
  const key = `${state.activeDocumentId}:${start}:${safeLimit}`;
  if (readerPageWindowRequests.has(key)) return readerPageWindowRequests.get(key);
  const request = api(`/api/documents/${encodeURIComponent(state.activeDocumentId)}/pages?start=${start}&limit=${safeLimit}`)
    .then((result) => {
      for (const pageData of result.pages ?? []) {
        const index = Number(pageData.index);
        if (!Number.isInteger(index) || index < 0) continue;
        state.activePages[index] = {
          chapterId: pageData.chapterId,
          html: pageData.html ?? "",
          unloaded: false
        };
      }
      return result;
    })
    .finally(() => readerPageWindowRequests.delete(key));
  readerPageWindowRequests.set(key, request);
  return request;
}

function handleDocumentIngestionBlock(block = "") {
  let eventName = "message";
  const data = [];
  for (const rawLine of String(block).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  const payload = JSON.parse(data.join("\n"));
  if (eventName === "progress") {
    renderReaderLoadStatus(payload.label || "Preparing book...", payload.current ?? 0, payload.total ?? 1);
  }
  if (eventName === "done") {
    const label = payload.rebuilt ? "Local book cache ready." : "Local book cache ready.";
    renderReaderLoadStatus(label, 1, 1);
  }
  if (eventName === "error") throw new Error(payload.error || "Book ingestion failed.");
  return eventName;
}

async function refreshActiveDocumentForKnownTerms(term = "") {
  if (!state.activeDocumentId) return;
  hideDictionaryLookup();
  hoverLookupLastTerm = "";
  if (term) {
    patchKnownTermInActivePages(term);
    applyKnownTermToRenderedReader(term);
    renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: elements.reader.scrollTop, zoom: state.readerZoom });
    applyKnownTermToRenderedReader(term);
    return;
  }
  const page = state.currentPage;
  const mode = state.readerMode;
  const scrollTop = elements.reader.scrollTop;
  const zoom = state.readerZoom;
  await openDocument(state.activeDocumentId);
  state.readerMode = mode;
  state.currentPage = Math.max(0, Math.min(page, state.activePages.length - 1));
  delete state.highlights.pages[String(state.currentPage)];
  renderReader({ mode, page: state.currentPage, scrollTop, zoom });
}

function applyKnownTermToRenderedReader(term = "") {
  const normalized = normalizeTermForUi(term);
  if (!normalized || !elements.reader) return;
  for (const ruby of [...elements.reader.querySelectorAll("ruby[data-base]")]) {
    const base = normalizeTermForUi(ruby.dataset.base || "");
    const surface = normalizeTermForUi(rubySurfaceText(ruby));
    if (base !== normalized && surface !== normalized) continue;
    const span = document.createElement("span");
    span.className = "lookup-token";
    for (const attribute of ruby.attributes) span.setAttribute(attribute.name, attribute.value);
    span.textContent = rubySurfaceText(ruby);
    ruby.replaceWith(span);
  }
}

function patchKnownTermInActivePages(term = "") {
  const normalized = normalizeTermForUi(term);
  if (!normalized) return;
  state.activeHtml = hideKnownTermInHtml(state.activeHtml, normalized);
  state.activePages = (state.activePages ?? []).map((page) => ({
    ...page,
    html: hideKnownTermInHtml(page?.html ?? "", normalized)
  }));
}

function hideKnownTermInHtml(html = "", normalizedTerm = "") {
  if (!html || !normalizedTerm) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<main>${html}</main>`, "text/html");
  for (const ruby of [...doc.querySelectorAll("ruby[data-base]")]) {
    const base = normalizeTermForUi(ruby.dataset.base || "");
    const surface = normalizeTermForUi(rubySurfaceText(ruby));
    if (base !== normalizedTerm && surface !== normalizedTerm) continue;
    const span = doc.createElement("span");
    span.className = "lookup-token";
    for (const attribute of ruby.attributes) span.setAttribute(attribute.name, attribute.value);
    span.textContent = rubySurfaceText(ruby);
    ruby.replaceWith(span);
  }
  return doc.body.firstElementChild?.innerHTML ?? html;
}

function normalizeTermForUi(value = "") {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

function renderReader(progress = {}) {
  state.readerMode = progress.mode === "paged" ? "paged" : state.readerMode;
  state.readerZoom = normalizeZoom(progress.zoom ?? state.readerZoom);
  applyReaderZoom();
  syncReaderModeButtons();
  elements.prevPage.disabled = !state.activeDocumentId;
  elements.nextPage.disabled = !state.activeDocumentId;

  elements.reader.style.whiteSpace = "pre-line";
  elements.reader.style.wordBreak = "break-word";
  elements.reader.style.lineHeight = "2.25";
  elements.reader.style.letterSpacing = "0";

  if (!document.getElementById("reader-media-styles")) {
    const styleNode = document.createElement("style");
    styleNode.id = "reader-media-styles";
    styleNode.innerHTML = `
      #reader img {
        display: block;
        margin: 0 auto;
        border-radius: 2px;
        height: auto;
        max-height: var(--reader-zoom-height, none);
        object-fit: contain;
        max-width: var(--reader-zoom-width, none);
        width: min(100%, var(--reader-zoom-width, 100%));
      }
      #reader .reader-page-frame.image-only .book-image img {
        height: var(--reader-zoom-height, 100%);
        max-height: none;
        max-width: none;
        width: var(--reader-zoom-width, 100%);
      }
      ruby { padding: 0 2px; margin: 0 1px; }
      rt { font-size: 0.65rem; color: #f59e0b; font-weight: normal; user-select: none; }
    `;
    document.head.appendChild(styleNode);
  }

  const requestedPage = Number.isFinite(Number(progress.page)) ? Number(progress.page) : state.currentPage;
  state.currentPage = Math.max(0, Math.min(requestedPage, state.activePages.length - 1));
  const page = state.activePages[state.currentPage];
  state.activeChapterId = page?.chapterId || state.activeChapterId;
  if (page?.unloaded) {
    elements.reader.innerHTML = `
      <div class="reader-load-status" aria-live="polite">
        <strong>Loading page...</strong>
        <div class="reader-load-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="35">
          <span class="reader-load-fill" style="width: 35%; transform: scaleX(0.35)"></span>
        </div>
      </div>
    `;
    updatePagedFooter();
    loadDocumentPagesAround(state.currentPage)
      .then(() => renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: 0, zoom: state.readerZoom }))
      .catch((error) => {
        elements.reader.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
      });
    return;
  }
  elements.reader.innerHTML = savedPageHtml(state.currentPage) || page?.html || `<p class="empty">No page text.</p>`;
  elements.reader.classList.toggle("image-page", Boolean(elements.reader.querySelector(".reader-page-frame.image-only")));
  applyReaderSearchHighlights();
  updateReaderFitVars(state.readerZoom);
  renderChapters();
  requestAnimationFrame(() => {
    updateReaderFitVars(state.readerZoom);
    applyReaderSearchHighlights();
    if (state.readerMode === "scroll") {
      elements.reader.scrollTop = Math.max(0, Math.min(Number(progress.scrollTop) || 0, elements.reader.scrollHeight - elements.reader.clientHeight));
    } else {
      elements.reader.scrollTop = 0;
    }
    updatePagedFooter();
    renderPdfPages(elements.reader);
  });
}

if (window.PDFJS) {
  window.PDFJS.workerSrc = "/vendor/pdfjs/pdf.worker.js";
}

async function getPdfDocument(src) {
  if (!window.PDFJS || !src) return null;
  if (!pdfDocuments.has(src)) {
    const task = window.PDFJS.getDocument(src);
    pdfDocuments.set(src, task.promise ?? task);
  }
  return pdfDocuments.get(src);
}

async function renderPdfPages(container) {
  const pages = [...container.querySelectorAll(".pdf-page-render:not([data-rendered='true'])")];
  for (const node of pages) {
    if (node.dataset.rendering === "true") continue;
    node.dataset.rendering = "true";
    try {
      const src = node.dataset.pdfSrc;
      const pageNumber = Number(node.dataset.pdfPage) || 1;
      const pdf = await getPdfDocument(src);
      if (!pdf) throw new Error("PDF renderer unavailable.");

      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport(1);
      const width = Math.max(320, Math.min(1100, elements.reader.clientWidth - 48));
      const displayScale = Math.max(1, width / baseViewport.width);
      const renderScale = displayScale * Math.min(window.devicePixelRatio || 1, 2);
      const displayViewport = page.getViewport(displayScale);
      const renderViewport = page.getViewport(renderScale);
      const canvas = node.querySelector(".pdf-canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.aspectRatio = `${displayViewport.width} / ${displayViewport.height}`;
      node.querySelector(".pdf-canvas-wrap").style.aspectRatio = `${displayViewport.width} / ${displayViewport.height}`;
      await page.render({ canvasContext: context, viewport: renderViewport }).promise;
      await renderPdfLinks(pdf, page, displayViewport, node);
      await renderPdfTextLayer(page, displayViewport, node);
      node.dataset.rendered = "true";
    } catch (error) {
      node.classList.add("pdf-render-error");
      node.insertAdjacentHTML("beforeend", `<p class="empty">Could not render this PDF page.</p>`);
      console.error(error);
    } finally {
      node.dataset.rendering = "false";
    }
  }
}

async function renderPdfTextLayer(page, viewport, node) {
  const layer = node.querySelector(".pdf-text-layer");
  if (!layer || layer.dataset.textRendered === "true") return;
  const textContent = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false
  });
  const baseViewport = page.getViewport(1);
  layer.innerHTML = "";
  for (const item of textContent.items ?? []) {
    if (!item.str?.trim()) continue;
    const transform = window.PDFJS.Util.transform(viewport.transform, item.transform);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${(transform[4] / viewport.width) * 100}%`;
    span.style.top = `${(transform[5] / viewport.height) * 100}%`;
    span.style.fontSize = `${Math.max(1, Math.hypot(transform[2], transform[3]))}px`;
    span.style.transform = "translateY(-100%)";
    span.style.width = `${Math.max(8, (((item.width || item.str.length * 5) / baseViewport.width) * 100))}%`;
    layer.append(span);
  }
  layer.dataset.textRendered = "true";
}

async function renderPdfCovers(container) {
  const covers = [...container.querySelectorAll(".pdf-cover-render:not([data-rendered='true'])")];
  for (const cover of covers) {
    try {
      const pdf = await getPdfDocument(cover.dataset.pdfSrc);
      if (!pdf) return;
      const page = await pdf.getPage(1);
      const canvas = cover.querySelector("canvas");
      const baseViewport = page.getViewport(1);
      const scale = Math.max(0.6, cover.clientWidth / baseViewport.width) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport(scale);
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      cover.dataset.rendered = "true";
    } catch (error) {
      cover.classList.add("pdf-cover-error");
      console.error(error);
    }
  }
}

async function renderPdfLinks(pdf, page, viewport, node) {
  const layer = node.querySelector(".pdf-link-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const annotations = await page.getAnnotations();
  for (const annotation of annotations.filter((item) => item.subtype === "Link" && item.rect)) {
    const rect = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const width = Math.abs(rect[0] - rect[2]);
    const height = Math.abs(rect[1] - rect[3]);
    const link = document.createElement("a");
    link.className = "pdf-link";
    link.href = annotation.url || "#";
    link.title = annotation.url || "Jump";
    link.style.left = `${(left / viewport.width) * 100}%`;
    link.style.top = `${(top / viewport.height) * 100}%`;
    link.style.width = `${(width / viewport.width) * 100}%`;
    link.style.height = `${(height / viewport.height) * 100}%`;
    if (annotation.url) {
      link.target = "_blank";
      link.rel = "noreferrer";
    } else if (annotation.dest) {
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        const pageIndex = await resolvePdfDestinationPage(pdf, annotation.dest);
        if (Number.isInteger(pageIndex)) jumpToPage(pageIndex + 1);
      });
    }
    layer.append(link);
  }
}

async function resolvePdfDestinationPage(pdf, destination) {
  const explicitDestination = Array.isArray(destination) ? destination : await pdf.getDestination(destination);
  const pageRef = explicitDestination?.[0];
  if (!pageRef) return null;
  return pdf.getPageIndex(pageRef);
}

function renderChapters() {
  elements.chapterList.innerHTML = "";
  if (state.activeChapters.length === 0) {
    elements.chapterList.innerHTML = `<p class="empty">Open a book to show chapters.</p>`;
    renderReaderSidePanel();
    return;
  }

  for (const chapter of state.activeChapters) {
    const link = document.createElement("a");
    link.className = `chapter-item${chapter.id === state.activeChapterId ? " active" : ""}`;
    link.href = `#${encodeURIComponent(chapter.id)}`;
    link.textContent = chapter.title;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      jumpToChapter(chapter.id);
    });
    elements.chapterList.append(link);
  }
  renderReaderSidePanel();
}

function renderBookmarks() {
  elements.bookmarkList.innerHTML = "";
  if (!state.activeDocumentId) {
    elements.bookmarkList.innerHTML = `<p class="empty">Open a book to show bookmarks.</p>`;
    renderReaderSidePanel();
    return;
  }
  if (state.bookmarks.length === 0) {
    elements.bookmarkList.innerHTML = `<p class="empty">No bookmarks yet.</p>`;
    renderReaderSidePanel();
    return;
  }

  const sorted = [...state.bookmarks].sort((a, b) => Number(a.page ?? 0) - Number(b.page ?? 0));
  for (const bookmark of sorted) {
    const page = Number(bookmark.page ?? 0);
    const item = document.createElement("div");
    item.className = `bookmark-item${page === state.currentPage ? " active" : ""}`;
    item.innerHTML = `
      <button class="bookmark-open" type="button">
        <strong>Page ${page + 1}</strong>
        <span>${escapeHtml(bookmark.mode === "scroll" ? "Scroll position" : "Paged mode")}</span>
      </button>
      <button class="bookmark-delete" type="button" title="Delete bookmark" aria-label="Delete bookmark">x</button>
    `;
    item.querySelector(".bookmark-open").addEventListener("click", () => jumpToBookmark(bookmark));
    item.querySelector(".bookmark-delete").addEventListener("click", () => deleteBookmark(bookmark));
    elements.bookmarkList.append(item);
  }
  renderReaderSidePanel();
}

function renderReaderSidePanel() {
  if (!elements.readerSidePanel) return;
  const active = $("#reader-page")?.classList.contains("active") && Boolean(state.activeDocumentId);
  elements.readerSidePanel.classList.toggle("has-book", active);
  elements.readerSideTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.readerSideTab === state.readerSideTab));
  elements.readerSideChapters?.classList.toggle("active", state.readerSideTab === "chapters");
  elements.readerSideBookmarks?.classList.toggle("active", state.readerSideTab === "bookmarks");
  elements.readerSideSearch?.classList.toggle("active", state.readerSideTab === "search");

  const documentItem = state.documents.find((item) => item.id === state.activeDocumentId);
  if (!active || !documentItem) {
    if (elements.readerSideBook) elements.readerSideBook.innerHTML = `<p class="empty">Open a book.</p>`;
    if (elements.readerSideChapters) elements.readerSideChapters.innerHTML = `<p class="empty">No chapters.</p>`;
    if (elements.readerSideBookmarks) elements.readerSideBookmarks.innerHTML = `<p class="empty">No bookmarks.</p>`;
    if (elements.readerSideSearch) elements.readerSideSearch.innerHTML = `<p class="empty">Open a book to search.</p>`;
    return;
  }

  const progress = Math.round(state.progress[documentItem.id]?.percentage ?? Number(elements.progressBar.value) ?? 0);
  elements.readerSideBook.innerHTML = `
    ${coverMarkup(documentItem, "reader-side-cover")}
    <div class="reader-side-meta">
      <strong>${escapeHtml(documentItem.title)}</strong>
      <span class="reader-side-author">${escapeHtml(documentItem.author || "Author unknown")}</span>
      <span>${escapeHtml(documentItem.type.toUpperCase())} - ${progress}% read</span>
    </div>
  `;

  elements.readerSideChapters.innerHTML = "";
  if (state.activeChapters.length === 0) {
    elements.readerSideChapters.innerHTML = `<p class="empty">No chapters.</p>`;
  } else {
    const count = document.createElement("div");
    count.className = "reader-side-count";
    count.textContent = `Total chapters: ${state.activeChapters.length}`;
    elements.readerSideChapters.append(count);
    for (const chapter of state.activeChapters) {
      const link = document.createElement("a");
      link.className = `reader-side-item${chapter.id === state.activeChapterId ? " active" : ""}`;
      link.href = `#${encodeURIComponent(chapter.id)}`;
      link.textContent = chapter.title;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        jumpToChapter(chapter.id);
      });
      elements.readerSideChapters.append(link);
    }
  }

  elements.readerSideBookmarks.innerHTML = "";
  if (state.bookmarks.length === 0) {
    elements.readerSideBookmarks.innerHTML = `<p class="empty">No bookmarks yet.</p>`;
  } else {
    const sorted = [...state.bookmarks].sort((a, b) => Number(a.page ?? 0) - Number(b.page ?? 0));
    for (const bookmark of sorted) {
      const page = Number(bookmark.page ?? 0);
      const item = document.createElement("div");
      item.className = `reader-side-bookmark${page === state.currentPage ? " active" : ""}`;
      item.innerHTML = `
        <button class="reader-side-bookmark-open" type="button">
          <strong>Page ${page + 1}</strong>
          <span>${escapeHtml(bookmark.mode === "scroll" ? "Scroll position" : "Paged mode")}</span>
        </button>
        <button class="reader-side-bookmark-delete" type="button" title="Delete bookmark" aria-label="Delete bookmark">x</button>
      `;
      item.querySelector(".reader-side-bookmark-open").addEventListener("click", () => jumpToBookmark(bookmark));
      item.querySelector(".reader-side-bookmark-delete").addEventListener("click", () => deleteBookmark(bookmark));
      elements.readerSideBookmarks.append(item);
    }
  }

  renderReaderSearchPanel();
  renderPdfCovers(elements.readerSidePanel);
}

function pageTextFromHtml(html = "") {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("rt, script, style, .reader-search-skip").forEach((node) => node.remove());
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function chapterTitleForPage(page) {
  const chapter = state.activeChapters.find((item) => item.id === page?.chapterId);
  return chapter?.title || "Current chapter";
}

function buildReaderSearchResults(query) {
  const needle = query.trim();
  if (!needle) return [];
  const lowerNeedle = needle.toLowerCase();
  const results = [];
  for (const [pageIndex, page] of state.activePages.entries()) {
    const text = pageTextFromHtml(page?.html ?? "");
    const lowerText = text.toLowerCase();
    let offset = 0;
    while (true) {
      const index = lowerText.indexOf(lowerNeedle, offset);
      if (index < 0) break;
      const start = Math.max(0, index - 24);
      const end = Math.min(text.length, index + needle.length + 42);
      results.push({
        id: `${pageIndex}-${index}`,
        page: pageIndex,
        chapterId: page?.chapterId ?? "",
        chapterTitle: chapterTitleForPage(page),
        before: text.slice(start, index),
        match: text.slice(index, index + needle.length),
        after: text.slice(index + needle.length, end)
      });
      offset = index + Math.max(needle.length, 1);
      if (results.length >= 200) return results;
    }
  }
  return results;
}

function renderReaderSearchPanel() {
  if (!elements.readerSideSearch) return;
  const query = state.readerSearchQuery;
  const results = state.readerSearchResults;
  elements.readerSideSearch.innerHTML = `
    <form id="reader-search-form" class="reader-search-form" autocomplete="off">
      <label class="reader-search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
        <input id="reader-search-input" type="search" value="${escapeHtml(query)}" placeholder="Search in book" />
      </label>
      <div class="reader-search-count">${query ? `${results.length} match${results.length === 1 ? "" : "es"}` : "Type to search this book"}</div>
    </form>
    <div class="reader-search-results"></div>
  `;
  const input = elements.readerSideSearch.querySelector("#reader-search-input");
  const list = elements.readerSideSearch.querySelector(".reader-search-results");
  input.addEventListener("input", () => updateReaderSearch(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = state.readerSearchResults[0];
      if (first) jumpToSearchResult(first);
    }
  });
  if (!query) return;
  if (results.length === 0) {
    list.innerHTML = `<p class="empty">No matches found.</p>`;
    return;
  }
  for (const result of results) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `reader-search-result${result.page === state.currentPage ? " active" : ""}`;
    item.innerHTML = `
      <span class="reader-search-snippet">${escapeHtml(result.before)}<mark>${escapeHtml(result.match)}</mark>${escapeHtml(result.after)}</span>
      <span class="reader-search-meta">
        <strong>Page ${result.page + 1}</strong>
        <span class="reader-search-chapter">${escapeHtml(result.chapterTitle)}</span>
      </span>
    `;
    item.addEventListener("click", () => jumpToSearchResult(result));
    list.append(item);
  }
}

function updateReaderSearch(query) {
  state.readerSearchQuery = query;
  state.readerSearchResults = buildReaderSearchResults(query);
  renderReaderSearchPanel();
  requestAnimationFrame(() => {
    const input = elements.readerSideSearch?.querySelector("#reader-search-input");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  applyReaderSearchHighlights();
}

function openReaderSearch() {
  if (!$("#reader-page")?.classList.contains("active")) return;
  state.readerSideTab = "search";
  setSidebarHidden(false, { readerMode: true });
  renderReaderSidePanel();
  requestAnimationFrame(() => elements.readerSideSearch?.querySelector("#reader-search-input")?.focus());
}

function jumpToSearchResult(result) {
  if (!result) return;
  captureCurrentReaderHtml();
  state.currentPage = Math.max(0, Math.min(Number(result.page) || 0, state.activePages.length - 1));
  state.activeChapterId = result.chapterId || state.activePages[state.currentPage]?.chapterId || state.activeChapterId;
  renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: 0, zoom: state.readerZoom });
  saveProgress({ refreshLibrary: false });
}

function applyReaderSearchHighlights() {
  window.CSS?.highlights?.delete("reader-search-match");
  clearReaderSearchInlineHighlights();
  const query = state.readerSearchQuery.trim();
  if (!query || !elements.reader) return;
  const lowerQuery = query.toLowerCase();
  const nodes = [];
  const walker = document.createTreeWalker(elements.reader, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("rt, script, style, button, input, textarea, select, .reader-search-inline-match")) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const segments = [];
  let fullText = "";
  for (const node of nodes) {
    const text = node.nodeValue || "";
    segments.push({ node, start: fullText.length, end: fullText.length + text.length });
    fullText += text;
  }

  const lowerText = fullText.toLowerCase();
  const matches = [];
  let offset = 0;
  while (true) {
    const index = lowerText.indexOf(lowerQuery, offset);
    if (index < 0) break;
    matches.push({ start: index, end: index + query.length });
    offset = index + Math.max(query.length, 1);
  }
  if (matches.length === 0) return;

  for (const segment of [...segments].reverse()) {
    const localMatches = matches
      .map((match) => ({
        start: Math.max(0, match.start - segment.start),
        end: Math.min(segment.end - segment.start, match.end - segment.start)
      }))
      .filter((match) => match.start < match.end)
      .sort((a, b) => a.start - b.start);
    if (localMatches.length === 0) continue;
    const text = segment.node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of localMatches) {
      if (match.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.start)));
      const mark = document.createElement("span");
      mark.className = "reader-search-inline-match";
      mark.textContent = text.slice(match.start, match.end);
      fragment.append(mark);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    segment.node.parentNode?.replaceChild(fragment, segment.node);
  }
}

function clearReaderSearchInlineHighlights(root = elements.reader) {
  if (!root) return;
  root.querySelectorAll?.(".reader-search-inline-match").forEach((node) => {
    const parent = node.parentNode;
    parent?.replaceChild(document.createTextNode(node.textContent || ""), node);
    parent?.normalize();
  });
}

function stripReaderSearchMarkup(root) {
  clearReaderSearchInlineHighlights(root);
  root.querySelectorAll?.(".reader-search-inline-match").forEach((node) => node.replaceWith(document.createTextNode(node.textContent || "")));
  return root;
}

function sameBookmark(a, b) {
  return Number(a.page ?? 0) === Number(b.page ?? 0) &&
    String(a.mode ?? "") === String(b.mode ?? "") &&
    String(a.chapterId ?? "") === String(b.chapterId ?? "") &&
    String(a.createdAt ?? "") === String(b.createdAt ?? "");
}

function deleteBookmark(bookmark) {
  state.bookmarks = state.bookmarks.filter((item) => !sameBookmark(item, bookmark));
  renderBookmarks();
  saveProgress();
}

function jumpToChapter(chapterId) {
  const index = state.activePages.findIndex((page) => page.chapterId === chapterId);
  if (index < 0) return;
  captureCurrentReaderHtml();
  state.activeChapterId = chapterId;
  state.currentPage = index;
  renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: 0, zoom: state.readerZoom });
  renderChapters();
  renderBookmarks();
  saveProgress();
}

function jumpToBookmark(bookmark) {
  if (!state.activeDocumentId) return;
  captureCurrentReaderHtml();
  state.readerMode = bookmark.mode === "paged" ? "paged" : "scroll";
  state.currentPage = Math.max(0, Math.min(Number(bookmark.page) || 0, state.activePages.length - 1));
  state.activeChapterId = bookmark.chapterId || state.activePages[state.currentPage]?.chapterId || state.activeChapterId;
  renderReader({
    mode: state.readerMode,
    page: state.currentPage,
    scrollTop: 0,
    chapterId: state.activeChapterId,
    zoom: state.readerZoom
  });
  saveProgress();
}

function setPanelTab(tabName) {
  elements.panelTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.panelTab === tabName));
  elements.chapterList.classList.toggle("active", tabName === "chapters");
  elements.bookmarkList.classList.toggle("active", tabName === "bookmarks");
  elements.assistantPanel?.classList.toggle("active", tabName === "assistant");
}

function setAssistantPanelHidden(hidden) {
  if (!elements.readerLayout) return;
  if (!hidden) setPanelTab("assistant");
  elements.readerLayout.classList.toggle("chapters-hidden", hidden);
  elements.showChapters?.classList.add("hidden");
  elements.readerAiToggle?.classList.toggle("active", !hidden);
}

function initReaderSidebarResize() {
  const savedWidth = Number(localStorage.getItem("readerSideWidth"));
  if (Number.isFinite(savedWidth)) setReaderSidebarWidth(savedWidth);
}

function setReaderSidebarWidth(width) {
  if (!elements.readerLayout) return;
  const maxWidth = Math.max(260, Math.min(560, Math.floor(window.innerWidth * 0.45)));
  const nextWidth = Math.max(220, Math.min(maxWidth, Math.round(Number(width) || 280)));
  elements.readerLayout.style.setProperty("--reader-side-width", `${nextWidth}px`);
  localStorage.setItem("readerSideWidth", String(nextWidth));
}

function startReaderSidebarResize(event) {
  if (!elements.readerLayout || elements.readerLayout.classList.contains("chapters-hidden")) return;
  event.preventDefault();
  const pointerId = event.pointerId;
  elements.chapterResizeHandle?.setPointerCapture?.(pointerId);
  document.body.classList.add("resizing-reader-sidebar");

  const onPointerMove = (moveEvent) => {
    const rect = elements.readerLayout.getBoundingClientRect();
    setReaderSidebarWidth(rect.right - moveEvent.clientX);
  };
  const stopResize = () => {
    document.body.classList.remove("resizing-reader-sidebar");
    elements.chapterResizeHandle?.releasePointerCapture?.(pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopResize);
  window.addEventListener("pointercancel", stopResize);
}

function nudgeReaderSidebarWidth(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const current = Number(getComputedStyle(elements.readerLayout).getPropertyValue("--reader-side-width").replace("px", "")) || 280;
  setReaderSidebarWidth(current + (event.key === "ArrowLeft" ? 24 : -24));
}

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

async function refreshStateMetadataOnly() {
  const snapshot = await api("/api/state");
  state.cards = snapshot.cards ?? state.cards;
  state.anki = snapshot.anki ?? state.anki;
  state.knownTermsCount = snapshot.knownTermsCount ?? state.knownTermsCount;
  elements.knownCount.textContent = `${state.knownTermsCount.toLocaleString()} words`;
  clearLookupRelatedCaches();
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

function selectedReaderText() {
  const selection = window.getSelection();
  if (!selectionInsideReader(selection) || selection.isCollapsed) return "";
  const clone = selection.getRangeAt(0).cloneContents();
  clone.querySelectorAll?.("rt, rp").forEach((node) => node.remove());
  return (clone.textContent || selection.toString() || "").replace(/\s+/g, " ").trim();
}

function currentReaderPageText() {
  if (!elements.reader) return "";
  const frame = elements.reader.querySelector(".reader-page-frame") || elements.reader;
  const clone = frame.cloneNode(true);
  clone.querySelectorAll?.("rt, rp, .reader-page-title, .reader-chapter-heading, canvas, img, button").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function askReaderAssistant(event) {
  event.preventDefault();
  if (!state.activeDocumentId) {
    elements.readerAssistantAnswer.innerHTML = `<p class="empty">Open a book before using the assistant.</p>`;
    return;
  }
  const question = elements.readerAssistantQuestion?.value?.trim() || "";
  if (!question) {
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Type a message";
    elements.readerAssistantQuestion?.focus();
    return;
  }
  if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Message only";
  elements.readerAssistantSubmit.disabled = true;
  clearReaderAssistantEmpty();
  appendReaderAssistantMessage("user", question, "You");
  const pendingId = appendReaderAssistantMessage("assistant", "Thinking...", "Assistant", "0.0s");
  const startedAt = performance.now();
  startReaderAssistantTimer(pendingId, startedAt);
  elements.readerAssistantQuestion.value = "";
  try {
    const payload = {
      documentId: state.activeDocumentId,
      page: state.currentPage,
      question,
      modelId: elements.readerAssistantModel?.value || state.ai?.translation?.modelId || "",
      history: readerAssistantHistory.slice(-6)
    };
    let streamedAnswer = "";
    let result = null;
    await streamReaderAssistant(payload, {
      onDelta: (delta) => {
        streamedAnswer += delta;
        updateReaderAssistantMessageText(pendingId, streamedAnswer || "Thinking...");
      },
      onDone: (doneResult) => {
        result = doneResult;
      }
    });
    if (!result) result = { answer: streamedAnswer };
    if (!result.answer) result.answer = streamedAnswer;
    renderReaderAssistantAnswer(result, pendingId, elapsedLabel(startedAt));
    rememberReaderAssistantTurn(question, result.answer ?? "");
  } catch (error) {
    replaceReaderAssistantMessage(pendingId, "assistant", error.message, "Assistant", elapsedLabel(startedAt));
  } finally {
    stopReaderAssistantTimer();
    elements.readerAssistantSubmit.disabled = false;
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Message only";
    elements.readerAssistantQuestion?.focus();
  }
}

async function streamReaderAssistant(payload, handlers = {}) {
  const response = await fetch("/api/reader/assistant/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  if (!response.body) throw new Error("Assistant stream was not available.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) handleAssistantStreamBlock(block, handlers);
  }
  if (buffer.trim()) handleAssistantStreamBlock(buffer, handlers);
}

function handleAssistantStreamBlock(block = "", handlers = {}) {
  let eventName = "message";
  const data = [];
  for (const rawLine of String(block).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  const payload = JSON.parse(data.join("\n"));
  if (eventName === "delta") handlers.onDelta?.(payload.delta ?? "");
  else if (eventName === "done") handlers.onDone?.(payload);
  else if (eventName === "error") throw new Error(payload.error || "Assistant stream failed.");
  else if (eventName === "meta") handlers.onMeta?.(payload);
}

function clearReaderAssistantEmpty() {
  if (elements.readerAssistantAnswer?.querySelector(".empty")) {
    elements.readerAssistantAnswer.innerHTML = "";
  }
}

function appendReaderAssistantMessage(role, text, label, elapsed = "") {
  const id = `assistant-message-${readerAssistantMessageId += 1}`;
  elements.readerAssistantAnswer.insertAdjacentHTML("beforeend", readerAssistantMessageHtml({ id, role, text, label, elapsed }));
  scrollAssistantToBottom();
  return id;
}

function replaceReaderAssistantMessage(id, role, text, label, elapsed = "", extraHtml = "") {
  const node = document.getElementById(id);
  const html = readerAssistantMessageHtml({ id, role, text, label, elapsed, extraHtml });
  if (node) node.outerHTML = html;
  else elements.readerAssistantAnswer.insertAdjacentHTML("beforeend", html);
  scrollAssistantToBottom();
}

function updateReaderAssistantMessageText(id, text) {
  const node = document.querySelector(`#${CSS.escape(id)} .assistant-message-body`);
  if (!node) return;
  node.innerHTML = escapeHtml(text ?? "").replace(/\n/g, "<br>");
  scrollAssistantToBottom();
}

function readerAssistantMessageHtml({ id, role, text, label, elapsed = "", extraHtml = "" }) {
  return `
    <article id="${escapeHtml(id)}" class="assistant-message ${escapeHtml(role)}">
      <div class="assistant-message-meta">
        <span>${escapeHtml(label)}</span>
        ${elapsed ? `<span class="assistant-elapsed">${escapeHtml(elapsed)}</span>` : ""}
      </div>
      <div class="assistant-message-body">${escapeHtml(text ?? "").replace(/\n/g, "<br>")}</div>
      ${extraHtml}
    </article>
  `;
}

function startReaderAssistantTimer(messageId, startedAt) {
  stopReaderAssistantTimer();
  readerAssistantTimer = setInterval(() => {
    const node = document.querySelector(`#${CSS.escape(messageId)} .assistant-elapsed`);
    const label = elapsedLabel(startedAt);
    if (node) node.textContent = label;
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = label;
  }, 100);
}

function stopReaderAssistantTimer() {
  if (readerAssistantTimer) clearInterval(readerAssistantTimer);
  readerAssistantTimer = null;
}

function elapsedLabel(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function scrollAssistantToBottom() {
  if (!elements.readerAssistantAnswer) return;
  elements.readerAssistantAnswer.scrollTop = elements.readerAssistantAnswer.scrollHeight;
}

function rememberReaderAssistantTurn(question = "", answer = "") {
  const next = [
    ...readerAssistantHistory,
    { role: "user", content: question },
    { role: "assistant", content: answer }
  ].filter((message) => message.content?.trim());
  readerAssistantHistory = next.slice(-6);
}

function renderReaderAssistantAnswer(result = {}, pendingId = "", elapsed = "") {
  const citations = result.citations ?? [];
  const extraHtml = `
    ${result.includeCitations && citations.length ? `
      <section class="assistant-citations">
        <h4>Local citations</h4>
        ${citationRows(citations)}
      </section>
    ` : ""}
  `;
  replaceReaderAssistantMessage(pendingId, "assistant", result.answer ?? "", "Assistant", elapsed, extraHtml);
}

function setTrashTab() {
  renderTrash();
}

function renderTrash() {
  if (!elements.trashBooks) return;
  const deletedDocumentIds = new Set((state.trash?.documents ?? []).map((document) => document.id));
  state.selectedTrashDocuments = new Set([...state.selectedTrashDocuments].filter((id) => deletedDocumentIds.has(id)));
  renderTrashBooks();
  updateTrashActionButtons();
}

function renderTrashBooks() {
  if (!elements.trashBooks) return;
  elements.trashBooks.style.setProperty("--library-book-size", `${state.libraryZoom}px`);
  elements.trashBooks.innerHTML = "";
  const documents = state.trash?.documents ?? [];
  elements.trashBooks.classList.toggle("empty-panel", documents.length === 0);
  if (documents.length === 0) {
    elements.trashBooks.innerHTML = `<p class="empty trash-empty">No deleted books.</p>`;
    return;
  }

  for (const item of documents) {
    const card = document.createElement("article");
    card.className = `library-book trash-book${state.selectedTrashDocuments.has(item.id) ? " selected" : ""}`;
    card.dataset.documentId = item.id;
    card.innerHTML = `
      <button class="word-select book-select" type="button" aria-label="Select ${escapeHtml(item.title)}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5 6.4 11.5 2.5 7.7"/></svg>
      </button>
      <div class="library-open trash-preview">
        ${coverMarkup(item, "library-cover")}
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.type?.toUpperCase() ?? "BOOK")}</span>
      </div>
      <div class="library-actions">
        <button class="restore" type="button">Restore</button>
        <button class="delete-permanent" type="button">Delete</button>
      </div>
    `;
    card.querySelector(".book-select").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTrashDocumentSelection(item.id);
    });
    card.querySelector(".restore").addEventListener("click", () => restoreTrashDocument(item));
    card.querySelector(".delete-permanent").addEventListener("click", () => deleteTrashDocument(item));
    elements.trashBooks.append(card);
  }
  renderPdfCovers(elements.trashBooks);
}

function formatDeletedAt(entry) {
  const value = typeof entry === "object" ? entry?.deletedAt : "";
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Deleted ${date.toLocaleDateString()}`;
}


function toggleTrashDocumentSelection(id) {
  if (state.selectedTrashDocuments.has(id)) state.selectedTrashDocuments.delete(id);
  else state.selectedTrashDocuments.add(id);
  const card = elements.trashBooks.querySelector(`[data-document-id="${cssEscape(id)}"]`);
  card?.classList.toggle("selected", state.selectedTrashDocuments.has(id));
  updateTrashActionButtons();
}

function updateTrashActionButtons() {
  const count = state.selectedTrashDocuments.size;
  elements.trashDeleteSelected?.classList.toggle("hidden", count === 0);
  if (elements.trashDeleteSelected) elements.trashDeleteSelected.textContent = count ? `Delete ${count}` : "Delete";
  elements.trashDeleteAll?.classList.toggle("hidden", count > 0 || !state.trash?.documents?.length);
}

async function restoreTrashDocument(item) {
  if (!(await confirmAction(`Restore "${item.title}" to the library?`, { title: "Restore book?", confirmText: "Restore", variant: "restore" }))) return;
  await api(`/api/trash/documents/${item.id}/restore`, { method: "POST" });
  await loadState();
  setTrashTab("books");
}

async function deleteTrashDocument(item) {
  if (!(await confirmAction(`Permanently delete "${item.title}"? This cannot be undone.`, { title: "Delete forever?", confirmText: "Delete" }))) return;
  await api(`/api/trash/documents/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  await loadState();
  setTrashTab("books");
}

async function deleteSelectedTrashDocuments() {
  const ids = [...state.selectedTrashDocuments];
  if (ids.length === 0) return;
  const label = ids.length === 1 ? "Permanently delete this book?" : `Permanently delete ${ids.length} books?`;
  if (!(await confirmAction(`${label} This cannot be undone.`, { title: "Delete forever?", confirmText: "Delete" }))) return;
  for (const id of ids) {
    await api(`/api/trash/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  state.selectedTrashDocuments.clear();
  await loadState();
  setTrashTab("books");
}

function deleteSelectedTrashItems() {
  return deleteSelectedTrashDocuments();
}

async function deleteAllTrashItems() {
  const count = state.trash?.documents?.length ?? 0;
  if (!count) return;
  if (!(await confirmAction(`Permanently delete all ${count.toLocaleString()} deleted books? This cannot be undone.`, { title: "Delete all forever?", confirmText: "Delete all" }))) return;
  await api("/api/trash/documents", { method: "DELETE" });
  await loadState();
  renderTrash();
}


function compactPageNumbers(current, total) {
  const slots = 10;
  if (total <= slots) return [...Array.from({ length: total }, (_, index) => index + 1), ...Array.from({ length: slots - total }, () => "blank")];
  if (current <= 6) return [1, 2, 3, 4, 5, 6, 7, "gap", total - 1, total];
  if (current >= total - 5) return [1, 2, "gap", total - 6, total - 5, total - 4, total - 3, total - 2, total - 1, total];
  return [1, 2, "gap", current - 2, current - 1, current, current + 1, current + 2, "gap", total];
}

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


function renderSyncStatus(extra = "") {
  if (!elements.syncSummary) return;
  const sync = state.sync ?? {};
  if (elements.syncStatus) {
    elements.syncStatus.textContent = sync.signedIn ? "Connected" : sync.configured ? "Configured" : "Off";
  }
  if (elements.syncUrl) elements.syncUrl.value = sync.supabaseUrl ?? "";
  if (elements.syncAnonKey) elements.syncAnonKey.value = sync.hasAnonKey ? "********" : "";
  if (elements.syncDeviceName) elements.syncDeviceName.value = sync.deviceName ?? "";
  if (elements.syncEnabled) elements.syncEnabled.checked = Boolean(sync.enabled);
  const rows = [
    `Status: ${sync.status || "disabled"}`,
    `Signed in: ${sync.userEmail || "No"}`,
    `Device: ${sync.deviceName || "Local device"}`,
    `Last sync: ${sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Never"}`,
    sync.diagnostics ? `Book files: ${Number(sync.diagnostics.uploadableFiles ?? 0).toLocaleString()} uploadable / ${Number(sync.diagnostics.documents ?? 0).toLocaleString()} total${sync.diagnostics.missingFiles ? ` (${Number(sync.diagnostics.missingFiles).toLocaleString()} missing original files)` : ""}` : "",
    sync.diagnostics?.textIndexStale ? "Text search index: refresh needed after pull" : "",
    sync.lastError ? `Last error: ${sync.lastError}` : "",
    extra
  ].filter(Boolean);
  elements.syncSummary.textContent = rows.join("\n");
}

function syncSettingsPayload() {
  const anonKey = elements.syncAnonKey?.value?.trim() ?? "";
  return {
    supabaseUrl: elements.syncUrl?.value?.trim() ?? "",
    ...(anonKey && anonKey !== "********" ? { supabaseAnonKey: anonKey } : {}),
    deviceName: elements.syncDeviceName?.value?.trim() ?? "",
    enabled: Boolean(elements.syncEnabled?.checked)
  };
}

async function saveSyncSettings() {
  const result = await api("/api/sync/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(syncSettingsPayload())
  });
  state.sync = result;
  renderSyncStatus("Sync settings saved.");
}

async function signInSync() {
  await saveSyncSettings();
  const result = await api("/api/sync/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: elements.syncEmail?.value?.trim() ?? "",
      password: elements.syncPassword?.value ?? "",
      ...syncSettingsPayload()
    })
  });
  state.sync = result;
  if (elements.syncPassword) elements.syncPassword.value = "";
  renderSyncStatus("Signed in to Supabase.");
}

async function runSyncAction(action, label) {
  setSyncLoading(true, label);
  try {
    const result = await api(`/api/sync/${action}`, { method: "POST" });
    state.sync = result;
    if (action === "pull" || action === "run") await loadState();
    renderSyncStatus(syncResultSummary(result));
  } catch (error) {
    renderSyncStatus(error.message);
  } finally {
    setSyncLoading(false);
  }
}

function syncResultSummary(result = {}) {
  const payload = result.pushed ?? result.pulled;
  if (!payload) return "Sync complete.";
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${Number(value).toLocaleString()}`)
    .join(" | ");
}

function setSyncLoading(loading, label = "Syncing") {
  for (const button of [elements.syncSaveSettings, elements.syncSignIn, elements.syncSignOut, elements.syncPush, elements.syncPull, elements.syncNow]) {
    if (button) button.disabled = loading;
  }
  if (loading && elements.syncSummary) elements.syncSummary.textContent = `${label}...`;
}

function formatDateTime(value = "") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

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

async function loadMediaProviders() {
  if (!elements.mediaSettingsForm) return;
  try {
    const result = await api("/api/media/providers");
    state.mediaProviders = result;
    state.media = result.settings ?? state.media;
    renderMediaSettings(result);
  } catch (error) {
    if (elements.mediaStatus) elements.mediaStatus.textContent = "Unavailable";
    if (elements.mediaPreview) elements.mediaPreview.textContent = error.message;
  }
}

function renderMediaSettings(result = state.mediaProviders) {
  if (!elements.mediaSettingsForm) return;
  state.media = result.settings ?? state.media;
  elements.mediaImageEnabled.checked = Boolean(state.media.image?.enabled);
  renderMediaStatus(result);
}

function renderMediaStatus(result = state.mediaProviders) {
  if (!elements.mediaStatus || !elements.mediaPreview) return;
  const enabled = Boolean(state.media.image?.enabled);
  elements.mediaStatus.textContent = enabled ? "Local" : "Off";
  elements.mediaPreview.textContent = enabled ? "Local mnemonic images enabled." : "Local image generation is disabled.";
}

async function saveMediaSettings(event, { updateStatus = true } = {}) {
  event?.preventDefault();
  if (!elements.mediaSettingsForm) return;
  if (elements.saveMediaSettings) elements.saveMediaSettings.disabled = true;
  try {
    const result = await api("/api/media/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: {
          enabled: elements.mediaImageEnabled.checked,
          provider: "local-mnemonic"
        }
      })
    });
    state.mediaProviders = result.providers;
    state.media = result.settings;
    if (updateStatus) renderMediaStatus(result.providers);
    await loadModelFields();
  } catch (error) {
    elements.mediaPreview.textContent = error.message;
  } finally {
    if (elements.saveMediaSettings) elements.saveMediaSettings.disabled = false;
  }
}

function queueSaveMediaSettings() {
  clearTimeout(mediaSettingsSaveTimer);
  mediaSettingsSaveTimer = setTimeout(() => saveMediaSettings(), 260);
}

async function testMedia() {
  const button = elements.testMediaImage;
  button.disabled = true;
  elements.mediaPreview.textContent = "Generating image...";
  try {
    clearTimeout(mediaSettingsSaveTimer);
    await saveMediaSettings();
    const result = await api("/api/media/test-image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "\u56f3\u66f8\u9928", reading: "\u3068\u3057\u3087\u304b\u3093", meaning: "library" })
    });
    renderMediaTestResult(result);
  } catch (error) {
    elements.mediaPreview.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderMediaTestResult(result = {}) {
  const filename = mediaFilenameFromValue(result.value);
  if (!filename) {
    elements.mediaPreview.textContent = "No image generated. Enable local mnemonic image.";
    return;
  }
  elements.mediaPreview.innerHTML = `<img class="media-preview-image" src="/media/anki-media/${encodeURIComponent(filename)}" alt="Generated mnemonic preview">`;
}

function mediaFilenameFromValue(value = "") {
  const text = String(value ?? "");
  return text.match(/\[sound:([^\]]+)\]/i)?.[1] ?? text.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
}

async function loadAiProviders() {
  if (!elements.aiStatus && !elements.aiModelList) return;
  try {
    const result = await api("/api/ai/providers");
    state.aiProviders = result;
    state.ai = result.settings ?? state.ai;
    renderAiSettings(result);
    await refreshAiRuntimeStatus();
  } catch (error) {
    if (elements.aiStatus) elements.aiStatus.textContent = "Unavailable";
    if (elements.aiPreview) elements.aiPreview.textContent = error.message;
  }
}

function renderAiSettings(result = state.aiProviders) {
  const settings = result.settings ?? state.ai;
  const models = (result.models ?? settings.models ?? []).filter((model) => model.task === "translation");
  state.ai = settings;
  renderReaderAssistantModels(models, settings.translation?.modelId || "");
  renderAiModels(models);
  renderAiStatus(result);
}

function renderReaderAssistantModels(models = [], selectedModelId = "") {
  if (!elements.readerAssistantModel) return;
  const preferredId = "sugoi-14b-ultra-q4-k-m";
  const currentValue = elements.readerAssistantModel.value || selectedModelId || preferredId;
  elements.readerAssistantModel.innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join("");
  const nextValue = models.some((model) => model.id === currentValue)
    ? currentValue
    : models.some((model) => model.id === preferredId)
      ? preferredId
      : models[0]?.id || "";
  elements.readerAssistantModel.value = nextValue;
}

function renderAiStatus(result = state.aiProviders) {
  if (!elements.aiStatus) return;
  const status = result.status ?? {};
  const translation = status.translation ?? {};
  elements.aiStatus.textContent = translation.configured ? "Local" : "Setup needed";
  if (elements.aiPreview && !state.aiRuntime) {
    elements.aiPreview.textContent = translation.configured
      ? "Runtime: auto-starts on message"
      : "Runtime: setup needed";
  }
}

function renderAiModels(models = []) {
  if (!elements.aiModelList) return;
  if (models.length === 0) {
    elements.aiModelList.innerHTML = `<p class="empty compact-empty">No assistant models available.</p>`;
    return;
  }
  elements.aiModelList.innerHTML = models.map((model) => `
    <div class="voice-model-row">
      <div>
        <strong>${escapeHtml(model.name)}</strong>
        <span>${escapeHtml(model.status === "ready" ? "Ready - local runtime installed" : model.status === "imported" ? "Imported - runtime required" : model.status)}</span>
      </div>
      ${model.url ? `<a href="${escapeHtml(model.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
    </div>
  `).join("");
}

async function importAiModel(event) {
  event?.preventDefault();
  const url = elements.aiModelUrl?.value?.trim();
  if (!url) {
    elements.aiPreview.textContent = "Enter a Hugging Face model URL before importing.";
    return;
  }
  elements.importAiModel.disabled = true;
  try {
    const result = await api("/api/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, task: "translation" })
    });
    state.aiProviders = result;
    state.ai = result.settings;
    elements.aiModelUrl.value = "";
    renderAiSettings(result);
    elements.aiPreview.textContent = `${result.model.name} imported. Configure a local runtime before it can answer in the reader.`;
  } catch (error) {
    elements.aiPreview.textContent = error.message;
  } finally {
    elements.importAiModel.disabled = false;
  }
}

async function refreshAiRuntimeStatus() {
  if (!elements.aiPreview && !elements.stopAiRuntime) return;
  try {
    const runtime = await api("/api/ai/runtime");
    state.aiRuntime = runtime;
    renderAiRuntimeStatus(runtime);
  } catch (error) {
    if (elements.aiPreview) elements.aiPreview.textContent = `Runtime: ${error.message}`;
    if (elements.stopAiRuntime) elements.stopAiRuntime.disabled = true;
  }
}

function renderAiRuntimeStatus(runtime = state.aiRuntime) {
  if (!elements.aiPreview && !elements.stopAiRuntime) return;
  const running = Boolean(runtime?.running);
  const count = Number(runtime?.count || 0);
  const timeout = Number(runtime?.idleTimeoutSeconds || 0);
  const timeoutLabel = timeout > 0 ? `${Math.round(timeout / 60)} min idle timeout` : "no idle timeout";
  if (elements.aiPreview) {
    elements.aiPreview.textContent = running
      ? `Runtime: running (${count} model${count === 1 ? "" : "s"}, ${timeoutLabel})`
      : `Runtime: off (auto-starts on message, ${timeoutLabel})`;
  }
  if (elements.stopAiRuntime) elements.stopAiRuntime.disabled = !running;
}

async function stopAiRuntime() {
  if (!elements.stopAiRuntime) return;
  elements.stopAiRuntime.disabled = true;
  if (elements.aiPreview) elements.aiPreview.textContent = "Runtime: stopping...";
  try {
    const result = await api("/api/ai/runtime/stop", { method: "POST" });
    state.aiRuntime = result;
    renderAiRuntimeStatus(result);
  } catch (error) {
    if (elements.aiPreview) elements.aiPreview.textContent = `Runtime: ${error.message}`;
  }
}

function showFloatingTooltip(target) {
  const message = target?.dataset?.tooltip;
  if (!message) return;
  let tooltip = document.querySelector(".floating-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "floating-tooltip";
    document.body.append(tooltip);
  }
  tooltip.textContent = message;
  const rect = target.getBoundingClientRect();
  const gap = 8;
  const tooltipWidth = 220;
  const left = Math.min(Math.max(gap, rect.left + rect.width / 2 - tooltipWidth / 2), window.innerWidth - tooltipWidth - gap);
  const belowTop = rect.bottom + gap;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${belowTop}px`;
  tooltip.hidden = false;
}

function hideFloatingTooltip() {
  const tooltip = document.querySelector(".floating-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function setReaderMode(mode) {
  if (mode === state.readerMode) return;
  if (!state.activeDocumentId) {
    state.readerMode = mode;
    syncReaderModeButtons();
    return;
  }
  captureCurrentReaderHtml();
  state.readerMode = mode;
  syncReaderModeButtons();
  renderReader({ mode, page: state.currentPage, scrollTop: elements.reader.scrollTop, zoom: state.readerZoom });
  saveProgress();
}

function normalizeZoom(value) {
  return Math.max(75, Math.min(175, Number(value) || 100));
}

function updateReaderFitVars(zoom = state.readerZoom) {
  if (!elements.reader) return;
  const styles = getComputedStyle(elements.reader);
  const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const titleReserve = elements.reader.classList.contains("image-page") ? 48 : 0;
  const fitWidth = Math.max(260, elements.reader.clientWidth - paddingX);
  const fitHeight = Math.max(260, elements.reader.clientHeight - paddingY - titleReserve);
  const scale = normalizeZoom(zoom) / 100;
  elements.reader.style.setProperty("--reader-fit-width", `${fitWidth}px`);
  elements.reader.style.setProperty("--reader-fit-height", `${fitHeight}px`);
  elements.reader.style.setProperty("--reader-zoom-width", `${fitWidth * scale}px`);
  elements.reader.style.setProperty("--reader-zoom-height", `${fitHeight * scale}px`);
}

function applyReaderZoom() {
  const zoom = normalizeZoom(state.readerZoom);
  state.readerZoom = zoom;
  updateReaderFitVars(zoom);
  elements.reader.style.fontSize = `${20 * (zoom / 100)}px`;
  elements.reader.style.setProperty("--reader-zoom", String(zoom / 100));
  elements.readerZoom.value = String(zoom);
  elements.zoomLabel.textContent = `${zoom}%`;
}

let zoomSaveTimer;
function setReaderZoom(value) {
  state.readerZoom = normalizeZoom(value);
  requestAnimationFrame(applyReaderZoom);
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => saveProgress({ refreshLibrary: false }), 900);
}

let readerResizeTimer;
function refreshReaderFitSoon() {
  clearTimeout(readerResizeTimer);
  readerResizeTimer = setTimeout(() => {
    updateReaderFitVars(state.readerZoom);
  }, 80);
}

function currentReaderPercentage() {
  const total = Math.max(1, state.activePages.length);
  const maxScroll = Math.max(0, elements.reader.scrollHeight - elements.reader.clientHeight);
  const inPage = state.readerMode === "scroll" && maxScroll > 0 ? elements.reader.scrollTop / maxScroll : 0;
  return ((state.currentPage + inPage) / total) * 100;
}

function updatePagedFooter() {
  const total = Math.max(1, state.activePages.length);
  const chapterTotal = Math.max(1, state.activeChapters.length);
  const chapterNumber = currentChapterNumber();
  elements.prevPage.disabled = state.currentPage === 0;
  elements.nextPage.disabled = state.currentPage >= total - 1;
  elements.pageJumpInput.max = String(total);
  elements.pageJumpInput.value = String(state.currentPage + 1);
  elements.pageLabel.innerHTML = `Pages <span class="status-pill">${state.currentPage + 1}</span> / ${total}<span class="status-gap"></span>Chapters <span class="status-pill">${chapterNumber}</span> / ${chapterTotal}`;
  setProgress(currentReaderPercentage());
  renderBookmarks();
}

function currentChapterNumber() {
  const index = state.activeChapters.findIndex((chapter) => chapter.id === state.activeChapterId);
  return index >= 0 ? index + 1 : 1;
}

function turnPage(delta, options = {}) {
  if (!state.activeDocumentId) return;
  const nextPage = Math.max(0, Math.min(state.activePages.length - 1, state.currentPage + delta));
  if (nextPage === state.currentPage) return;
  captureCurrentReaderHtml();
  state.currentPage = nextPage;
  renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: options.scrollTop ?? 0, zoom: state.readerZoom });
  saveProgress();
}

function jumpToPage(value) {
  if (!state.activeDocumentId) return;
  const page = Math.max(0, Math.min(state.activePages.length - 1, Number(value) - 1));
  if (!Number.isFinite(page)) return;
  if (page === state.currentPage) {
    elements.pageJumpInput.value = String(state.currentPage + 1);
    return;
  }
  captureCurrentReaderHtml();
  state.currentPage = page;
  renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: 0, zoom: state.readerZoom });
  saveProgress();
}

function normalizeBookHref(value = "") {
  return decodeURIComponent(String(value).replace(/\\/g, "/").split("#")[0]).replace(/^\.\//, "");
}

function jumpToEpubHref(href) {
  const target = normalizeBookHref(href);
  const chapter = state.activeChapters.find((item) => normalizeBookHref(item.href) === target);
  if (!chapter) return false;
  const pageIndex = state.activePages.findIndex((page) => page.chapterId === chapter.id);
  if (pageIndex < 0) return false;
  captureCurrentReaderHtml();
  state.currentPage = pageIndex;
  state.activeChapterId = chapter.id;
  renderReader({ mode: state.readerMode, page: state.currentPage, scrollTop: 0, zoom: state.readerZoom });
  saveProgress();
  return true;
}

function setProgress(value) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  elements.progressLabel.textContent = `Progress: ${clamped.toFixed(2)}%`;
  elements.progressBar.value = clamped;
}

let progressTimer;
function saveProgress(options = {}) {
  if (!state.activeDocumentId) return;
  const { refreshLibrary = true, delay = 300 } = options;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    api(`/api/documents/${state.activeDocumentId}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        percentage: Number(elements.progressBar.value) || 0,
        page: state.currentPage,
        mode: state.readerMode,
        chapterId: state.activeChapterId,
        scrollTop: elements.reader.scrollTop,
        zoom: state.readerZoom,
        highlights: state.highlights,
        bookmarks: state.bookmarks
      })
    }).then((progress) => {
      state.progress[state.activeDocumentId] = progress;
      if (refreshLibrary) {
        renderDocuments();
        renderBooksGrid();
      }
    });
  }, delay);
}

function updateReaderToolbar() {
  document.body.classList.toggle("has-active-reader", Boolean(state.activeDocumentId));
}

function normalizeHighlights(value) {
  return {
    pages: value?.pages && typeof value.pages === "object" ? value.pages : {},
    scrollHtml: typeof value?.scrollHtml === "string" ? value.scrollHtml : ""
  };
}

function isEmptyHighlightHtml(value = "") {
  const text = String(value).replace(/<[^>]+>/g, "").trim();
  const hasImage = /<img\b/i.test(value);
  const hasHighlight = /reader-highlight/.test(value);
  return !hasImage && !hasHighlight && text.length === 0;
}

function pruneEmptyHighlightPages() {
  for (const [page, html] of Object.entries(state.highlights.pages)) {
    if (isEmptyHighlightHtml(html)) delete state.highlights.pages[page];
  }
}

function savedPageHtml(pageIndex) {
  const html = state.highlights.pages[String(pageIndex)];
  if (!html || isEmptyHighlightHtml(html)) {
    delete state.highlights.pages[String(pageIndex)];
    return "";
  }
  return html;
}

function currentHighlightSnapshot() {
  return {
    mode: state.readerMode,
    page: state.currentPage,
    html: serializableReaderHtml(),
    scrollTop: elements.reader.scrollTop
  };
}

function restoreHighlightSnapshot(snapshot) {
  if (!snapshot) return;
  state.readerMode = snapshot.mode;
  state.currentPage = snapshot.page;
  state.highlights.pages[String(snapshot.page)] = snapshot.html;
  state.activeChapterId = state.activePages[state.currentPage]?.chapterId || state.activeChapterId;
  elements.modeScroll.classList.toggle("active", snapshot.mode === "scroll");
  elements.modePaged.classList.toggle("active", snapshot.mode === "paged");
  elements.reader.innerHTML = sanitizeSnapshotHtml(snapshot.html);
  elements.reader.scrollTop = snapshot.scrollTop ?? elements.reader.scrollTop;
  requestAnimationFrame(() => {
    elements.reader.scrollTop = snapshot.scrollTop ?? elements.reader.scrollTop;
    updatePagedFooter();
    renderPdfPages(elements.reader);
  });
  renderChapters();
  renderBookmarks();
}

function pushHighlightUndo() {
  state.highlightUndo.push(currentHighlightSnapshot());
  if (state.highlightUndo.length > 50) state.highlightUndo.shift();
  state.highlightRedo = [];
}

function captureCurrentReaderHtml() {
  if (!state.activeDocumentId) return;
  const html = serializableReaderHtml();
  if (/reader-highlight/.test(html)) state.highlights.pages[String(state.currentPage)] = html;
  else delete state.highlights.pages[String(state.currentPage)];
}

function serializableReaderHtml() {
  const clone = elements.reader.cloneNode(true);
  stripReaderSearchMarkup(clone);
  clone.querySelectorAll(".pdf-page-render").forEach((node) => {
    node.removeAttribute("data-rendered");
    node.removeAttribute("data-rendering");
  });
  return clone.innerHTML;
}

function sanitizeSnapshotHtml(html = "") {
  const template = document.createElement("template");
  template.innerHTML = html;
  stripReaderSearchMarkup(template.content);
  template.content.querySelectorAll(".pdf-page-render").forEach((node) => {
    node.removeAttribute("data-rendered");
    node.removeAttribute("data-rendering");
  });
  return template.innerHTML;
}

function selectionInsideReader(selection) {
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return elements.reader.contains(range.commonAncestorContainer);
}

function highlightSelection() {
  if (!state.activeDocumentId) return;
  const selection = window.getSelection();
  if (!selectionInsideReader(selection) || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const segments = textSegmentsInRange(range);
  if (segments.length === 0) {
    selection.removeAllRanges();
    return;
  }
  pushHighlightUndo();
  for (const segment of segments.reverse()) wrapTextSegment(segment);
  selection.removeAllRanges();
  captureCurrentReaderHtml();
  saveProgress();
}

function textSegmentsInRange(range) {
  const walker = document.createTreeWalker(elements.reader, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".reader-highlight") || parent.closest("rt")) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const segments = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (start < end && node.nodeValue.slice(start, end).trim()) segments.push({ node, start, end });
  }
  return segments;
}

function wrapTextSegment({ node, start, end }) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const mark = document.createElement("span");
  mark.className = "reader-highlight";
  mark.dataset.highlightId = crypto.randomUUID();
  mark.style.backgroundColor = transparentColor(state.highlightColor);
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function eraseHighlight(target) {
  const mark = target.closest?.(".reader-highlight");
  if (!mark) return false;
  pushHighlightUndo();
  unwrapHighlight(mark);
  captureCurrentReaderHtml();
  saveProgress();
  return true;
}

function eraseHighlightsInSelection() {
  if (!state.activeDocumentId) return false;
  const selection = window.getSelection();
  if (!selectionInsideReader(selection) || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const marks = [...elements.reader.querySelectorAll(".reader-highlight")].filter((mark) => range.intersectsNode(mark));
  if (marks.length === 0) return false;
  pushHighlightUndo();
  for (const mark of marks) unwrapHighlight(mark);
  selection.removeAllRanges();
  captureCurrentReaderHtml();
  saveProgress();
  return true;
}

async function showDictionaryLookupFromSelection() {
  const selection = window.getSelection();
  if (!selectionInsideReader(selection) || selection.isCollapsed) return false;
  const term = lookupTermFromRange(selection.getRangeAt(0)) || lookupTermFromSelection(selection);
  if (!term) return false;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return showDictionaryLookup(term, rect, range);
}

async function showDictionaryLookup(term, rect, preview = null, fallback = null) {
  const requestId = ++hoverLookupRequest;
  setLookupPreview(preview);
  elements.dictionaryLookup.classList.remove("hidden");
  elements.dictionaryLookup.innerHTML = `<p class="empty">Looking up ${escapeHtml(term)}...</p>`;
  positionLookupPopover(rect);
  try {
    const prefix = state.dictionarySettings?.prefixWildcardSearch ? "&prefix=true" : "";
    const cacheKey = `${term}\u0000${prefix}\u0000${state.knownTermsCount}`;
    const result = state.dictionaryLookupCache.get(cacheKey) ?? await api(`/api/dictionary/lookup?term=${encodeURIComponent(term)}${prefix}`);
    state.dictionaryLookupCache.set(cacheKey, result);
    if (state.dictionaryLookupCache.size > 200) state.dictionaryLookupCache.delete(state.dictionaryLookupCache.keys().next().value);
    if (requestId !== hoverLookupRequest) return false;
    if (fallback && !dictionaryLookupHasDirectMatch(result, term)) {
      shiftHoverAnchorRange = fallback.anchor ?? shiftHoverAnchorRange;
      hoverLookupLastTerm = fallback.term;
      return showDictionaryLookup(fallback.term, fallback.rect, fallback.preview);
    }
    renderDictionaryLookup(term, result, preview);
    positionLookupPopover(rect);
  } catch (error) {
    if (requestId !== hoverLookupRequest) return false;
    elements.dictionaryLookup.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
  return true;
}

function dictionaryLookupIsEmpty(result) {
  return (result.entries?.length ?? 0) === 0 && (result.frequencies?.length ?? 0) === 0;
}

function dictionaryLookupHasDirectMatch(result, term) {
  const normalized = sanitizeLookupText(term);
  if (!normalized || dictionaryLookupIsEmpty(result)) return false;
  const directEntry = (result.entries ?? []).some((entry) =>
    sanitizeLookupText(entry.matchedTerm ?? "") === normalized ||
    sanitizeLookupText(entry.term ?? "") === normalized ||
    sanitizeLookupText(entry.reading ?? "") === normalized
  );
  const directFrequency = (result.frequencies ?? []).some((entry) =>
    sanitizeLookupText(entry.matchedTerm ?? "") === normalized
  );
  return directEntry || directFrequency;
}

function lookupTermFromSelection(selection) {
  if (!selection || selection.rangeCount === 0) return "";
  return lookupTermFromRange(selection.getRangeAt(0)) || sanitizeLookupText(selection.toString());
}

function lookupTermFromRange(range) {
  if (!range) return "";
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.("rt, rp").forEach((node) => node.remove());
  return sanitizeLookupText(fragment.textContent || "");
}

function kanaPrefix(text = "", limit = 4) {
  const match = String(text).match(/^[\u3040-\u30ff\u30fc]+/u);
  if (!match) return "";
  return match[0].slice(0, limit);
}

function sanitizeLookupText(text = "") {
  return text
    .replace(/\s+/g, "")
    .replace(/^[^\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]+|[^\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]+$/gu, "")
    .trim();
}

function lookupTermFromSelectionLegacy(selection) {
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.("rt, rp").forEach((node) => node.remove());
  const text = fragment.textContent || selection.toString();
  return text
    .replace(/\s+/g, "")
    .replace(/^[^\u3040-\u30ff\u3400-\u9fff々〆ヵヶー]+|[^\u3040-\u30ff\u3400-\u9fff々〆ヵヶー]+$/gu, "")
    .trim();
}

function caretRangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const position = document.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function rubySurfaceText(ruby) {
  const clone = ruby.cloneNode(true);
  clone.querySelectorAll("rt, rp").forEach((node) => node.remove());
  return sanitizeLookupText(clone.textContent || ruby.dataset.base || "");
}

function lookupTermElementFromNode(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return element?.closest?.("ruby[data-base], .lookup-token[data-base]") ?? null;
}

function lookupElementTerm(element) {
  if (!element) return "";
  if (element.matches?.("ruby[data-base]")) return rubySurfaceText(element) || sanitizeLookupText(element.dataset.base || "");
  return sanitizeLookupText(element.textContent || element.dataset.base || "");
}

function lookupTargetFromPoint(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element || !elements.reader.contains(element)) return null;
  const lookupElement = lookupTermElementFromNode(element);
  if (lookupElement && elements.reader.contains(lookupElement)) {
    return { term: lookupElementTerm(lookupElement), rect: lookupElement.getBoundingClientRect(), preview: lookupElement };
  }

  const range = caretRangeFromPoint(x, y);
  if (!range || !elements.reader.contains(range.startContainer)) return null;
  const rangeLookupElement = lookupTermElementFromNode(range.startContainer);
  if (rangeLookupElement && elements.reader.contains(rangeLookupElement)) {
    return { term: lookupElementTerm(rangeLookupElement), rect: rangeLookupElement.getBoundingClientRect(), preview: rangeLookupElement };
  }
  const termRange = wordRangeFromCaret(range);
  if (!termRange) return null;
  return { term: lookupTermFromRange(termRange), rect: termRange.getBoundingClientRect(), preview: termRange };
}

function lookupBoundaryRangeFromPoint(x, y, edge = "start") {
  const element = document.elementFromPoint(x, y);
  const lookupElement = lookupTermElementFromNode(element);
  if (lookupElement && elements.reader.contains(lookupElement)) {
    const range = document.createRange();
    if (edge === "end") range.setStartAfter(lookupElement);
    else range.setStartBefore(lookupElement);
    range.collapse(true);
    return range;
  }

  const caret = caretRangeFromPoint(x, y);
  if (!caret || !elements.reader.contains(caret.startContainer)) return null;
  const rangeLookupElement = lookupTermElementFromNode(caret.startContainer);
  if (rangeLookupElement && elements.reader.contains(rangeLookupElement)) {
    const range = document.createRange();
    if (edge === "end") range.setStartAfter(rangeLookupElement);
    else range.setStartBefore(rangeLookupElement);
    range.collapse(true);
    return range;
  }
  const wordRange = wordRangeFromCaret(caret);
  if (!wordRange) return caret;
  const range = document.createRange();
  if (edge === "end") range.setStart(wordRange.endContainer, wordRange.endOffset);
  else range.setStart(wordRange.startContainer, wordRange.startOffset);
  range.collapse(true);
  return range;
}

function wordRangeFromCaret(range) {
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.nodeValue || "";
  if (!text.trim()) return null;
  const offset = Math.max(0, Math.min(range.startOffset, text.length));
  const segment = japaneseWordSegmentAt(text, offset);
  if (!segment) return null;
  const wordRange = document.createRange();
  wordRange.setStart(node, segment.start);
  wordRange.setEnd(node, segment.end);
  return wordRange;
}

function nextLookupTextNode(node) {
  const walker = document.createTreeWalker(
    elements.reader,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || parent.closest("rt, rp, #dictionary-lookup")) return NodeFilter.FILTER_REJECT;
        if (!textNode.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  walker.currentNode = node;
  return walker.nextNode();
}

function firstLookupTextNode(node) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node;
  const walker = document.createTreeWalker(
    node,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || parent.closest("rt, rp, #dictionary-lookup")) return NodeFilter.FILTER_REJECT;
        if (!textNode.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  return walker.nextNode();
}

function expandLookupRangeRight(range) {
  if (!range) return null;
  const expanded = range.cloneRange();
  let textNode = null;
  let startOffset = 0;

  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    textNode = range.endContainer;
    startOffset = range.endOffset;
  } else {
    textNode = firstLookupTextNode(range.endContainer.childNodes[range.endOffset]);
    if (!textNode) textNode = nextLookupTextNode(range.endContainer);
  }

  let suffix = "";
  while (textNode && suffix.length < 4) {
    const text = textNode.nodeValue || "";
    const part = kanaPrefix(text.slice(startOffset), 4 - suffix.length);
    if (!part) break;
    suffix += part;
    expanded.setEnd(textNode, startOffset + part.length);
    if (part.length < text.slice(startOffset).length) break;
    textNode = nextLookupTextNode(textNode);
    startOffset = 0;
  }

  return suffix ? expanded : range;
}

function japaneseWordSegmentAt(text, offset) {
  const clean = (value) => sanitizeLookupText(value);
  if (Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    for (const part of segmenter.segment(text)) {
      const start = part.index;
      const end = start + part.segment.length;
      if (offset < start || offset > end) continue;
      if (part.isWordLike && clean(part.segment)) return { start, end };
    }
  }
  const isJapanese = (char) => /[\u3040-\u30ff\u3400-\u9fff\u3005\u3006\u30f5\u30f6\u30fc]/u.test(char);
  let start = offset;
  let end = offset;
  while (start > 0 && isJapanese(text[start - 1])) start -= 1;
  while (end < text.length && isJapanese(text[end])) end += 1;
  if (end - start > 8) end = Math.min(text.length, offset + 8);
  return clean(text.slice(start, end)) ? { start, end } : null;
}

function rangeBetweenPoints(anchorRange, x, y) {
  let focusRange = lookupBoundaryRangeFromPoint(x, y, "end");
  if (!anchorRange || !focusRange || !elements.reader.contains(focusRange.startContainer)) return null;
  if (anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) > 0) {
    focusRange = lookupBoundaryRangeFromPoint(x, y, "start");
    if (!focusRange || !elements.reader.contains(focusRange.startContainer)) return null;
  }
  const range = document.createRange();
  const before = anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) <= 0;
  range.setStart(before ? anchorRange.startContainer : focusRange.startContainer, before ? anchorRange.startOffset : focusRange.startOffset);
  range.setEnd(before ? focusRange.startContainer : anchorRange.startContainer, before ? focusRange.startOffset : anchorRange.startOffset);
  return range.collapsed ? null : range;
}

function usableLookupRange(range) {
  if (!range) return null;
  const term = lookupTermFromRange(range);
  if (!term || term.length > 18) return null;
  const expandedRange = expandLookupRangeRight(range);
  const expandedTerm = expandedRange === range ? term : lookupTermFromRange(expandedRange);
  if (expandedTerm && expandedTerm !== term && expandedTerm.length <= 18) {
    return {
      term: expandedTerm,
      rect: expandedRange.getBoundingClientRect(),
      preview: expandedRange,
      fallback: { term, rect: range.getBoundingClientRect(), preview: range }
    };
  }
  return { term, rect: range.getBoundingClientRect(), preview: range };
}

function setLookupPreview(preview) {
  clearLookupPreview();
  if (!preview) return;
  if (preview instanceof Range && window.CSS?.highlights && window.Highlight) {
    CSS.highlights.set("dictionary-lookup-preview", new Highlight(preview.cloneRange()));
    return;
  }
  if (preview instanceof Element) {
    lookupPreviewElement = preview;
    lookupPreviewElement.classList.add("lookup-preview-target");
  }
}

function clearLookupPreview() {
  window.CSS?.highlights?.delete("dictionary-lookup-preview");
  lookupPreviewElement?.classList.remove("lookup-preview-target");
  lookupPreviewElement = null;
}

function scheduleHoverLookup(term, rect, preview, fallback = null) {
  if (!term || term === hoverLookupLastTerm) return;
  hoverLookupLastTerm = term;
  setLookupPreview(preview);
  clearTimeout(hoverLookupTimer);
  hoverLookupTimer = setTimeout(() => showDictionaryLookup(term, rect, preview, fallback), 120);
}

function handleShiftHoverLookup(event) {
  if (!state.activeDocumentId || !event.shiftKey) return;
  if (event.target.closest?.("#dictionary-lookup")) return;
  const target = lookupTargetFromPoint(event.clientX, event.clientY);
  const fallback = target?.term ? {
    term: target.term,
    rect: target.rect,
    preview: target.preview,
    anchor: event.buttons === 1 ? null : lookupBoundaryRangeFromPoint(event.clientX, event.clientY, "start")
  } : null;
  const activeAnchor = event.buttons === 1 ? shiftLookupAnchorRange : shiftHoverAnchorRange;
  const dragRange = rangeBetweenPoints(activeAnchor, event.clientX, event.clientY);
  if (dragRange) {
    const lookupRange = usableLookupRange(dragRange);
    if (lookupRange) {
      const rangeFallback = lookupRange.fallback ?? fallback;
      const sameAsFallback = rangeFallback?.term === lookupRange.term;
      scheduleHoverLookup(lookupRange.term, lookupRange.rect, lookupRange.preview, sameAsFallback ? null : rangeFallback);
    }
    return;
  }
  if (target?.term) {
    if (event.buttons !== 1) shiftHoverAnchorRange = fallback?.anchor ?? lookupBoundaryRangeFromPoint(event.clientX, event.clientY, "start");
    scheduleHoverLookup(target.term, target.rect, target.preview);
  }
}

function renderDictionaryLookupLegacy(term, result) {
  const entries = result.entries ?? [];
  const frequencies = result.frequencies ?? [];
  if (entries.length === 0 && frequencies.length === 0) {
    elements.dictionaryLookup.innerHTML = `<p class="empty">No dictionary match for ${escapeHtml(term)}.</p>`;
    return;
  }
  const frequencyHtml = frequencies.length > 0
    ? `<div class="lookup-frequency">${frequencies.map((item) => `<span><b>${escapeHtml(item.dictionary)}</b> ${escapeHtml(item.displayValue)}</span>`).join("")}</div>`
    : "";
  const entriesHtml = entries.map((entry) => `
    <article class="lookup-entry">
      <div class="lookup-entry-head">
        <strong>${escapeHtml(entry.term)}</strong>
        <span>${escapeHtml(entry.reading ?? "")}</span>
      </div>
      <div class="lookup-source">${escapeHtml(entry.dictionary)}${entry.language ? ` · ${escapeHtml(entry.language)}` : ""}</div>
      ${entry.tags?.length ? `<div class="lookup-tags">${entry.tags.slice(0, 6).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <ol>${(entry.definitions ?? []).slice(0, 4).map((definition) => `<li>${escapeHtml(definition)}</li>`).join("")}</ol>
    </article>
  `).join("");
  elements.dictionaryLookup.innerHTML = `
    <div class="lookup-head">
      <strong>${escapeHtml(term)}</strong>
      <button type="button" aria-label="Close dictionary lookup">×</button>
    </div>
    ${frequencyHtml}
    ${entriesHtml}
  `;
  elements.dictionaryLookup.querySelector("button")?.addEventListener("click", hideDictionaryLookup);
}

function renderDictionaryLookup(term, result, preview = null) {
  const entries = groupLookupEntries(result.entries ?? []);
  const frequencies = result.frequencies ?? [];
  if (entries.length === 0 && frequencies.length === 0) {
    elements.dictionaryLookup.innerHTML = `<p class="empty">No dictionary match for ${escapeHtml(term)}.</p>`;
    return;
  }
  const primary = entries[0];
  const selectedTerm = String(term || "").trim();
  const selectedIsKana = /[\u3040-\u30ff]/u.test(selectedTerm) && !/[\u3400-\u9fff]/u.test(selectedTerm);
  const headerReading = selectedIsKana ? "" : primary?.readings?.[0] ?? "";
  const headerTerm = selectedTerm || primary?.term || "";
  const readability = result.readability ?? {};
  const frequencyHtml = frequencies.length > 0
    ? `<div class="lookup-frequency">${frequencies.map((item) => `<span><b>${escapeHtml(shortDictionaryName(item.dictionary))}</b> ${escapeHtml(item.displayValue)}</span>`).join("")}</div>`
    : "";
  const readabilityHtml = readability.status === "inferred-readable"
    ? `<div class="lookup-readability"><strong>Readable ${Number(readability.score ?? 0)}</strong><span>${escapeHtml((readability.reasons ?? []).join(", ") || "inferred readable")}</span></div>`
    : "";
  const knownTerm = result.knownTerm?.exists ? result.knownTerm.term : "";
  const hasAnkiNote = Boolean(result.knownTerm?.hasAnkiNote);
  const actionButton = hasAnkiNote
    ? `<button class="lookup-open-anki" type="button" aria-label="Open existing Anki flashcard" title="Open existing Anki flashcard" data-known-term="${escapeHtml(knownTerm)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5c2.7-.8 5.3-.5 8 1v12c-2.7-1.5-5.3-1.8-8-1V5.5Z"/><path d="M12 6.5c2.7-1.5 5.3-1.8 8-1v12c-2.7-.8-5.3-.5-8 1V6.5Z"/></svg>
      </button>`
    : `<button class="lookup-add-card" type="button" aria-label="Create Anki flashcard from lookup" title="Create Anki flashcard">+</button>`;
  const entriesHtml = entries.map((entry, index) => `
    <article class="lookup-entry">
      <div class="lookup-entry-index">${index + 1}.</div>
      <div class="lookup-entry-head">
        <span class="lookup-dictionary-label">${escapeHtml(entry.dictionary)}</span>
        ${entry.tags.includes("priority") || entry.tags.includes("★") ? `<span class="lookup-star">★</span>` : ""}
        ${entry.tags.filter((tag) => tag !== "★" && tag !== "priority").slice(0, 5).map((tag) => `<span class="lookup-tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
      <div class="lookup-entry-term">${escapeHtml(entry.readings.join(" / "))} <span>${escapeHtml(entry.term)}</span></div>
      <ul class="lookup-detail-list">${lookupDetailLines(entry).map((definition) => `<li>${escapeHtml(definition)}</li>`).join("")}</ul>
    </article>
  `).join("");
  elements.dictionaryLookup.innerHTML = `
    <div class="lookup-head">
      <div class="lookup-title">
        ${headerReading ? `<span>${escapeHtml(headerReading)}</span>` : ""}
        <strong>${escapeHtml(headerTerm)}</strong>
      </div>
      <div class="lookup-actions">
        ${actionButton}
        <button class="lookup-close" type="button" aria-label="Close dictionary lookup">&times;</button>
      </div>
    </div>
    ${frequencyHtml}
    ${readabilityHtml}
    ${entriesHtml}
  `;
  elements.dictionaryLookup.querySelector(".lookup-add-card")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await openAnkiPreview(lookupCardCandidate(term, entries[0], preview), null);
    } catch (error) {
      elements.dictionaryLookup.insertAdjacentHTML("beforeend", `<p class="empty">${escapeHtml(error.message)}</p>`);
    } finally {
      button.disabled = false;
    }
  });
  elements.dictionaryLookup.querySelector(".lookup-open-anki")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/api/anki/open-known-term", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: button.dataset.knownTerm || term })
      });
    } catch (error) {
      elements.dictionaryLookup.insertAdjacentHTML("beforeend", `<p class="empty">${escapeHtml(error.message)}</p>`);
    } finally {
      button.disabled = false;
    }
  });
  elements.dictionaryLookup.querySelector(".lookup-close")?.addEventListener("click", hideDictionaryLookup);
}

function lookupCardCandidate(term, entry, preview = null) {
  const definitions = entry?.definitions?.filter(Boolean) ?? [];
  const expression = entry?.term || term;
  const reading = entry?.readings?.[0] || entry?.reading || "";
  return {
    expression,
    surface: term,
    reading,
    dictionaryForm: expression,
    meaning: definitions.slice(0, 4).join("; "),
    sentence: lookupSentenceFromPreview(preview, term),
    source: state.activeDocumentTitle || "Reader lookup"
  };
}

function lookupSentenceFromPreview(preview, term = "") {
  const context = lookupContextText(preview);
  const compactTerm = sanitizeLookupText(term);
  if (!context) return compactTerm;
  const normalizedContext = context.replace(/\s+/g, "");
  const index = compactTerm ? normalizedContext.indexOf(compactTerm) : -1;
  if (index === -1) return context.split(/\n+/).find((line) => line.trim())?.trim() || context.trim();

  const sentenceBreaks = "。！？!?」\n";
  let start = index;
  while (start > 0 && !sentenceBreaks.includes(normalizedContext[start - 1])) start -= 1;
  let end = index + compactTerm.length;
  while (end < normalizedContext.length && !sentenceBreaks.includes(normalizedContext[end - 1])) end += 1;
  return normalizedContext.slice(start, end).trim() || compactTerm;
}

function lookupContextText(preview) {
  let container = null;
  if (preview?.startContainer) {
    const node = preview.startContainer.nodeType === Node.ELEMENT_NODE ? preview.startContainer : preview.startContainer.parentElement;
    container = node?.closest?.(".reader-page-content, .pdf-text-layer, .reader-page-frame");
  } else if (preview?.nodeType === Node.ELEMENT_NODE) {
    container = preview.closest?.(".reader-page-content, .pdf-text-layer, .reader-page-frame");
  }
  const clone = (container || elements.reader).cloneNode(true);
  clone.querySelectorAll?.("rt, rp, .reader-page-title, .reader-chapter-heading").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/[ \t]+/g, "").replace(/\n{3,}/g, "\n").trim();
}

function groupLookupEntries(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const definitions = [...new Set((entry.definitions ?? []).filter(Boolean))];
    const details = [...new Set((entry.details ?? []).filter(Boolean))];
    const key = [entry.dictionaryId, entry.term, definitions.map((definition) => definition.toLowerCase()).join("\u0000")].join("\u0001");
    if (!groups.has(key)) groups.set(key, { ...entry, definitions, details, readings: [], tags: [] });
    const group = groups.get(key);
    for (const detail of details) {
      if (!group.details.includes(detail)) group.details.push(detail);
    }
    if (entry.reading && !group.readings.includes(entry.reading)) group.readings.push(entry.reading);
    for (const tag of entry.tags ?? []) {
      if (tag && !group.tags.includes(tag)) group.tags.push(tag);
    }
  }
  return [...groups.values()].map((entry) => ({
    ...entry,
    readings: entry.readings.length > 0 ? entry.readings : [entry.reading].filter(Boolean)
  }));
}

function lookupDetailLines(entry = {}) {
  const details = (entry.details ?? []).filter(Boolean);
  if (details.length > 0) return details;
  return (entry.definitions ?? []).filter(Boolean);
}

function shortDictionaryName(name = "") {
  return String(name).replace(/\s*\[[^\]]+\]\s*/g, "").replace(/\.org$/i, "").trim() || name;
}

function positionLookupPopover(rect) {
  const width = Math.min(420, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - 120));
  elements.dictionaryLookup.style.width = `${width}px`;
  elements.dictionaryLookup.style.left = `${left}px`;
  elements.dictionaryLookup.style.top = `${top}px`;
}

function hideDictionaryLookup() {
  elements.dictionaryLookup.classList.add("hidden");
  elements.dictionaryLookup.innerHTML = "";
  hoverLookupLastTerm = "";
  clearTimeout(hoverLookupTimer);
  clearLookupPreview();
}

function unwrapHighlight(mark) {
  const parent = mark.parentNode;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  mark.remove();
  parent.normalize();
}

function undoHighlightChange() {
  const previous = state.highlightUndo.pop();
  if (!previous) return;
  state.highlightRedo.push(currentHighlightSnapshot());
  restoreHighlightSnapshot(previous);
  captureCurrentReaderHtml();
  saveProgress();
}

function redoHighlightChange() {
  const next = state.highlightRedo.pop();
  if (!next) return;
  state.highlightUndo.push(currentHighlightSnapshot());
  restoreHighlightSnapshot(next);
  captureCurrentReaderHtml();
  saveProgress();
}

async function refreshReaderPage() {
  if (!state.activeDocumentId || elements.refreshReader?.disabled) return;
  elements.refreshReader.disabled = true;
  try {
    hideDictionaryLookup();
    await refreshActiveDocumentForKnownTerms();
  } finally {
    elements.refreshReader.disabled = false;
  }
}

function bookmarkCurrentPage() {
  if (!state.activeDocumentId) return;
  captureCurrentReaderHtml();
  const bookmark = {
    page: state.currentPage,
    mode: state.readerMode,
    chapterId: state.activeChapterId,
    percentage: Number(elements.progressBar.value) || 0,
    createdAt: new Date().toISOString()
  };
  state.bookmarks = [bookmark, ...state.bookmarks.filter((item) => !(item.page === bookmark.page && item.mode === bookmark.mode))].slice(0, 50);
  renderBookmarks();
  setPanelTab("bookmarks");
  showBookmarkFeedback(`Page ${state.currentPage + 1} bookmarked`);
  saveProgress();
}

let bookmarkFeedbackTimer;
function showBookmarkFeedback(message) {
  elements.bookmarkFeedback.textContent = message;
  clearTimeout(bookmarkFeedbackTimer);
  bookmarkFeedbackTimer = setTimeout(() => {
    elements.bookmarkFeedback.textContent = "";
  }, 2200);
}

function transparentColor(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "rgba(246, 196, 83, 0.36)";
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.36)`;
}

async function uploadBook(file, title = "") {
  const formData = new FormData();
  formData.set("book", file);
  if (title) formData.set("title", title);
  return api("/api/documents", { method: "POST", body: formData });
}

async function importBooks(files, title = "") {
  const selectedFiles = [...files].filter(Boolean);
  if (selectedFiles.length === 0) return;
  const importedFromBooksPage = $("#books-page")?.classList.contains("active");
  const imported = [];
  let duplicates = 0;

  for (const [index, file] of selectedFiles.entries()) {
    try {
      const result = await uploadBook(file, selectedFiles.length === 1 ? title : "");
      imported.push(result.document);
    } catch (error) {
      if (error.message === "Duplicate copy") {
        duplicates += 1;
        continue;
      }
      throw error;
    }
  }

  await loadState();

  if (imported.length > 1) showLibraryNotice(`${imported.length} books successfully imported!`, "success");
  else if (imported.length === 1) showLibraryNotice(`${imported[0].title} successfully imported`, "success");
  else if (duplicates > 0) showLibraryNotice("Duplicate copy", "error");

  if (!importedFromBooksPage && imported.length > 0) {
    await openDocument(imported[0].id);
  }
}

function loadVoices() {
  state.voices = window.speechSynthesis.getVoices();
}

function bestJapaneseVoice(preferredName = "") {
  const voices = state.voices.length > 0 ? state.voices : window.speechSynthesis.getVoices();
  return voices.find((voice) => preferredName && voice.name === preferredName)
    || voices.find((voice) => voice.lang === "ja-JP" && /natural|nanami|haruka|google|microsoft/i.test(voice.name))
    || voices.find((voice) => voice.lang?.startsWith("ja"));
}

function playJapanese(text, options = {}) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = options.rate ?? 0.86;
  utterance.pitch = 0.98;
  const voice = bestJapaneseVoice(options.voiceName);
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

elements.navItems.forEach((item) => item.addEventListener("click", () => setPage(item.dataset.page)));
elements.pageLinks.forEach((item) => item.addEventListener("click", () => setPage(item.dataset.pageLink)));
elements.readerSidebarToggle?.addEventListener("click", () => {
  setSidebarHidden(!elements.shell.classList.contains("sidebar-hidden"), { readerMode: true });
});
elements.readerLibrary?.addEventListener("click", () => setPage("books-page"));
elements.readerAssistantForm?.addEventListener("submit", askReaderAssistant);
elements.readerAssistantQuestion?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  elements.readerAssistantForm?.requestSubmit();
});
elements.panelTabs.forEach((tab) => tab.addEventListener("click", () => setPanelTab(tab.dataset.panelTab)));
elements.readerSideTabs.forEach((tab) => tab.addEventListener("click", () => {
  state.readerSideTab = ["bookmarks", "search"].includes(tab.dataset.readerSideTab) ? tab.dataset.readerSideTab : "chapters";
  renderReaderSidePanel();
  if (state.readerSideTab === "search") requestAnimationFrame(() => elements.readerSideSearch?.querySelector("#reader-search-input")?.focus());
}));
elements.hideChapters.addEventListener("click", () => {
  setAssistantPanelHidden(true);
});
elements.showChapters.addEventListener("click", () => {
  setAssistantPanelHidden(false);
});
elements.readerAiToggle?.addEventListener("click", () => setAssistantPanelHidden(false));
elements.chapterResizeHandle?.addEventListener("pointerdown", startReaderSidebarResize);
elements.chapterResizeHandle?.addEventListener("keydown", nudgeReaderSidebarWidth);
elements.bookForm.addEventListener("change", async (event) => {
  if (event.target.name !== "book") return;
  const files = event.target.files;
  if (files?.length) await importBooks(files);
  elements.bookForm.reset();
});
elements.libraryBookForm.addEventListener("change", async (event) => {
  if (event.target.name !== "book") return;
  const files = event.target.files;
  if (files?.length) await importBooks(files);
  elements.libraryBookForm.reset();
});
elements.quickBookFile?.addEventListener("change", async () => {
  const files = elements.quickBookFile.files;
  if (files?.length) await importBooks(files);
  elements.quickBookFile.value = "";
});
elements.booksGrid?.addEventListener("wheel", (event) => {
  if (!$("#books-page")?.classList.contains("active")) return;
  event.preventDefault();
  setLibraryZoom(state.libraryZoom + (event.deltaY < 0 ? 12 : -12));
}, { passive: false });
elements.booksGrid?.addEventListener("dragover", updateBookDragTarget);
elements.booksGrid?.addEventListener("drop", dropBook);
elements.booksGrid?.addEventListener("dragleave", (event) => {
  if (!elements.booksGrid?.contains(event.relatedTarget)) clearLibraryDropHints();
});
elements.librarySearch?.addEventListener("input", () => {
  state.libraryQuery = elements.librarySearch.value;
  renderBooksGrid();
});
elements.reader.addEventListener("scroll", () => {
  if (state.readerMode !== "scroll" || !state.activeDocumentId) return;
  updatePagedFooter();
  saveProgress({ refreshLibrary: false, delay: 600 });
});
elements.modeScroll.addEventListener("click", () => setReaderMode("scroll"));
elements.modePaged.addEventListener("click", () => setReaderMode("paged"));
elements.readerZoom.addEventListener("input", () => setReaderZoom(elements.readerZoom.value));
elements.readerZoom.addEventListener("wheel", (event) => {
  event.preventDefault();
  setReaderZoom(state.readerZoom + (event.deltaY < 0 ? 5 : -5));
});
elements.toggleZoom.addEventListener("click", () => {
  document.body.classList.toggle("zoom-collapsed");
});
window.addEventListener("resize", () => {
  setReaderSidebarWidth(Number(localStorage.getItem("readerSideWidth")) || 280);
  refreshReaderFitSoon();
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && $("#reader-page")?.classList.contains("active")) {
    event.preventDefault();
    openReaderSearch();
  }
});
elements.pageJumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  jumpToPage(elements.pageJumpInput.value);
});
elements.pageJumpInput.addEventListener("change", () => jumpToPage(elements.pageJumpInput.value));
elements.prevPage.addEventListener("click", () => {
  turnPage(-1);
});
elements.nextPage.addEventListener("click", () => {
  turnPage(1);
});
function setReaderToolMode(mode) {
  state.highlightMode = mode;
  elements.selectTool.classList.toggle("active", mode === "select");
  elements.highlightTool.classList.toggle("active", mode === "highlight");
  elements.eraserTool.classList.toggle("active", mode === "erase");
}
elements.selectTool.addEventListener("click", () => {
  setReaderToolMode("select");
});
elements.highlightTool.addEventListener("click", () => {
  setReaderToolMode("highlight");
  highlightSelection();
});
elements.highlightColor.addEventListener("input", () => {
  state.highlightColor = elements.highlightColor.value;
});
elements.eraserTool.addEventListener("click", () => {
  setReaderToolMode(state.highlightMode === "erase" ? "select" : "erase");
});
elements.undoHighlight.addEventListener("click", undoHighlightChange);
elements.redoHighlight.addEventListener("click", redoHighlightChange);
elements.refreshReader?.addEventListener("click", refreshReaderPage);
elements.hideInferredFurigana?.addEventListener("change", async () => {
  const checked = Boolean(elements.hideInferredFurigana.checked);
  state.reader.hideInferredReadableFurigana = checked;
  try {
    const result = await api("/api/reader/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hideInferredReadableFurigana: checked })
    });
    state.reader = result.reader ?? state.reader;
    if (state.activeDocumentId) await refreshActiveDocumentForKnownTerms();
  } catch (error) {
    state.reader.hideInferredReadableFurigana = !checked;
    elements.hideInferredFurigana.checked = !checked;
    elements.bookmarkFeedback.textContent = error.message;
  }
});
elements.bookmarkPage.addEventListener("click", bookmarkCurrentPage);
elements.reader.addEventListener("mousedown", (event) => {
  if (!state.activeDocumentId || !event.shiftKey) return;
  shiftLookupAnchorRange = lookupBoundaryRangeFromPoint(event.clientX, event.clientY, "start");
  shiftHoverAnchorRange = null;
  if (shiftLookupAnchorRange && elements.reader.contains(shiftLookupAnchorRange.startContainer)) {
    event.preventDefault();
    handleShiftHoverLookup(event);
  } else {
    shiftLookupAnchorRange = null;
  }
});
elements.reader.addEventListener("mousemove", handleShiftHoverLookup);
elements.reader.addEventListener("mouseup", (event) => {
  shiftLookupAnchorRange = null;
  const selection = window.getSelection();
  if (event.shiftKey && selectionInsideReader(selection) && !selection.isCollapsed) {
    showDictionaryLookupFromSelection();
    return;
  }
  if (state.highlightMode === "highlight") highlightSelection();
  if (state.highlightMode === "erase") eraseHighlightsInSelection();
});
elements.reader.addEventListener("wheel", (event) => {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    setReaderZoom(state.readerZoom + (event.deltaY < 0 ? 5 : -5));
    return;
  }
  if (state.readerMode !== "scroll" || !state.activeDocumentId) return;
  const maxScroll = Math.max(0, elements.reader.scrollHeight - elements.reader.clientHeight);
  const atBottom = elements.reader.scrollTop >= maxScroll - 2;
  const atTop = elements.reader.scrollTop <= 2;
  if (event.deltaY > 0 && atBottom && state.currentPage < state.activePages.length - 1) {
    event.preventDefault();
    turnPage(1, { scrollTop: 0 });
  }
  if (event.deltaY < 0 && atTop && state.currentPage > 0) {
    event.preventDefault();
    turnPage(-1, { scrollTop: Number.MAX_SAFE_INTEGER });
  }
}, { passive: false });
elements.reader.addEventListener("click", (event) => {
  const epubLink = event.target.closest("[data-epub-href]");
  if (epubLink) {
    event.preventDefault();
    jumpToEpubHref(epubLink.dataset.epubHref);
    return;
  }
  if (state.highlightMode === "erase" && eraseHighlight(event.target)) event.preventDefault();
});
window.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) return;
  const selection = window.getSelection();
  if (event.key === "Shift" && selectionInsideReader(selection) && !selection.isCollapsed) {
    event.preventDefault();
    showDictionaryLookupFromSelection();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    turnPage(-1);
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    turnPage(1);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.key !== "Shift") return;
  shiftLookupAnchorRange = null;
  shiftHoverAnchorRange = null;
  hoverLookupLastTerm = "";
  clearTimeout(hoverLookupTimer);
  clearLookupPreview();
  const selection = window.getSelection();
  if (elements.dictionaryLookup.classList.contains("hidden") && selectionInsideReader(selection) && !selection.isCollapsed) {
    showDictionaryLookupFromSelection();
  }
});
elements.reader.addEventListener("mouseleave", () => {
  shiftLookupAnchorRange = null;
  shiftHoverAnchorRange = null;
  hoverLookupLastTerm = "";
  clearTimeout(hoverLookupTimer);
  clearLookupPreview();
});
document.addEventListener("mousedown", (event) => {
  if (!elements.dictionaryLookup.classList.contains("hidden") && !elements.dictionaryLookup.contains(event.target)) hideDictionaryLookup();
});
elements.reader.addEventListener("scroll", hideDictionaryLookup);
elements.trashDeleteSelected?.addEventListener("click", deleteSelectedTrashItems);
elements.trashDeleteAll?.addEventListener("click", deleteAllTrashItems);
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
elements.mediaSettingsForm?.addEventListener("submit", (event) => event.preventDefault());
elements.mediaImageEnabled?.addEventListener("change", queueSaveMediaSettings);
elements.testMediaImage?.addEventListener("click", () => testMedia());
elements.aiModelForm?.addEventListener("submit", importAiModel);
elements.stopAiRuntime?.addEventListener("click", stopAiRuntime);
elements.syncSaveSettings?.addEventListener("click", async () => {
  try {
    await saveSyncSettings();
  } catch (error) {
    renderSyncStatus(error.message);
  }
});
elements.syncSignIn?.addEventListener("click", async () => {
  try {
    await signInSync();
  } catch (error) {
    renderSyncStatus(error.message);
  }
});
elements.syncSignOut?.addEventListener("click", async () => {
  try {
    state.sync = await api("/api/sync/sign-out", { method: "POST" });
    renderSyncStatus("Signed out.");
  } catch (error) {
    renderSyncStatus(error.message);
  }
});
elements.syncPush?.addEventListener("click", () => runSyncAction("push", "Pushing local data"));
elements.syncPull?.addEventListener("click", () => runSyncAction("pull", "Pulling remote data"));
elements.syncNow?.addEventListener("click", () => runSyncAction("run", "Syncing"));
elements.cardForm?.addEventListener("submit", exportReviewedCard);
elements.cardCancel?.addEventListener("click", closeCardPreview);
elements.cardDialog?.addEventListener("click", (event) => {
  if (event.target === elements.cardDialog) closeCardPreview();
});
document.addEventListener("mouseover", (event) => {
  const target = event.target.closest?.(".help-dot[data-tooltip]");
  if (target) showFloatingTooltip(target);
});
document.addEventListener("focusin", (event) => {
  const target = event.target.closest?.(".help-dot[data-tooltip]");
  if (target) showFloatingTooltip(target);
});
document.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".help-dot[data-tooltip]")) hideFloatingTooltip();
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".help-dot[data-tooltip]")) hideFloatingTooltip();
});
window.addEventListener("scroll", hideFloatingTooltip, true);
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

function renderVocabularyStatus() {
  const stamp = state.anki?.lastVocabularySyncAt;
  elements.ankiVocabularyStatus.textContent = `${state.knownTermsCount.toLocaleString()} known words · Last synced: ${stamp ? formatDateTime(stamp) : "Never"}`;
}
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

function populateSelect(select, values, selectedValue, fallback) {
  select.innerHTML = `<option value="">${fallback}</option>`;
  for (const value of values ?? []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === selectedValue;
    select.append(option);
  }
}

function escapeHtml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function coverMarkup(item, className) {
  if (item.type === "pdf" && item.sourcePath) {
    return `<span class="${className} pdf-cover-render" data-pdf-src="${escapeHtml(item.sourcePath)}"><canvas aria-label=""></canvas></span>`;
  }
  if (item.coverPath) {
    return `<span class="${className}"><img src="${escapeHtml(item.coverPath)}" alt="" loading="lazy" draggable="false" /></span>`;
  }
  const initials = (item.title || item.filename || "?").trim().slice(0, 2).toUpperCase();
  return `<span class="${className} cover-fallback">${escapeHtml(initials)}</span>`;
}

function escapeCssIdent(value = "") {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function cssEscape(value = "") {
  return window.CSS?.escape ? window.CSS.escape(String(value)) : escapeCssIdent(value);
}

loadVoices();
initReaderSidebarResize();
window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
loadState().catch((error) => {
  elements.reader.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
