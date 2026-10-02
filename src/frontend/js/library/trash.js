// Deleted-book selection, restoration, and permanent deletion.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { loadState } from "../core/session.js";
import { state } from "../core/state.js";
import { renderPdfCovers } from "../reader/pdf.js";
import { confirmAction } from "../shared/ui.js";
import { coverMarkup, cssEscape, escapeHtml } from "../shared/utils.js";

function setTrashTab() {
  renderTrash();
}

function renderTrash() {
  if (!elements.trashBooks) return;
  const deletedDocumentIds = new Set((state.trash?.documents ?? []).map((document) => document.id));
  state.selectedTrashDocuments = new Set([...state.selectedTrashDocuments].filter((id) => deletedDocumentIds.has(id)));
  renderTrashBooks();
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
      <button class="book-select" type="button" aria-label="Select ${escapeHtml(item.title)}" aria-pressed="${state.selectedTrashDocuments.has(item.id)}"></button>
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

function formatDeletedAt(entry) {
  const value = typeof entry === "object" ? entry?.deletedAt : "";
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Deleted ${date.toLocaleDateString()}`;
}

function toggleTrashDocumentSelection(id) {
  if (state.selectedTrashDocuments.has(id)) state.selectedTrashDocuments.delete(id);
  else state.selectedTrashDocuments.add(id);
  const card = elements.trashBooks.querySelector(`[data-document-id="${cssEscape(id)}"]`);
  card?.classList.toggle("selected", state.selectedTrashDocuments.has(id));
  card?.querySelector(".book-select")?.setAttribute("aria-pressed", String(state.selectedTrashDocuments.has(id)));
  updateTrashActionButtons();
}

function updateTrashActionButtons() {
  const count = state.selectedTrashDocuments.size;
  elements.trashDeleteSelected?.classList.toggle("hidden", count === 0);
  if (elements.trashDeleteSelected) elements.trashDeleteSelected.textContent = count ? `Delete ${count}` : "Delete";
  elements.trashDeleteAll?.classList.toggle("hidden", count > 0 || !state.trash?.documents?.length);
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
  return deleteSelectedTrashDocuments();
}

async function deleteAllTrashItems() {
  const count = state.trash?.documents?.length ?? 0;
  if (!count) return;
  if (!(await confirmAction(`Permanently delete all ${count.toLocaleString()} deleted books? This cannot be undone.`, { title: "Delete all forever?", confirmText: "Delete all" }))) return;
  await api("/api/trash/documents", { method: "DELETE" });
  await loadState();
  renderTrash();
}

function compactPageNumbers(current, total) {
  const slots = 10;
  if (total <= slots) return [...Array.from({ length: total }, (_, index) => index + 1), ...Array.from({ length: slots - total }, () => "blank")];
  if (current <= 6) return [1, 2, 3, 4, 5, 6, 7, "gap", total - 1, total];
  if (current >= total - 5) return [1, 2, "gap", total - 6, total - 5, total - 4, total - 3, total - 2, total - 1, total];
  return [1, 2, "gap", current - 2, current - 1, current, current + 1, current + 2, "gap", total];
}

function bindTrashEvents() {
  elements.trashDeleteSelected?.addEventListener("click", deleteSelectedTrashItems);
  elements.trashDeleteAll?.addEventListener("click", deleteAllTrashItems);
}

export { bindTrashEvents, renderTrash };
