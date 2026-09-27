// Reader text highlights, saved markup, and undo/redo history.
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { saveProgress, updatePagedFooter } from "./navigation.js";
import { renderPdfPages } from "./pdf.js";
import { stripReaderSearchMarkup } from "./search.js";
import { renderBookmarks, renderChapters } from "./sidebar.js";
import { transparentColor } from "../shared/utils.js";

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

function setReaderToolMode(mode) {
  state.highlightMode = mode;
  elements.selectTool.classList.toggle("active", mode === "select");
  elements.highlightTool.classList.toggle("active", mode === "highlight");
  elements.eraserTool.classList.toggle("active", mode === "erase");
}

function bindHighlightEvents() {
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
}

export {
  bindHighlightEvents,
  captureCurrentReaderHtml,
  eraseHighlight,
  eraseHighlightsInSelection,
  highlightSelection,
  normalizeHighlights,
  pruneEmptyHighlightPages,
  savedPageHtml,
  selectionInsideReader,
};
