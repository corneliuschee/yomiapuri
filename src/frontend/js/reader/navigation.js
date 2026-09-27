// Reader paging, zoom, display modes, and debounced progress persistence.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { renderBooksGrid, renderDocuments } from "../library/books.js";
import { captureCurrentReaderHtml, eraseHighlight } from "./highlights.js";
import { renderReader } from "./render.js";
import { renderBookmarks, setReaderSidebarWidth } from "./sidebar.js";

function syncReaderModeButtons() {
  elements.modeScroll.classList.toggle("active", state.readerMode === "scroll");
  elements.modePaged.classList.toggle("active", state.readerMode === "paged");
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

function bindReaderNavigationEvents() {
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
}

export {
  applyReaderZoom,
  bindReaderNavigationEvents,
  jumpToPage,
  normalizeZoom,
  saveProgress,
  syncReaderModeButtons,
  turnPage,
  updatePagedFooter,
  updateReaderFitVars,
  updateReaderToolbar,
};
