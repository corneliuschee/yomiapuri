const state = {
  documents: [],
  dictionaries: [],
  dictionarySettings: { prefixWildcardSearch: false },
  media: { audio: { enabled: false, provider: "local-system-tts", voiceName: "", rate: 0 }, image: { enabled: false, provider: "local-mnemonic" } },
  mediaProviders: { voices: [], status: null },
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
  activeCandidates: [],
  pageCandidates: {},
  candidateRequestId: 0,
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
  readerZoom: 100,
  libraryZoom: 140,
  libraryQuery: "",
  wordbankPage: 1,
  wordbankPageSize: 60,
  wordbankSort: "gojuon",
  wordbankCache: new Map(),
  selectedTerms: new Set(),
  trashTab: "books",
  selectedTrashDocuments: new Set(),
  selectedTrashTerms: new Set(),
  currentPage: 0,
  voices: [],
  ml: { analytics: null, indexStatus: null }
};

const $ = (selector) => document.querySelector(selector);
const pdfDocuments = new Map();
let hoverLookupTimer;
let hoverLookupLastTerm = "";
let hoverLookupRequest = 0;
let shiftLookupAnchorRange = null;
let shiftHoverAnchorRange = null;
let lookupPreviewElement = null;
let draggedDictionaryId = "";
let mediaSettingsSaveTimer = null;

const elements = {
  shell: $("#shell"),
  sidebar: $("#sidebar"),
  collapseSidebar: $("#collapse-sidebar"),
  showSidebar: $("#show-sidebar"),
  navItems: document.querySelectorAll(".nav-item"),
  pageLinks: document.querySelectorAll("[data-page-link]"),
  pages: document.querySelectorAll(".page"),
  settingsGrid: $("#settings-grid"),
  pageEyebrow: $("#page-eyebrow"),
  pageTitle: $("#page-title"),
  knownCount: $("#known-count"),
  bookForm: $("#book-form"),
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
  bookmarkPage: $("#bookmark-page"),
  bookmarkFeedback: $("#bookmark-feedback"),
  candidateList: $("#candidate-list"),
  candidateTemplate: $("#candidate-template"),
  wordbankSearch: $("#wordbank-search"),
  wordbankSort: $("#wordbank-sort"),
  wordbankSyncAnki: $("#wordbank-sync-anki"),
  wordbankDelete: $("#wordbank-delete"),
  wordbankDeleteAll: $("#wordbank-delete-all"),
  wordbankList: $("#wordbank-list"),
  wordbankPagination: $("#wordbank-pagination"),
  refreshInsights: $("#refresh-insights"),
  mlMetrics: $("#ml-metrics"),
  mlDocumentList: $("#ml-document-list"),
  mlRebuildIndex: $("#ml-rebuild-index"),
  mlIndexStatus: $("#ml-index-status"),
  semanticSearchForm: $("#semantic-search-form"),
  semanticSearchInput: $("#semantic-search-input"),
  semanticSearchResults: $("#semantic-search-results"),
  ragForm: $("#rag-form"),
  ragQuestion: $("#rag-question"),
  ragAnswer: $("#rag-answer"),
  trashBooksTab: $("#trash-books-tab"),
  trashWordsTab: $("#trash-words-tab"),
  trashRestoreWords: $("#trash-restore-words"),
  trashDeleteWords: $("#trash-delete-words"),
  trashDeleteAll: $("#trash-delete-all"),
  trashBooks: $("#trash-books"),
  trashWords: $("#trash-words"),
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
  deckSelect: $("#deck-select"),
  modelSelect: $("#model-select"),
  ankiFieldStatus: $("#anki-field-status"),
  retentionSummary: $("#retention-summary"),
  mediaSettingsForm: $("#media-settings-form"),
  voiceModelForm: $("#voice-model-form"),
  voiceModelUrl: $("#voice-model-url"),
  voiceModelList: $("#voice-model-list"),
  importVoiceModel: $("#import-voice-model"),
  mediaStatus: $("#media-status"),
  mediaAudioEnabled: $("#media-audio-enabled"),
  mediaVoiceSelect: $("#media-voice-select"),
  mediaTestText: $("#media-test-text"),
  mediaRate: $("#media-rate"),
  mediaImageEnabled: $("#media-image-enabled"),
  mediaPreview: $("#media-preview"),
  saveMediaSettings: $("#save-media-settings"),
  testMediaAudio: $("#test-media-audio"),
  testMediaImage: $("#test-media-image"),
  dictionaryForm: $("#dictionary-form"),
  dictionaryFile: $("#dictionary-file"),
  dictionaryAttachment: $("#dictionary-attachment"),
  dictionaryImportButton: $("#dictionary-import-button"),
  dictionaryNotice: $("#dictionary-notice"),
  dictionaryList: $("#dictionary-list"),
  wordbankDictionary: $("#wordbank-dictionary"),
  dictionaryPrefixToggle: $("#dictionary-prefix-toggle"),
  instantAnkiToggle: $("#instant-anki-toggle"),
  dictionaryLookup: $("#dictionary-lookup"),
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
  state.wordbankCache.clear();
  state.cards = snapshot.cards ?? [];
  state.progress = snapshot.progress ?? {};
  state.trash = snapshot.trash ?? { documents: [], knownTerms: [] };
  state.anki = snapshot.anki;
  state.media = snapshot.media ?? state.media;
  state.knownTermsCount = snapshot.knownTermsCount ?? 0;
  elements.knownCount.textContent = `${state.knownTermsCount.toLocaleString()} words`;
  elements.knownCount.classList.add("hidden");
  elements.ankiSettingsForm.connectUrl.value = state.anki?.connectUrl ?? "http://127.0.0.1:8765";
  syncAnkiLaunchControls();
  if (elements.instantAnkiToggle) elements.instantAnkiToggle.checked = Boolean(state.anki?.instantExport);
  renderDocuments();
  renderBooksGrid();
  renderDictionaries();
  renderAnkiSummary();
  await loadMediaProviders();
  updateAnkiConnectionUi(false);
  renderTrash();
}

function setPage(pageId) {
  elements.pages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  elements.navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === pageId));
  updateReaderToolbar();
  syncReaderModeButtons();
  elements.knownCount.classList.toggle("hidden", pageId !== "wordbank-page");
  const labels = {
    "books-page": ["Books", "Library"],
    "reader-page": ["Reader", state.activeDocumentTitle || "Choose a book"],
    "wordbank-page": ["Word Bank", "Imported vocabulary"],
    "insights-page": ["Insights", "Learning analytics"],
    "trash-page": ["Trash", "Deleted items"],
    "integrations-page": ["Integrations", "Anki and dictionaries"]
  };
  elements.pageEyebrow.textContent = labels[pageId]?.[0] ?? "";
  elements.pageTitle.textContent = labels[pageId]?.[1] ?? "";
  if (pageId === "wordbank-page") loadWordBank();
  if (pageId === "insights-page") loadInsights();
  if (pageId === "trash-page") renderTrash();
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
  const query = state.libraryQuery.trim().toLowerCase();
  const visibleDocuments = state.documents.filter((item) => {
    if (!query) return true;
    return [item.title, item.filename, item.type].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
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
    card.className = `library-book${item.id === state.activeDocumentId ? " active" : ""}`;
    card.draggable = true;
    card.dataset.documentId = item.id;
    card.innerHTML = `
      <button class="library-open" type="button">
        ${coverMarkup(item, "library-cover")}
        <strong>${escapeHtml(item.title)}</strong>
        <span>${Math.round(state.progress[item.id]?.percentage ?? 0)}% read - ${escapeHtml(item.type.toUpperCase())}</span>
      </button>
      <div class="library-actions">
        <button class="rename" type="button">Edit</button>
        <button class="delete" type="button">Delete</button>
      </div>
    `;
    card.querySelector(".library-open").addEventListener("click", () => openDocument(item.id));
    card.querySelector(".rename").addEventListener("click", () => startLibraryRename(card, item));
    card.querySelector(".delete").addEventListener("click", () => deleteDocument(item));
    card.addEventListener("dragstart", (event) => startBookDrag(event, item.id));
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => dropBook(event, item.id));
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
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
  event.currentTarget.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
}

async function dropBook(event, targetId) {
  event.preventDefault();
  const sourceId = draggedBookId || event.dataTransfer.getData("text/plain");
  draggedBookId = "";
  if (!sourceId || sourceId === targetId) return;
  const sourceIndex = state.documents.findIndex((item) => item.id === sourceId);
  const targetIndex = state.documents.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = state.documents.splice(sourceIndex, 1);
  state.documents.splice(targetIndex, 0, moved);
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
    state.activeCandidates = [];
    state.pageCandidates = {};
    state.highlights = { pages: {}, scrollHtml: "" };
    state.bookmarks = [];
    elements.reader.innerHTML = `<p class="empty">Import or select a book.</p>`;
    elements.candidateList.innerHTML = "";
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
  state.activeDocumentId = id;
  setPage("reader-page");
  renderDocuments();
  elements.reader.innerHTML = `<p class="empty">Loading book...</p>`;
  elements.candidateList.innerHTML = "";

  const documentData = await api(`/api/documents/${id}`);
  state.activeCandidates = documentData.candidates ?? [];
  state.pageCandidates = {};
  
  state.activeChapters = documentData.chapters ?? [];

  state.activePages = documentData.pages?.length ? documentData.pages : [{ chapterId: "chapter-1", html: documentData.html ?? "" }];
  state.activeHtml = documentData.html ?? "";
  state.activeChapterId = documentData.progress?.chapterId || state.activePages[0]?.chapterId || state.activeChapters[0]?.id || "";
  state.readerZoom = normalizeZoom(documentData.progress?.zoom ?? state.readerZoom);
  state.highlights = normalizeHighlights(documentData.progress?.highlights);
  pruneEmptyHighlightPages();
  state.bookmarks = Array.isArray(documentData.progress?.bookmarks) ? documentData.progress.bookmarks : [];
  state.highlightUndo = [];
  state.highlightRedo = [];
  state.activeDocumentTitle = documentData.title;
  elements.pageTitle.textContent = documentData.title;
  
  renderBooksGrid();
  renderChapters();
  renderBookmarks();
  updateReaderToolbar();
  renderReader(documentData.progress);
  renderCandidates();
}

async function refreshActiveDocumentForKnownTerms() {
  if (!state.activeDocumentId) return;
  hideDictionaryLookup();
  hoverLookupLastTerm = "";
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

async function loadDocumentCandidates(id, page = state.currentPage) {
  const key = String(page);
  if (state.pageCandidates[key]) {
    state.activeCandidates = state.pageCandidates[key];
    renderCandidates();
    return;
  }
  const requestId = ++state.candidateRequestId;
  elements.candidateList.innerHTML = `<p class="empty">Loading candidates for page ${page + 1}...</p>`;
  try {
    const documentData = await api(`/api/documents/${id}?candidates=1&page=${page}`);
    if (state.activeDocumentId !== id || state.currentPage !== page || requestId !== state.candidateRequestId) return;
    state.activeCandidates = documentData.candidates ?? [];
    state.pageCandidates[key] = state.activeCandidates;
    renderCandidates();
  } catch (error) {
    if (state.activeDocumentId === id && requestId === state.candidateRequestId) elements.candidateList.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
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
        max-height: none;
        object-fit: contain;
        max-width: none;
        width: calc(100% * var(--reader-zoom, 1));
      }
      #reader .reader-page-frame.image-only .book-image img {
        max-height: 100%;
        max-width: 100%;
        width: auto;
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
  elements.reader.innerHTML = savedPageHtml(state.currentPage) || page?.html || `<p class="empty">No page text.</p>`;
  elements.reader.classList.toggle("image-page", Boolean(elements.reader.querySelector(".reader-page-frame.image-only")));
  renderChapters();
  requestAnimationFrame(() => {
    if (state.readerMode === "scroll") {
      elements.reader.scrollTop = Math.max(0, Math.min(Number(progress.scrollTop) || 0, elements.reader.scrollHeight - elements.reader.clientHeight));
    } else {
      elements.reader.scrollTop = 0;
    }
    updatePagedFooter();
    renderPdfPages(elements.reader);
    loadDocumentCandidates(state.activeDocumentId, state.currentPage);
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
    return;
  }

  for (const chapter of state.activeChapters) {
    const button = document.createElement("button");
    button.className = `chapter-item${chapter.id === state.activeChapterId ? " active" : ""}`;
    button.type = "button";
    button.textContent = chapter.title;
    button.addEventListener("click", () => jumpToChapter(chapter.id));
    elements.chapterList.append(button);
  }
}

function renderBookmarks() {
  elements.bookmarkList.innerHTML = "";
  if (!state.activeDocumentId) {
    elements.bookmarkList.innerHTML = `<p class="empty">Open a book to show bookmarks.</p>`;
    return;
  }
  if (state.bookmarks.length === 0) {
    elements.bookmarkList.innerHTML = `<p class="empty">No bookmarks yet.</p>`;
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
}

function renderCandidates() {
  elements.candidateList.innerHTML = "";
  if (state.activeCandidates.length === 0) {
    elements.candidateList.innerHTML = `<p class="empty">No candidates yet.</p>`;
    return;
  }

  for (const candidate of state.activeCandidates.slice(0, 40)) {
    const node = elements.candidateTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".expression").textContent = candidate.expression;
    node.querySelector(".reading").textContent = candidate.reading;
    node.querySelector(".sentence").textContent = candidate.sentence || "No sentence context.";
    const definition = node.querySelector(".definition");
    definition.textContent = candidate.meaning || "No dictionary match. Import a dictionary to auto-fill meanings.";
    if (candidate.rankScore !== undefined) {
      const rank = document.createElement("div");
      rank.className = "candidate-rank";
      const badges = (candidate.rankBadges ?? []).slice(0, 4).map((badge) => `<span>${escapeHtml(badge)}</span>`).join("");
      const reasons = candidate.rankReasons
        ? `Coverage ${candidate.rankReasons.knownCoverage}% - Unknown ${candidate.rankReasons.uniqueUnknown} - Recurs ${candidate.rankReasons.recurrence}`
        : "";
      rank.innerHTML = `<strong>${Number(candidate.rankScore).toLocaleString()}</strong>${badges}<em>${escapeHtml(reasons)}</em>`;
      definition.after(rank);
    }
    const submitButton = node.querySelector(".candidate-actions button[type='submit']");
    if (submitButton) submitButton.textContent = state.anki?.instantExport ? "Export Anki" : "Preview Anki";
    node.querySelector(".speak").addEventListener("click", () => playJapanese(candidate.sentence || candidate.expression));
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(node);
      if (submitButton) submitButton.disabled = true;
      try {
        node.querySelector(".definition").textContent = state.anki?.instantExport ? "Exporting to Anki..." : node.querySelector(".definition").textContent;
        await openAnkiPreview({ ...candidate, meaning: formData.get("meaning") || candidate.meaning }, node);
      } catch (error) {
        node.querySelector(".definition").textContent = state.anki?.instantExport ? exportFailureMessage(error) : error.message;
      } finally {
        if (submitButton && node.isConnected) submitButton.disabled = false;
      }
    });
    elements.candidateList.append(node);
  }
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
    await loadModelFields();
    if (node) {
      await loadState();
      await refreshActiveDocumentForKnownTerms();
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
  state.wordbankCache.clear();
  if (elements.wordbankList.closest(".page.active")) await loadWordBank();
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
    await loadModelFields();
    if (exportedFromLookup) {
      await refreshStateMetadataOnly();
      await refreshLookupAfterAnkiExport({ expression: exportedCandidate?.expression }, exportedCandidate);
    } else {
      await loadState();
      await refreshActiveDocumentForKnownTerms();
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
  if (skipped.length > 0) return `Created Anki note. Uncached audio skipped: ${skipped.join(", ")}.`;
  return "Created Anki note.";
}

function exportFailureMessage(error) {
  const reason = String(error?.message || "Unknown error").trim();
  if (/fetch|failed to fetch|networkerror|load failed/i.test(reason)) {
    return "Export failed (AnkiConnect unreachable. Open Anki Desktop with AnkiConnect enabled, then try again.)";
  }
  return `Export failed (${reason || "Unknown error"})`;
}

async function loadWordBank() {
  const q = elements.wordbankSearch.value.trim();
  const limit = state.wordbankPageSize;
  const offset = (state.wordbankPage - 1) * limit;
  const sort = encodeURIComponent(state.wordbankSort);
  const dictionaryId = elements.wordbankDictionary?.value ?? "";
  const cacheKey = JSON.stringify({ q, limit, offset, sort: state.wordbankSort, dictionaryId });
  const result = state.wordbankCache.get(cacheKey) ?? await api(`/api/known-terms?limit=${limit}&offset=${offset}&sort=${sort}&q=${encodeURIComponent(q)}&dictionaryId=${encodeURIComponent(dictionaryId)}`);
  state.wordbankCache.set(cacheKey, result);
  if (state.wordbankCache.size > 40) state.wordbankCache.delete(state.wordbankCache.keys().next().value);
  elements.wordbankList.innerHTML = "";
  elements.wordbankPagination.innerHTML = "";

  if (result.terms.length === 0) {
    elements.wordbankList.innerHTML = `<p class="empty">No vocabulary imported yet.</p>`;
    updateWordbankDeleteButton();
    return;
  }

  for (const item of result.terms) {
    const entry = item.dictionaryEntries?.[0];
    const row = document.createElement("div");
    row.className = `word-row${state.selectedTerms.has(item.term) ? " selected" : ""}`;
    row.dataset.term = item.term;
    row.innerHTML = `
      <button class="word-select" type="button" aria-label="Select ${escapeHtml(item.term)}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5 6.4 11.5 2.5 7.7"/></svg>
      </button>
      <strong>${escapeHtml(item.term)}</strong>
      <span>${escapeHtml(entry?.reading ?? "")}</span>
      <p>${escapeHtml(entry?.definitions?.slice(0, 2).join("; ") ?? "")}</p>
    `;
    row.querySelector(".word-select").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWordSelection(item.term);
    });
    elements.wordbankList.append(row);
  }
  updateWordbankDeleteButton();
  renderWordbankPagination(result.total, result.limit);
}

function toggleWordSelection(term) {
  if (state.selectedTerms.has(term)) state.selectedTerms.delete(term);
  else state.selectedTerms.add(term);
  const row = elements.wordbankList.querySelector(`[data-term="${cssEscape(term)}"]`);
  row?.classList.toggle("selected", state.selectedTerms.has(term));
  updateWordbankDeleteButton();
}

function updateWordbankDeleteButton() {
  const selectedCount = state.selectedTerms.size;
  elements.wordbankDelete.classList.toggle("hidden", selectedCount === 0);
  elements.wordbankDelete.textContent = state.selectedTerms.size > 0 ? `Delete ${state.selectedTerms.size}` : "Delete";
  if (elements.wordbankDeleteAll) {
    elements.wordbankDeleteAll.classList.toggle("hidden", selectedCount > 0);
    elements.wordbankDeleteAll.disabled = state.knownTermsCount === 0;
  }
}

async function deleteSelectedTerms() {
  const terms = [...state.selectedTerms];
  if (terms.length === 0) return;
  const label = terms.length === 1 ? `Delete "${terms[0]}" from the Word Bank?` : `Delete ${terms.length} vocabulary items from the Word Bank?`;
  if (!(await confirmAction(label, { title: "Delete vocabulary?", confirmText: "Delete" }))) return;
  await api("/api/known-terms", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms })
  });
  state.selectedTerms.clear();
  state.wordbankPage = 1;
  await loadState();
  await loadWordBank();
  await refreshActiveDocumentForKnownTerms();
}

async function deleteAllTerms() {
  if (state.knownTermsCount === 0) return;
  const label = `Delete all ${state.knownTermsCount.toLocaleString()} vocabulary items from the Word Bank? They will move to Trash.`;
  if (!(await confirmAction(label, { title: "Delete all vocabulary?", confirmText: "Delete all" }))) return;
  await api("/api/known-terms", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true })
  });
  state.selectedTerms.clear();
  state.wordbankPage = 1;
  await loadState();
  await loadWordBank();
  await refreshActiveDocumentForKnownTerms();
}

async function syncWordBankWithAnki() {
  if (elements.wordbankSyncAnki) {
    elements.wordbankSyncAnki.disabled = true;
    elements.wordbankSyncAnki.textContent = "Syncing...";
  }
  try {
    const result = await api("/api/known-terms/sync-anki", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    state.selectedTerms.clear();
    state.wordbankPage = 1;
    await loadState();
    await loadWordBank();
    await refreshActiveDocumentForKnownTerms();
    const removed = Number(result.removed ?? 0);
    showAnkiNotice(removed > 0
      ? `${removed.toLocaleString()} vocabulary removed from Word Bank after Anki sync`
      : `Anki sync complete. ${Number(result.checked ?? 0).toLocaleString()} linked vocabulary checked`,
    "success");
  } catch (error) {
    showAnkiNotice(`Anki sync failed: ${error.message}`, "error");
  } finally {
    if (elements.wordbankSyncAnki) {
      elements.wordbankSyncAnki.disabled = false;
      elements.wordbankSyncAnki.textContent = "Sync Anki";
    }
  }
}

async function loadInsights() {
  if (!elements.mlMetrics) return;
  elements.mlMetrics.innerHTML = `<p class="empty">Loading analytics...</p>`;
  elements.mlDocumentList.innerHTML = "";
  try {
    const [analytics, indexStatus] = await Promise.all([
      api("/api/ml/analytics"),
      api("/api/ml/index/status")
    ]);
    state.ml.analytics = analytics;
    state.ml.indexStatus = indexStatus;
    renderInsights(analytics, indexStatus);
  } catch (error) {
    elements.mlMetrics.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderInsights(analytics, indexStatus) {
  const totals = analytics?.totals ?? {};
  const metrics = analytics?.metrics ?? {};
  elements.mlMetrics.innerHTML = `
    <div class="ml-metric"><strong>${Number(totals.documents ?? 0).toLocaleString()}</strong><span>Books <span class="help-dot" tabindex="0" data-tooltip="Total imported PDF, EPUB, and text documents currently in your library.">?</span></span></div>
    <div class="ml-metric"><strong>${Number(totals.knownTerms ?? 0).toLocaleString()}</strong><span>Known terms <span class="help-dot" tabindex="0" data-tooltip="Vocabulary currently in your Word Bank, including terms imported from Anki or added from lookup.">?</span></span></div>
    <div class="ml-metric"><strong>${Number(metrics.averageCoverage ?? 0)}%</strong><span>Average coverage <span class="help-dot" tabindex="0" data-tooltip="Estimated percentage of kanji vocabulary in imported books that already appears in your Word Bank. Higher means easier reading.">?</span></span></div>
    <div class="ml-metric"><strong>${Number(metrics.candidateAcceptanceRate ?? 0)}%</strong><span>Preview to export <span class="help-dot" tabindex="0" data-tooltip="How often sentence-mining card previews become actual Anki exports. This measures candidate usefulness over time.">?</span></span></div>
    <div class="ml-metric"><strong>${Number(metrics.lookupToWordBankRate ?? 0)}%</strong><span>Lookup to Word Bank <span class="help-dot" tabindex="0" data-tooltip="How often dictionary lookups become Word Bank additions. This is based on local lookup and add events.">?</span></span></div>
  `;
  renderMlIndexStatus(indexStatus);
  renderDocumentDifficulty(analytics?.documents ?? []);
}

function renderMlIndexStatus(status = {}) {
  if (!elements.mlIndexStatus) return;
  const ready = status.ready ? "Ready" : "Not built";
  const rebuilt = status.rebuiltAt ? new Date(status.rebuiltAt).toLocaleString() : "Never";
  elements.mlIndexStatus.innerHTML = `
    <strong>${escapeHtml(ready)}</strong>
    <span>${Number(status.chunks ?? 0).toLocaleString()} chunks - ${escapeHtml(status.provider ?? "lancedb")} - rebuilt ${escapeHtml(rebuilt)}</span>
  `;
}

function renderDocumentDifficulty(documents = []) {
  if (documents.length === 0) {
    elements.mlDocumentList.innerHTML = `<p class="empty">No imported books to analyze.</p>`;
    return;
  }
  elements.mlDocumentList.innerHTML = documents.map((doc) => `
    <button class="ml-document-row" type="button" data-document-id="${escapeHtml(doc.id)}">
      <strong>${escapeHtml(doc.title)}</strong>
      <span>${Number(doc.coverage ?? 0)}% coverage <span class="help-dot" tabindex="0" data-tooltip="Estimated share of this book's kanji vocabulary already covered by your Word Bank.">?</span></span>
      <span>${Number(doc.uniqueUnknown ?? 0).toLocaleString()} unknown <span class="help-dot" tabindex="0" data-tooltip="Unique unknown kanji vocabulary detected in the analyzed portion of this book. Proper names are excluded where the tokenizer identifies them.">?</span></span>
      <span>${escapeHtml(doc.difficulty ?? "")} <span class="help-dot" tabindex="0" data-tooltip="Comfortable is high coverage, Stretch is moderate coverage, and Hard means many unknown terms remain.">?</span></span>
    </button>
  `).join("");
  elements.mlDocumentList.querySelectorAll("[data-document-id]").forEach((button) => {
    button.addEventListener("click", () => openDocument(button.dataset.documentId));
  });
}

async function rebuildMlIndex() {
  if (!elements.mlRebuildIndex) return;
  elements.mlRebuildIndex.disabled = true;
  const original = elements.mlRebuildIndex.textContent;
  elements.mlRebuildIndex.textContent = "Rebuilding...";
  try {
    const status = await api("/api/ml/index/rebuild", { method: "POST" });
    state.ml.indexStatus = status;
    renderMlIndexStatus(status);
    await loadInsights();
  } catch (error) {
    elements.mlIndexStatus.textContent = error.message;
  } finally {
    elements.mlRebuildIndex.disabled = false;
    elements.mlRebuildIndex.textContent = original;
  }
}

async function runSemanticSearch(event) {
  event.preventDefault();
  const query = elements.semanticSearchInput.value.trim();
  if (!query) return;
  elements.semanticSearchResults.innerHTML = `<p class="empty">Searching...</p>`;
  try {
    const result = await api("/api/search/semantic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 8 })
    });
    renderMlResults(elements.semanticSearchResults, result.results ?? []);
  } catch (error) {
    elements.semanticSearchResults.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

async function askRag(event) {
  event.preventDefault();
  const question = elements.ragQuestion.value.trim();
  if (!question) return;
  elements.ragAnswer.innerHTML = `<p class="empty">Retrieving local evidence...</p>`;
  try {
    const result = await api("/api/rag/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });
    const citations = result.citations ?? [];
    elements.ragAnswer.innerHTML = `
      <div class="ml-answer">${escapeHtml(result.answer ?? "").replace(/\n/g, "<br>")}</div>
      ${citations.length ? `<div class="ml-citations">${citationRows(citations)}</div>` : ""}
    `;
  } catch (error) {
    elements.ragAnswer.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderMlResults(container, results = []) {
  if (results.length === 0) {
    container.innerHTML = `<p class="empty">No indexed matches. Rebuild the index after importing books.</p>`;
    return;
  }
  container.innerHTML = citationRows(results);
}

function citationRows(results = []) {
  return results.map((item) => `
    <article class="ml-result">
      <div>
        <strong>${escapeHtml(item.title || "Untitled")}</strong>
        <span>${escapeHtml(item.chapterTitle || "")}${item.page ? ` - page ${Number(item.page) + 1}` : ""}</span>
      </div>
      <p>${escapeHtml(item.text || "")}</p>
    </article>
  `).join("");
}

function setTrashTab(tabName) {
  state.trashTab = tabName === "words" ? "words" : "books";
  renderTrash();
}

function renderTrash() {
  if (!elements.trashBooks || !elements.trashWords) return;
  const deletedDocumentIds = new Set((state.trash?.documents ?? []).map((document) => document.id).filter(Boolean));
  state.selectedTrashDocuments = new Set([...state.selectedTrashDocuments].filter((id) => deletedDocumentIds.has(id)));
  const deletedTerms = new Set((state.trash?.knownTerms ?? []).map(trashTerm).filter(Boolean));
  state.selectedTrashTerms = new Set([...state.selectedTrashTerms].filter((term) => deletedTerms.has(term)));
  const showBooks = state.trashTab !== "words";
  elements.trashBooksTab?.classList.toggle("active", showBooks);
  elements.trashWordsTab?.classList.toggle("active", !showBooks);
  elements.trashBooks.classList.toggle("active", showBooks);
  elements.trashWords.classList.toggle("active", !showBooks);
  renderTrashBooks();
  renderTrashWords();
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

function renderTrashWords() {
  if (!elements.trashWords) return;
  elements.trashWords.innerHTML = "";
  const terms = state.trash?.knownTerms ?? [];
  if (terms.length === 0) {
    elements.trashWords.innerHTML = `<p class="empty trash-empty">No deleted words.</p>`;
    return;
  }

  for (const entry of terms) {
    const term = trashTerm(entry);
    if (!term) continue;
    const row = document.createElement("div");
    row.className = `word-row${state.selectedTrashTerms.has(term) ? " selected" : ""}`;
    row.dataset.term = term;
    row.innerHTML = `
      <button class="word-select" type="button" aria-label="Select ${escapeHtml(term)}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5 6.4 11.5 2.5 7.7"/></svg>
      </button>
      <strong>${escapeHtml(term)}</strong>
      <span>${escapeHtml(formatDeletedAt(entry))}</span>
      <p>Deleted vocabulary</p>
    `;
    row.querySelector(".word-select").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTrashWordSelection(term);
    });
    elements.trashWords.append(row);
  }
}

function trashTerm(entry) {
  return typeof entry === "string" ? entry : entry?.term ?? "";
}

function formatDeletedAt(entry) {
  const value = typeof entry === "object" ? entry?.deletedAt : "";
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Deleted ${date.toLocaleDateString()}`;
}

function toggleTrashWordSelection(term) {
  if (state.selectedTrashTerms.has(term)) state.selectedTrashTerms.delete(term);
  else state.selectedTrashTerms.add(term);
  const row = elements.trashWords.querySelector(`[data-term="${cssEscape(term)}"]`);
  row?.classList.toggle("selected", state.selectedTrashTerms.has(term));
  updateTrashActionButtons();
}

function toggleTrashDocumentSelection(id) {
  if (state.selectedTrashDocuments.has(id)) state.selectedTrashDocuments.delete(id);
  else state.selectedTrashDocuments.add(id);
  const card = elements.trashBooks.querySelector(`[data-document-id="${cssEscape(id)}"]`);
  card?.classList.toggle("selected", state.selectedTrashDocuments.has(id));
  updateTrashActionButtons();
}

function updateTrashActionButtons() {
  const showWords = state.trashTab === "words";
  const count = showWords ? state.selectedTrashTerms.size : state.selectedTrashDocuments.size;
  const booksCount = state.trash?.documents?.length ?? 0;
  const wordsCount = state.trash?.knownTerms?.length ?? 0;
  elements.trashRestoreWords?.classList.toggle("hidden", !showWords || count === 0);
  if (elements.trashRestoreWords) elements.trashRestoreWords.textContent = count > 0 ? `Restore ${count}` : "Restore";
  elements.trashDeleteWords?.classList.toggle("hidden", count === 0);
  if (elements.trashDeleteWords) elements.trashDeleteWords.textContent = count > 0 ? `Delete ${count}` : "Delete";
  elements.trashDeleteAll?.classList.toggle("hidden", count > 0 || (showWords ? wordsCount === 0 : booksCount === 0));
  if (elements.trashDeleteAll) elements.trashDeleteAll.textContent = showWords ? "Delete all words" : "Delete all books";
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

async function restoreSelectedTrashTerms() {
  const terms = [...state.selectedTrashTerms];
  if (terms.length === 0) return;
  const label = terms.length === 1 ? `Restore "${terms[0]}" to the Word Bank?` : `Restore ${terms.length} vocabulary items to the Word Bank?`;
  if (!(await confirmAction(label, { title: "Restore vocabulary?", confirmText: "Restore", variant: "restore" }))) return;
  await api("/api/trash/known-terms/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms })
  });
  state.selectedTrashTerms.clear();
  await loadState();
  setTrashTab("words");
}

async function deleteSelectedTrashTerms() {
  const terms = [...state.selectedTrashTerms];
  if (terms.length === 0) return;
  const label = terms.length === 1 ? `Permanently delete "${terms[0]}"?` : `Permanently delete ${terms.length} vocabulary items?`;
  if (!(await confirmAction(`${label} This cannot be undone.`, { title: "Delete forever?", confirmText: "Delete" }))) return;
  await api("/api/trash/known-terms", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms })
  });
  state.selectedTrashTerms.clear();
  await loadState();
  setTrashTab("words");
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
  return state.trashTab === "words" ? deleteSelectedTrashTerms() : deleteSelectedTrashDocuments();
}

async function deleteAllTrashItems() {
  const showWords = state.trashTab === "words";
  const count = showWords ? state.trash?.knownTerms?.length ?? 0 : state.trash?.documents?.length ?? 0;
  if (count === 0) return;
  const noun = showWords ? "deleted vocabulary items" : "deleted books";
  if (!(await confirmAction(`Permanently delete all ${count.toLocaleString()} ${noun}? This cannot be undone.`, { title: "Delete all forever?", confirmText: "Delete all" }))) return;
  if (showWords) {
    await api("/api/trash/known-terms", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true })
    });
    state.selectedTrashTerms.clear();
  } else {
    await api("/api/trash/documents", { method: "DELETE" });
  }
  await loadState();
  setTrashTab(showWords ? "words" : "books");
}

function renderWordbankPagination(total, limit) {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  state.wordbankPage = Math.max(1, Math.min(state.wordbankPage, pageCount));
  const pages = compactPageNumbers(state.wordbankPage, pageCount);
  for (const page of pages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `page-number${page === state.wordbankPage ? " active" : ""}${page === "blank" ? " blank" : ""}`;
    button.textContent = page === "gap" ? "..." : page === "blank" ? "" : String(page);
    button.disabled = page === "gap" || page === "blank" || page === state.wordbankPage;
    if (typeof page === "number" && page !== state.wordbankPage) {
      button.addEventListener("click", () => {
        state.wordbankPage = page;
        loadWordBank();
      });
    }
    elements.wordbankPagination.append(button);
  }
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
  const termDictionaries = state.dictionaries.filter((dictionary) => dictionary.type === "term");
  elements.wordbankDictionary.innerHTML = `<option value="">No dictionary selected</option>`;
  for (const dictionary of termDictionaries) {
    const option = document.createElement("option");
    option.value = dictionary.id;
    option.textContent = dictionary.name;
    option.selected = Boolean(dictionary.selectedForWordBank);
    elements.wordbankDictionary.append(option);
  }
  elements.wordbankDictionary.disabled = termDictionaries.length === 0;
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
      <label class="switch" title="Show this dictionary in reader lookup">
        <input data-dictionary-toggle="${escapeHtml(dictionary.id)}" type="checkbox"${dictionary.enabledForLookup ? " checked" : ""} />
        <span></span>
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
  if (options.clearCache !== false && (patch.selectedForWordBank || patch.enabledForLookup)) state.wordbankCache.clear();
  const result = await api(`/api/dictionaries/${encodeURIComponent(id)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  state.dictionaries = result.dictionaries ?? state.dictionaries;
  state.dictionarySettings = result.settings ?? state.dictionarySettings;
  if (options.render !== false) renderDictionaries();
  if (options.reloadWordBank !== false && elements.wordbankList.closest(".page.active")) loadWordBank();
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
      updateDictionarySettings(dictionary.id, { sortOrder: index }, { render: false, reloadWordBank: false })
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
    state.wordbankCache.clear();
    renderDictionaries();
    if (elements.wordbankList.closest(".page.active")) loadWordBank();
    showDictionaryNotice("Dictionary deleted", "success");
  } catch (error) {
    showDictionaryNotice(error.message, "error");
  }
}

function renderAnkiSummary() {
  if (!elements.retentionSummary) return;
  const stats = state.anki?.retentionStats;
  if (!stats) {
    elements.retentionSummary.textContent = "After connecting, choose an import preset and import reviewed vocabulary into the Word Bank.";
    return;
  }
  elements.retentionSummary.textContent = `${stats.importedTerms.toLocaleString()} terms imported from ${stats.cards.toLocaleString()} cards. Query: ${stats.query}`;
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
  elements.ankiImportForm?.classList.toggle("hidden", !connected);
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
    : "Import vocabulary from Anki";
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
  const media = result.media;
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
    <p>${escapeHtml(media?.audio?.label ?? "Audio provider not configured")} - ${escapeHtml(media?.image?.label ?? "Image provider not configured")}</p>
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
  const settings = result.settings ?? state.media;
  const voices = result.voices ?? [];
  const status = result.status ?? {};
  const voiceModels = result.voiceModels ?? status.voiceModels ?? settings.voiceModels ?? [];
  const japaneseModels = voiceModels.filter(isJapaneseVoiceModel);
  const japaneseVoices = voices.filter(isJapaneseSystemVoice);
  state.media = settings;
  elements.mediaAudioEnabled.checked = Boolean(settings.audio?.enabled);
  elements.mediaImageEnabled.checked = Boolean(settings.image?.enabled);
  elements.mediaRate.value = String(settings.audio?.rate ?? 0);
  const options = [
    `<option value="">No Japanese voice selected</option>`,
    ...japaneseModels.map((model) => `<option value="model:${escapeHtml(model.id)}">LiquidAI: ${escapeHtml(model.name)}</option>`),
    ...japaneseVoices.map((voice) => `<option value="voice:${escapeHtml(voice.name)}">Windows: ${escapeHtml(`${voice.name}${voice.culture ? ` (${voice.culture})` : ""}`)}</option>`)
  ].join("");
  elements.mediaVoiceSelect.innerHTML = options;
  const selectedValue = settings.audio?.voiceModelId
    ? `model:${settings.audio.voiceModelId}`
    : settings.audio?.voiceName
      ? `voice:${settings.audio.voiceName}`
      : "";
  const optionValues = Array.from(elements.mediaVoiceSelect.options).map((option) => option.value);
  elements.mediaVoiceSelect.value = optionValues.includes(selectedValue)
    ? selectedValue
    : "";
  renderMediaStatus(result);
  renderVoiceModels(japaneseModels);
}

function renderMediaStatus(result = state.mediaProviders) {
  if (!elements.mediaStatus || !elements.mediaPreview) return;
  const status = result.status ?? {};
  const audioLabel = status.audio?.label ?? "Audio provider not configured";
  const imageLabel = status.image?.label ?? "Image provider not configured";
  const anyConfigured = status.audio?.configured || status.image?.configured;
  const anyEnabled = status.audio?.enabled || status.image?.enabled;
  elements.mediaStatus.textContent = anyConfigured ? "Local" : anyEnabled ? "Setup needed" : "Off";
  elements.mediaPreview.textContent = `${audioLabel} - ${imageLabel}`;
}

function isJapaneseVoiceModel(model = {}) {
  const text = `${model.name ?? ""} ${model.url ?? ""} ${model.language ?? ""} ${model.locale ?? ""}`;
  return /\bja(?:panese)?\b|jp\b|jpn\b|\u65e5\u672c\u8a9e|nihongo/i.test(text);
}

function isJapaneseSystemVoice(voice = {}) {
  const culture = String(voice.culture ?? voice.lang ?? "").toLowerCase();
  const name = String(voice.name ?? "").toLowerCase();
  return culture.startsWith("ja") || /\bjapanese\b|\u65e5\u672c\u8a9e/.test(name);
}

function renderVoiceModels(models = []) {
  if (!elements.voiceModelList) return;
  if (models.length === 0) {
    elements.voiceModelList.innerHTML = `<p class="empty compact-empty">No imported Japanese voice models.</p>`;
    return;
  }
  elements.voiceModelList.innerHTML = models.map((model) => `
    <div class="voice-model-row">
      <div>
        <strong>${escapeHtml(model.name)}</strong>
        <span>${escapeHtml(model.status === "ready" ? "Ready - local runtime installed" : model.status === "imported" ? "Imported - runtime required" : model.status)}</span>
      </div>
      <a href="${escapeHtml(model.url)}" target="_blank" rel="noreferrer">Open</a>
    </div>
  `).join("");
}

async function saveMediaSettings(event, { updateStatus = true } = {}) {
  event?.preventDefault();
  if (!elements.mediaSettingsForm) return;
  if (elements.saveMediaSettings) elements.saveMediaSettings.disabled = true;
  const selectedVoice = selectedMediaVoice();
  const mediaRate = Number(elements.mediaRate.value) || 0;
  try {
    const result = await api("/api/media/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: {
          enabled: elements.mediaAudioEnabled.checked,
          provider: "local-system-tts",
          voiceName: selectedVoice.voiceName,
          voiceModelId: selectedVoice.voiceModelId,
          rate: mediaRate
        },
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

function selectedMediaVoice() {
  const value = elements.mediaVoiceSelect?.value ?? "";
  if (value.startsWith("model:")) return { voiceName: "", voiceModelId: value.slice("model:".length) };
  if (value.startsWith("voice:")) return { voiceName: value.slice("voice:".length), voiceModelId: "" };
  return { voiceName: "", voiceModelId: "" };
}

async function importVoiceModel(event) {
  event?.preventDefault();
  const url = elements.voiceModelUrl?.value?.trim();
  if (!url) {
    elements.mediaPreview.textContent = "Enter a Hugging Face model URL before importing.";
    return;
  }
  elements.importVoiceModel.disabled = true;
  try {
    const result = await api("/api/media/voice-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    state.mediaProviders = result.providers;
    state.media = result.settings;
    elements.voiceModelUrl.value = "";
    renderMediaSettings(result.providers);
    elements.mediaPreview.textContent = `${result.model.name} imported. Local liquid-audio runtime support is required before it can generate Anki audio.`;
  } catch (error) {
    elements.mediaPreview.textContent = error.message;
  } finally {
    elements.importVoiceModel.disabled = false;
  }
}

async function testMedia(kind) {
  if (kind === "audio" && !selectedMediaVoice().voiceName && !selectedMediaVoice().voiceModelId) {
    previewMediaSpeech();
    return;
  }
  const button = kind === "audio" ? elements.testMediaAudio : elements.testMediaImage;
  if (!button) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add("loading");
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${kind === "audio" ? "Testing voice" : "Generating image"}</span>`;
  const loadingMessage = kind === "audio"
    ? "Generating a cached sample with the selected app voice. LiquidAI can take a while for uncached text."
    : "Generating image.";
  setMediaPreviewStatus(loadingMessage, { preserveAudio: kind === "audio" });
  try {
    if (kind === "audio") {
      clearTimeout(mediaSettingsSaveTimer);
      await saveMediaSettings(null, { updateStatus: false });
      setMediaPreviewStatus(loadingMessage, { preserveAudio: true });
    }
    const result = await api(`/api/media/test-${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence: elements.mediaTestText?.value?.trim() || "\u56f3\u66f8\u9928\u3078\u884c\u304d\u307e\u3059\u3002",
        expression: "\u56f3\u66f8\u9928",
        reading: "\u3068\u3057\u3087\u304b\u3093",
        meaning: "library"
      })
    });
    await loadMediaProviders();
    renderMediaTestResult(kind, result);
  } catch (error) {
    setMediaPreviewStatus(error.message, { preserveAudio: kind === "audio" });
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
    button.textContent = originalLabel;
  }
}

function setMediaPreviewStatus(message, { preserveAudio = false } = {}) {
  if (!preserveAudio || !elements.mediaPreview.querySelector("audio")) {
    elements.mediaPreview.textContent = message;
    return;
  }
  let status = elements.mediaPreview.querySelector(".media-preview-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "media-preview-status";
    elements.mediaPreview.prepend(status);
  }
  status.textContent = message;
}

function previewMediaSpeech() {
  const text = elements.mediaTestText?.value?.trim() || "\u56f3\u66f8\u9928\u3078\u884c\u304d\u307e\u3059\u3002";
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    elements.mediaPreview.textContent = "This browser does not support instant speech preview.";
    return;
  }
  const rate = 0.86 + ((Number(elements.mediaRate?.value) || 0) * 0.06);
  playJapanese(text, { rate });
  elements.mediaPreview.textContent = "Reading through the browser because no app voice is selected. Select a Japanese voice to test the actual Anki export voice.";
}

function renderMediaTestResult(kind, result = {}) {
  const filename = mediaFilenameFromValue(result.value);
  if (!filename) {
    elements.mediaPreview.textContent = kind === "audio"
      ? "No audio generated. Enable local audio and install/select a voice."
      : "No image generated. Enable local mnemonic image.";
    return;
  }
  const src = `/media/anki-media/${encodeURIComponent(filename)}`;
  if (kind === "audio") {
    elements.mediaPreview.innerHTML = `<audio controls autoplay src="${src}"></audio>`;
    elements.mediaPreview.querySelector("audio")?.play?.().catch(() => {});
  } else {
    elements.mediaPreview.innerHTML = `<img class="media-preview-image" src="${src}" alt="Generated mnemonic preview">`;
  }
}

function mediaFilenameFromValue(value = "") {
  const text = String(value ?? "");
  return text.match(/\[sound:([^\]]+)\]/i)?.[1] ?? text.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
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

function applyReaderZoom() {
  const zoom = normalizeZoom(state.readerZoom);
  state.readerZoom = zoom;
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
  clone.querySelectorAll(".pdf-page-render").forEach((node) => {
    node.removeAttribute("data-rendered");
    node.removeAttribute("data-rendering");
  });
  return clone.innerHTML;
}

function sanitizeSnapshotHtml(html = "") {
  const template = document.createElement("template");
  template.innerHTML = html;
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
    const result = await api(`/api/dictionary/lookup?term=${encodeURIComponent(term)}${prefix}`);
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
  const frequencyHtml = frequencies.length > 0
    ? `<div class="lookup-frequency">${frequencies.map((item) => `<span><b>${escapeHtml(shortDictionaryName(item.dictionary))}</b> ${escapeHtml(item.displayValue)}</span>`).join("")}</div>`
    : "";
  const knownTerm = result.knownTerm?.exists ? result.knownTerm.term : "";
  const hasAnkiNote = Boolean(result.knownTerm?.hasAnkiNote);
  const wordBankTerm = primary?.term || selectedTerm;
  const bankButton = `
    <button class="lookup-add-wordbank${knownTerm ? " is-added" : ""}" type="button" aria-label="${knownTerm ? "Already in Word Bank" : "Add to Word Bank"}" title="${knownTerm ? "Already in Word Bank" : "Add to Word Bank"}" data-wordbank-term="${escapeHtml(wordBankTerm)}"${knownTerm ? " disabled" : ""}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16"/><path d="M6 10v8"/><path d="M10 10v8"/><path d="M14 10v8"/><path d="M18 10v8"/><path d="M3 18h18"/><path d="M12 4 3 8h18l-9-4Z"/></svg>
    </button>
  `;
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
        ${bankButton}
        ${actionButton}
        <button class="lookup-close" type="button" aria-label="Close dictionary lookup">&times;</button>
      </div>
    </div>
    ${frequencyHtml}
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
  elements.dictionaryLookup.querySelector(".lookup-add-wordbank:not(:disabled)")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const wordbankTerm = button.dataset.wordbankTerm || primary?.term || term;
    button.disabled = true;
    try {
      const result = await api("/api/known-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: wordbankTerm })
      });
      state.knownTermsCount = result.total ?? state.knownTermsCount;
      elements.knownCount.textContent = `${state.knownTermsCount.toLocaleString()} words`;
      state.wordbankCache.clear();
      if (elements.wordbankList.closest(".page.active")) await loadWordBank();
      button.classList.add("is-added");
      button.title = "Added to Word Bank";
      button.setAttribute("aria-label", "Added to Word Bank");
      await refreshActiveDocumentForKnownTerms();
    } catch (error) {
      elements.dictionaryLookup.insertAdjacentHTML("beforeend", `<p class="empty">${escapeHtml(error.message)}</p>`);
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
elements.refreshInsights?.addEventListener("click", loadInsights);
elements.mlRebuildIndex?.addEventListener("click", rebuildMlIndex);
elements.semanticSearchForm?.addEventListener("submit", runSemanticSearch);
elements.ragForm?.addEventListener("submit", askRag);
elements.panelTabs.forEach((tab) => tab.addEventListener("click", () => setPanelTab(tab.dataset.panelTab)));
elements.collapseSidebar.addEventListener("click", () => {
  elements.shell.classList.add("sidebar-hidden");
  elements.sidebar.classList.add("collapsed");
  elements.showSidebar.classList.remove("hidden");
});
elements.showSidebar.addEventListener("click", () => {
  elements.shell.classList.remove("sidebar-hidden");
  elements.sidebar.classList.remove("collapsed");
  elements.showSidebar.classList.add("hidden");
});
elements.hideChapters.addEventListener("click", () => {
  elements.readerLayout.classList.add("chapters-hidden");
  elements.showChapters.classList.remove("hidden");
});
elements.showChapters.addEventListener("click", () => {
  elements.readerLayout.classList.remove("chapters-hidden");
  elements.showChapters.classList.add("hidden");
});
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
elements.wordbankSearch.addEventListener("input", () => {
  state.wordbankPage = 1;
  state.selectedTerms.clear();
  loadWordBank();
});
elements.wordbankSort.addEventListener("change", () => {
  state.wordbankSort = elements.wordbankSort.value;
  state.wordbankPage = 1;
  state.selectedTerms.clear();
  loadWordBank();
});
elements.wordbankDelete.addEventListener("click", deleteSelectedTerms);
elements.wordbankSyncAnki?.addEventListener("click", syncWordBankWithAnki);
elements.wordbankDeleteAll?.addEventListener("click", deleteAllTerms);
elements.trashBooksTab?.addEventListener("click", () => setTrashTab("books"));
elements.trashWordsTab?.addEventListener("click", () => setTrashTab("words"));
elements.trashRestoreWords?.addEventListener("click", restoreSelectedTrashTerms);
elements.trashDeleteWords?.addEventListener("click", deleteSelectedTrashItems);
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
    populateSelect(elements.deckSelect, result.decks, "", "None");
    populateSelect(elements.modelSelect, result.models, "", "None");
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
elements.mediaAudioEnabled?.addEventListener("change", queueSaveMediaSettings);
elements.mediaVoiceSelect?.addEventListener("change", queueSaveMediaSettings);
elements.mediaRate?.addEventListener("input", queueSaveMediaSettings);
elements.mediaRate?.addEventListener("change", queueSaveMediaSettings);
elements.mediaImageEnabled?.addEventListener("change", queueSaveMediaSettings);
elements.voiceModelForm?.addEventListener("submit", importVoiceModel);
elements.testMediaAudio?.addEventListener("click", () => testMedia("audio"));
elements.testMediaImage?.addEventListener("click", () => testMedia("image"));
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
  const formData = new FormData(elements.ankiImportForm);
  const deckName = state.anki?.deckName || "";
  if (!deckName) {
    showAnkiNotice("Choose a deck before importing vocabulary.", "error");
    return;
  }
  setAnkiImportLoading(true);
  try {
    const result = await api("/api/anki/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: formData.get("preset"), deckName })
    });
    state.anki.retentionStats = result.retentionStats;
    const imported = result.retentionStats?.addedTerms ?? 0;
    await loadState();
    updateAnkiConnectionUi(true);
    showAnkiNotice(`${Number(imported).toLocaleString()} vocabulary imported from ${deckName}`, "success");
    await loadWordBank();
    renderAnkiSummary();
  } catch (error) {
    showAnkiNotice(error.message, "error");
  } finally {
    setAnkiImportLoading(false);
  }
});
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

elements.wordbankDictionary.addEventListener("change", async () => {
  const id = elements.wordbankDictionary.value;
  if (!id) return;
  const previousDictionaries = state.dictionaries.map((dictionary) => ({ ...dictionary }));
  state.dictionaries = state.dictionaries.map((dictionary) => ({
    ...dictionary,
    selectedForWordBank: dictionary.type === "term" && dictionary.id === id
  }));
  renderDictionaries();
  loadWordBank();
  try {
    await updateDictionarySettings(id, { selectedForWordBank: true }, { render: false, reloadWordBank: false, clearCache: false });
  } catch (error) {
    state.dictionaries = previousDictionaries;
    renderDictionaries();
    loadWordBank();
    showDictionaryNotice(error.message, "error");
  }
});

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
  if (state.activeCandidates.length > 0) renderCandidates();
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
    return `<span class="${className}"><img src="${escapeHtml(item.coverPath)}" alt="" loading="lazy" /></span>`;
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
window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
loadState().catch((error) => {
  elements.reader.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
