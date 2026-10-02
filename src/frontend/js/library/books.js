// Book import, library rendering, ordering, renaming, and soft deletion.
import { api } from "../core/api.js";
import { $, elements } from "../core/dom.js";
import { loadState } from "../core/session.js";
import { state } from "../core/state.js";
import { openDocument } from "../reader/document.js";
import { updateReaderToolbar } from "../reader/navigation.js";
import { renderPdfCovers } from "../reader/pdf.js";
import { renderBookmarks, renderChapters } from "../reader/sidebar.js";
import { confirmAction, showLibraryNotice } from "../shared/ui.js";
import { coverMarkup, escapeHtml } from "../shared/utils.js";
import { finishMotion, reveal } from "../shared/motion.js";

let renderedBookIds = new Set();

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
  finishMotion(elements.booksGrid);
  const newBookIds = new Set(state.documents.filter((item) => !renderedBookIds.has(item.id)).map((item) => item.id));
  renderedBookIds = new Set(state.documents.map((item) => item.id));
  const newCovers = [];
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
    if (newBookIds.has(item.id)) newCovers.push(card.querySelector(".library-cover"));
  }
  renderPdfCovers(elements.booksGrid);
  reveal(newCovers.filter(Boolean), { stagger: 0.018 });
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

let draggedBookId = "";

let libraryDragOverId = "";

let libraryDragInsertAfter = false;

function confirmDeleteBook(item) {
  return confirmAction(`Delete "${item.title}" from the library?`, { title: "Delete book?", confirmText: "Delete" });
}

function startBookDrag(event, id) {
  finishMotion(elements.booksGrid);
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

function bindLibraryEvents() {
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
}

export { bindLibraryEvents, renderBooksGrid, renderDocuments };
