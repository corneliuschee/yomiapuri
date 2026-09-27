// Reader chapters, bookmarks, sidebar tabs, and assistant-panel sizing.
import { $, elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { captureCurrentReaderHtml } from "./highlights.js";
import { saveProgress } from "./navigation.js";
import { renderPdfCovers } from "./pdf.js";
import { renderReader } from "./render.js";
import { renderReaderSearchPanel } from "./search.js";
import { coverMarkup, escapeHtml } from "../shared/utils.js";

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

function bindReaderSidebarEvents() {
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
  elements.bookmarkPage.addEventListener("click", bookmarkCurrentPage);
}

export {
  bindReaderSidebarEvents,
  initReaderSidebarResize,
  renderBookmarks,
  renderChapters,
  renderReaderSidePanel,
  setAssistantPanelHidden,
  setReaderSidebarWidth,
};
