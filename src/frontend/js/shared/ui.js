// Notices and confirmation dialogs.
import { elements } from "../core/dom.js";
import { escapeHtml } from "./utils.js";
import { finishMotion, reveal } from "./motion.js";

let libraryNoticeTimer;

let ankiNoticeTimer;

let dictionaryNoticeTimer;

function showLibraryNotice(message, type = "success") {
  libraryNoticeTimer = showNotice(elements.libraryNotice, libraryNoticeTimer, message, type);
}

function showAnkiNotice(message, type = "success") {
  ankiNoticeTimer = showNotice(elements.ankiImportNotice, ankiNoticeTimer, message, type);
}

function showDictionaryNotice(message, type = "success") {
  dictionaryNoticeTimer = showNotice(elements.dictionaryNotice, dictionaryNoticeTimer, message, type);
}

function showNotice(target, timer, message, type = "success") {
  if (!target) return timer;
  clearTimeout(timer);
  const icon = type === "success" ? checkIcon() : "!";
  target.className = `${target.classList.contains("integration-notice") ? "library-notice integration-notice" : "library-notice"} ${type} visible`;
  target.innerHTML = `<span class="notice-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  return setTimeout(() => {
    target.classList.remove("visible");
    target.classList.add("fading");
    setTimeout(() => {
      target.className = target.classList.contains("integration-notice") ? "library-notice integration-notice" : "library-notice";
      target.innerHTML = "";
    }, 260);
  }, 5000);
}

function checkIcon() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5 6.4 11.5 2.5 7.7"/></svg>`;
}

function confirmAction(message, options = {}) {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = options.title ?? "Confirm action";
    elements.confirmMessage.textContent = message;
    elements.confirmDelete.textContent = options.confirmText ?? "Delete";
    elements.confirmDelete.classList.toggle("danger", options.variant !== "restore");
    elements.confirmDialog.classList.remove("hidden");
    reveal(elements.confirmDialog.querySelector(".confirm-dialog"));
    elements.confirmDelete.focus();

    const cleanup = (value) => {
      finishMotion(elements.confirmDialog);
      elements.confirmDialog.classList.add("hidden");
      elements.confirmCancel.removeEventListener("click", onCancel);
      elements.confirmDelete.removeEventListener("click", onDelete);
      elements.confirmDialog.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKeydown);
      resolve(value);
    };
    const onCancel = () => cleanup(false);
    const onDelete = () => cleanup(true);
    const onBackdrop = (event) => {
      if (event.target === elements.confirmDialog) cleanup(false);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") cleanup(false);
    };

    elements.confirmCancel.addEventListener("click", onCancel);
    elements.confirmDelete.addEventListener("click", onDelete);
    elements.confirmDialog.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKeydown);
  });
}

export {
  confirmAction,
  showAnkiNotice,
  showDictionaryNotice,
  showLibraryNotice,
};
