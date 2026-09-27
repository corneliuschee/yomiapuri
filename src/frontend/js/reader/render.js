// Render the active reader page and restore its display position.
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { loadDocumentPagesAround } from "./document.js";
import { savedPageHtml } from "./highlights.js";
import {
  applyReaderZoom,
  normalizeZoom,
  syncReaderModeButtons,
  updatePagedFooter,
  updateReaderFitVars,
} from "./navigation.js";
import { renderPdfPages } from "./pdf.js";
import { applyReaderSearchHighlights } from "./search.js";
import { renderChapters } from "./sidebar.js";
import { escapeHtml } from "../shared/utils.js";

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

export { renderReader };
