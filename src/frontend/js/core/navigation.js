// Main-page navigation and visibility of the reader sidebar.
import { elements } from "./dom.js";
import { state } from "./state.js";
import { renderTrash } from "../library/trash.js";
import { syncReaderModeButtons, updateReaderToolbar } from "../reader/navigation.js";
import { renderReaderSidePanel } from "../reader/sidebar.js";

function setPage(pageId) {
  elements.pages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  const activeNavPage = pageId === "reader-page" ? "books-page" : pageId;
  elements.navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === activeNavPage));
  elements.shell.classList.toggle("reader-sidebar-mode", pageId === "reader-page");
  setSidebarHidden(pageId === "reader-page", { readerMode: pageId === "reader-page" });
  updateReaderToolbar();
  renderReaderSidePanel();
  syncReaderModeButtons();
  elements.knownCount.classList.add("hidden");
  const labels = {
    "books-page": ["Books", "Library"],
    "reader-page": ["Reader", state.activeDocumentTitle || "Choose a book"],
    "trash-page": ["Trash", "Deleted items"],
    "integrations-page": ["Integrations", "Anki and dictionaries"]
  };
  elements.pageEyebrow.textContent = labels[pageId]?.[0] ?? "";
  elements.pageTitle.textContent = labels[pageId]?.[1] ?? "";
  if (pageId === "trash-page") renderTrash();
}

function setSidebarHidden(hidden, options = {}) {
  elements.shell.classList.toggle("sidebar-hidden", hidden);
  elements.sidebar.classList.toggle("collapsed", hidden);
  if (elements.readerSidebarToggle) {
    elements.readerSidebarToggle.classList.toggle("sidebar-toggle-left-open", hidden);
    elements.readerSidebarToggle.classList.toggle("sidebar-toggle-left-close", !hidden);
    elements.readerSidebarToggle.setAttribute("aria-pressed", String(!hidden));
    elements.readerSidebarToggle.title = hidden ? "Show sidebar" : "Hide sidebar";
    elements.readerSidebarToggle.setAttribute("aria-label", hidden ? "Show sidebar" : "Hide sidebar");
  }
}

function bindNavigationEvents() {
  elements.navItems.forEach((item) => item.addEventListener("click", () => setPage(item.dataset.page)));
  elements.pageLinks.forEach((item) => item.addEventListener("click", () => setPage(item.dataset.pageLink)));
  elements.readerSidebarToggle?.addEventListener("click", () => {
    setSidebarHidden(!elements.shell.classList.contains("sidebar-hidden"), { readerMode: true });
  });
  elements.readerLibrary?.addEventListener("click", () => setPage("books-page"));
}

export { bindNavigationEvents, setPage, setSidebarHidden };
