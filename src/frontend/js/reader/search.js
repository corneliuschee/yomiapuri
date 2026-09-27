// In-book search results, navigation, and matching-text highlights.
import { $, elements } from "../core/dom.js";
import { setSidebarHidden } from "../core/navigation.js";
import { state } from "../core/state.js";
import { captureCurrentReaderHtml } from "./highlights.js";
import { saveProgress } from "./navigation.js";
import { renderReader } from "./render.js";
import { renderReaderSidePanel } from "./sidebar.js";
import { escapeHtml } from "../shared/utils.js";

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

function bindReaderSearchEvents() {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && $("#reader-page")?.classList.contains("active")) {
      event.preventDefault();
      openReaderSearch();
    }
  });
}

export { applyReaderSearchHighlights, bindReaderSearchEvents, renderReaderSearchPanel, stripReaderSearchMarkup };
