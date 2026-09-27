// Book opening, streamed cache progress, page windows, and known-word updates.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { setPage } from "../core/navigation.js";
import { state } from "../core/state.js";
import { renderBooksGrid, renderDocuments } from "../library/books.js";
import { resetReaderAssistantHistory } from "./assistant.js";
import { normalizeHighlights, pruneEmptyHighlightPages } from "./highlights.js";
import { hideDictionaryLookup, rubySurfaceText } from "./lookup.js";
import { normalizeZoom, updateReaderToolbar } from "./navigation.js";
import { renderReader } from "./render.js";
import { renderBookmarks, renderChapters, setAssistantPanelHidden } from "./sidebar.js";
import { escapeHtml, normalizeTermForUi } from "../shared/utils.js";

let readerOpenRequestId = 0;

let readerIngestionAbortController = null;

const readerPageWindowRequests = new Map();

async function openDocument(id) {
  const openRequestId = ++readerOpenRequestId;
  readerIngestionAbortController?.abort();
  readerIngestionAbortController = new AbortController();
  const previousDocumentId = state.activeDocumentId;
  state.activeDocumentId = id;
  if (previousDocumentId !== id) resetReaderAssistantHistory();
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

function bindDocumentEvents() {
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
}

export { bindDocumentEvents, loadDocumentPagesAround, openDocument, refreshActiveDocumentForKnownTerms };
