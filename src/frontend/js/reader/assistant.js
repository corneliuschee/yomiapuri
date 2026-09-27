// Reader AI conversation, streaming responses, history, and timing.
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { selectionInsideReader } from "./highlights.js";
import { escapeHtml } from "../shared/utils.js";

let readerAssistantTimer = null;

let readerAssistantMessageId = 0;

let readerAssistantHistory = [];

function selectedReaderText() {
  const selection = window.getSelection();
  if (!selectionInsideReader(selection) || selection.isCollapsed) return "";
  const clone = selection.getRangeAt(0).cloneContents();
  clone.querySelectorAll?.("rt, rp").forEach((node) => node.remove());
  return (clone.textContent || selection.toString() || "").replace(/\s+/g, " ").trim();
}

function currentReaderPageText() {
  if (!elements.reader) return "";
  const frame = elements.reader.querySelector(".reader-page-frame") || elements.reader;
  const clone = frame.cloneNode(true);
  clone.querySelectorAll?.("rt, rp, .reader-page-title, .reader-chapter-heading, canvas, img, button").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function askReaderAssistant(event) {
  event.preventDefault();
  if (!state.activeDocumentId) {
    elements.readerAssistantAnswer.innerHTML = `<p class="empty">Open a book before using the assistant.</p>`;
    return;
  }
  const question = elements.readerAssistantQuestion?.value?.trim() || "";
  if (!question) {
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Type a message";
    elements.readerAssistantQuestion?.focus();
    return;
  }
  if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Message only";
  elements.readerAssistantSubmit.disabled = true;
  clearReaderAssistantEmpty();
  appendReaderAssistantMessage("user", question, "You");
  const pendingId = appendReaderAssistantMessage("assistant", "Thinking...", "Assistant", "0.0s");
  const startedAt = performance.now();
  startReaderAssistantTimer(pendingId, startedAt);
  elements.readerAssistantQuestion.value = "";
  try {
    const payload = {
      documentId: state.activeDocumentId,
      page: state.currentPage,
      question,
      modelId: elements.readerAssistantModel?.value || state.ai?.translation?.modelId || "",
      history: readerAssistantHistory.slice(-6)
    };
    let streamedAnswer = "";
    let result = null;
    await streamReaderAssistant(payload, {
      onDelta: (delta) => {
        streamedAnswer += delta;
        updateReaderAssistantMessageText(pendingId, streamedAnswer || "Thinking...");
      },
      onDone: (doneResult) => {
        result = doneResult;
      }
    });
    if (!result) result = { answer: streamedAnswer };
    if (!result.answer) result.answer = streamedAnswer;
    renderReaderAssistantAnswer(result, pendingId, elapsedLabel(startedAt));
    rememberReaderAssistantTurn(question, result.answer ?? "");
  } catch (error) {
    replaceReaderAssistantMessage(pendingId, "assistant", error.message, "Assistant", elapsedLabel(startedAt));
  } finally {
    stopReaderAssistantTimer();
    elements.readerAssistantSubmit.disabled = false;
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = "Message only";
    elements.readerAssistantQuestion?.focus();
  }
}

async function streamReaderAssistant(payload, handlers = {}) {
  const response = await fetch("/api/reader/assistant/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  if (!response.body) throw new Error("Assistant stream was not available.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) handleAssistantStreamBlock(block, handlers);
  }
  if (buffer.trim()) handleAssistantStreamBlock(buffer, handlers);
}

function handleAssistantStreamBlock(block = "", handlers = {}) {
  let eventName = "message";
  const data = [];
  for (const rawLine of String(block).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  const payload = JSON.parse(data.join("\n"));
  if (eventName === "delta") handlers.onDelta?.(payload.delta ?? "");
  else if (eventName === "done") handlers.onDone?.(payload);
  else if (eventName === "error") throw new Error(payload.error || "Assistant stream failed.");
  else if (eventName === "meta") handlers.onMeta?.(payload);
}

function clearReaderAssistantEmpty() {
  if (elements.readerAssistantAnswer?.querySelector(".empty")) {
    elements.readerAssistantAnswer.innerHTML = "";
  }
}

function appendReaderAssistantMessage(role, text, label, elapsed = "") {
  const id = `assistant-message-${readerAssistantMessageId += 1}`;
  elements.readerAssistantAnswer.insertAdjacentHTML("beforeend", readerAssistantMessageHtml({ id, role, text, label, elapsed }));
  scrollAssistantToBottom();
  return id;
}

function replaceReaderAssistantMessage(id, role, text, label, elapsed = "", extraHtml = "") {
  const node = document.getElementById(id);
  const html = readerAssistantMessageHtml({ id, role, text, label, elapsed, extraHtml });
  if (node) node.outerHTML = html;
  else elements.readerAssistantAnswer.insertAdjacentHTML("beforeend", html);
  scrollAssistantToBottom();
}

function updateReaderAssistantMessageText(id, text) {
  const node = document.querySelector(`#${CSS.escape(id)} .assistant-message-body`);
  if (!node) return;
  node.innerHTML = escapeHtml(text ?? "").replace(/\n/g, "<br>");
  scrollAssistantToBottom();
}

function readerAssistantMessageHtml({ id, role, text, label, elapsed = "", extraHtml = "" }) {
  return `
    <article id="${escapeHtml(id)}" class="assistant-message ${escapeHtml(role)}">
      <div class="assistant-message-meta">
        <span>${escapeHtml(label)}</span>
        ${elapsed ? `<span class="assistant-elapsed">${escapeHtml(elapsed)}</span>` : ""}
      </div>
      <div class="assistant-message-body">${escapeHtml(text ?? "").replace(/\n/g, "<br>")}</div>
      ${extraHtml}
    </article>
  `;
}

function startReaderAssistantTimer(messageId, startedAt) {
  stopReaderAssistantTimer();
  readerAssistantTimer = setInterval(() => {
    const node = document.querySelector(`#${CSS.escape(messageId)} .assistant-elapsed`);
    const label = elapsedLabel(startedAt);
    if (node) node.textContent = label;
    if (elements.readerAssistantContext) elements.readerAssistantContext.textContent = label;
  }, 100);
}

function stopReaderAssistantTimer() {
  if (readerAssistantTimer) clearInterval(readerAssistantTimer);
  readerAssistantTimer = null;
}

function elapsedLabel(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function scrollAssistantToBottom() {
  if (!elements.readerAssistantAnswer) return;
  elements.readerAssistantAnswer.scrollTop = elements.readerAssistantAnswer.scrollHeight;
}

function rememberReaderAssistantTurn(question = "", answer = "") {
  const next = [
    ...readerAssistantHistory,
    { role: "user", content: question },
    { role: "assistant", content: answer }
  ].filter((message) => message.content?.trim());
  readerAssistantHistory = next.slice(-6);
}

function renderReaderAssistantAnswer(result = {}, pendingId = "", elapsed = "") {
  const citations = result.citations ?? [];
  const extraHtml = `
    ${result.includeCitations && citations.length ? `
      <section class="assistant-citations">
        <h4>Local citations</h4>
        ${citationRows(citations)}
      </section>
    ` : ""}
  `;
  replaceReaderAssistantMessage(pendingId, "assistant", result.answer ?? "", "Assistant", elapsed, extraHtml);
}

function resetReaderAssistantHistory() {
  readerAssistantHistory = [];
}

function bindAssistantEvents() {
  elements.readerAssistantForm?.addEventListener("submit", askReaderAssistant);
  elements.readerAssistantQuestion?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    elements.readerAssistantForm?.requestSubmit();
  });
}

export { bindAssistantEvents, resetReaderAssistantHistory };
