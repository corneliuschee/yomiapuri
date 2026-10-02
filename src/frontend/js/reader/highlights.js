// Reader text highlights, saved markup, and undo/redo history.
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { saveProgress, updatePagedFooter } from "./navigation.js";
import { renderPdfPages } from "./pdf.js";
import { stripReaderSearchMarkup } from "./search.js";
import { renderBookmarks, renderChapters } from "./sidebar.js";
import { transparentColor } from "../shared/utils.js";

const paintedHighlights = new Set();
let highlightStyles;

// Paint only base text: selecting an entire ruby element also paints its reading.
function paintSavedHighlights() {
  if (!window.CSS?.highlights || !window.Highlight) return;
  for (const name of paintedHighlights) CSS.highlights.delete(name);
  paintedHighlights.clear();
  const groups = new Map();
  for (const mark of elements.reader.querySelectorAll(".reader-highlight")) {
    const id = mark.dataset.highlightId;
    const key = id || mark;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mark);
  }
  const rules = [];
  const bands = [];
  const runs = new Map();
  const textWalker = document.createTreeWalker(elements.reader, NodeFilter.SHOW_TEXT);
  let run = 0;
  let previousColor = null;
  while (textWalker.nextNode()) {
    const node = textWalker.currentNode;
    if (!node.nodeValue || node.parentElement.closest("rt, rp")) continue;
    const color = node.parentElement.closest(".reader-highlight")?.style.backgroundColor || null;
    if (!color || color !== previousColor) run += 1;
    if (color) runs.set(node, run);
    previousColor = color;
  }
  for (const marks of groups.values()) {
    const ranges = [];
    for (const mark of marks) {
      const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement.closest("rt, rp")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      });
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        ranges.push(range);
      }
    }
    const name = `saved-reader-highlight-${paintedHighlights.size}`;
    const color = marks[0].style.backgroundColor;
    if (!color) continue;
    if (!marks[0].closest(".pdf-text-layer")) {
      for (const range of ranges) {
        for (const rect of range.getClientRects()) {
          if (rect.width && rect.height) bands.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, color, run: runs.get(range.startContainer) });
        }
      }
      continue;
    }
    CSS.highlights.set(name, new Highlight(...ranges));
    paintedHighlights.add(name);
    rules.push(`::highlight(${name}) { background-color: ${color}; }`);
  }
  highlightStyles.textContent = rules.join("\n");
  paintHighlightBands(bands);
}

// Merge adjacent base-text rectangles, using their shared vertical area so ruby
// readings and font-weight differences cannot create steps in the painted band.
function paintHighlightBands(rects) {
  const lines = [];
  rects.sort((a, b) => a.left - b.left || a.top - b.top);
  for (const rect of rects) {
    const line = lines.find((item) => item.color === rect.color && item.run === rect.run
      && Math.min(item.bottom, rect.bottom) - Math.max(item.top, rect.top)
        > Math.min(item.bottom - item.top, rect.bottom - rect.top) * 0.5);
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.max(line.top, rect.top);
      line.bottom = Math.min(line.bottom, rect.bottom);
    } else lines.push({ ...rect });
  }
  const reader = elements.reader;
  for (const reading of reader.querySelectorAll("rt")) {
    const rect = reading.getBoundingClientRect();
    for (const line of lines) {
      if (rect.right > line.left && rect.left < line.right
        && rect.bottom > line.top && rect.bottom < (line.top + line.bottom) / 2) {
        line.top = rect.bottom;
      }
    }
  }
  const box = reader.getBoundingClientRect();
  reader.style.backgroundImage = lines.length
    ? lines.map((line) => `linear-gradient(${line.color}, ${line.color})`).join(",") : "none";
  reader.style.backgroundSize = lines.map((line) => `${line.right - line.left}px ${line.bottom - line.top}px`).join(",");
  reader.style.backgroundPosition = lines.map((line) => `${line.left - box.left + reader.scrollLeft}px ${line.top - box.top + reader.scrollTop}px`).join(",");
  reader.style.backgroundRepeat = "no-repeat";
  reader.style.backgroundOrigin = "border-box";
  reader.style.backgroundAttachment = "local";
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
  const id = crypto.randomUUID();
  for (const segment of segments.reverse()) wrapTextSegment(segment, id);
  selection.removeAllRanges();
  captureCurrentReaderHtml();
  saveProgress();
}

function textSegmentsInRange(range) {
  const walker = document.createTreeWalker(elements.reader, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".reader-highlight") || parent.closest("rt, rp")) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const segments = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (start < end) segments.push({ node, start, end });
  }
  return segments;
}

function wrapTextSegment({ node, start, end }, id) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const mark = document.createElement("span");
  mark.className = "reader-highlight";
  mark.dataset.highlightId = id;
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
  const id = mark.dataset.highlightId;
  const marks = id
    ? [...elements.reader.querySelectorAll(".reader-highlight")].filter((item) => item.dataset.highlightId === id)
    : [mark];
  for (const item of marks) unwrapHighlightSegment(item);
}

function unwrapHighlightSegment(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
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
  document.addEventListener("mouseup", (event) => {
    if (!elements.reader.contains(event.target) && !event.shiftKey && state.highlightMode === "highlight") {
      highlightSelection();
    }
  });
  if (window.CSS?.highlights && window.Highlight) {
    highlightStyles = document.createElement("style");
    document.head.append(highlightStyles);
    elements.reader.classList.add("native-saved-highlights");
    new MutationObserver(paintSavedHighlights).observe(elements.reader, {
      childList: true, subtree: true, characterData: true
    });
    new ResizeObserver(paintSavedHighlights).observe(elements.reader);
    document.fonts?.addEventListener("loadingdone", paintSavedHighlights);
    elements.reader.addEventListener("load", paintSavedHighlights, true);
    paintSavedHighlights();
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
