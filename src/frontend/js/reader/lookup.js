// Dictionary lookup, text selection, hover ranges, and vocabulary popovers.
import { openAnkiPreview } from "../anki/cards.js";
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { eraseHighlightsInSelection, highlightSelection, selectionInsideReader } from "./highlights.js";
import { turnPage } from "./navigation.js";
import { escapeHtml } from "../shared/utils.js";
import { finishMotion, reveal } from "../shared/motion.js";

let hoverLookupTimer;

let hoverLookupLastTerm = "";

let hoverLookupRequest = 0;

let shiftLookupAnchorRange = null;

let shiftHoverAnchorRange = null;

let lookupPreviewElement = null;

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
  const opening = elements.dictionaryLookup.classList.contains("hidden");
  const requestId = ++hoverLookupRequest;
  setLookupPreview(preview);
  elements.dictionaryLookup.classList.remove("hidden");
  elements.dictionaryLookup.innerHTML = `<p class="empty">Looking up ${escapeHtml(term)}...</p>`;
  positionLookupPopover(rect);
  if (opening) reveal(elements.dictionaryLookup);
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
  finishMotion(elements.dictionaryLookup);
  elements.dictionaryLookup.classList.add("hidden");
  elements.dictionaryLookup.innerHTML = "";
  hoverLookupLastTerm = "";
  clearTimeout(hoverLookupTimer);
  clearLookupPreview();
}

function bindLookupEvents() {
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
}

export { bindLookupEvents, hideDictionaryLookup, renderDictionaryLookup, rubySurfaceText };
