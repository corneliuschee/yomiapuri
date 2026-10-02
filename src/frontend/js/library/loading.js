// Initial library placeholders; normal refreshes leave existing books visible.
import { elements } from "../core/dom.js";

export function showLibraryLoading() {
  elements.booksGrid.setAttribute("aria-busy", "true");
  elements.booksGrid.setAttribute("aria-label", "Loading library");
  elements.booksGrid.innerHTML = Array.from({ length: 4 }, () => `
    <div class="library-book library-placeholder" aria-hidden="true">
      <span class="library-cover"></span><span class="placeholder-line"></span>
      <span class="placeholder-line short"></span>
    </div>`).join("");
}

export function finishLibraryLoading(error, retry) {
  elements.booksGrid.removeAttribute("aria-busy");
  elements.booksGrid.removeAttribute("aria-label");
  if (!elements.booksGrid.querySelector(".library-placeholder")) return;
  elements.booksGrid.replaceChildren();
  if (!error) return;
  const message = document.createElement("p");
  message.className = "empty";
  message.textContent = "Could not load the library.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Retry";
  button.addEventListener("click", retry);
  message.append(" ", button);
  elements.booksGrid.append(message);
}
