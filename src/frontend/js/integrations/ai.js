// Local AI model import, model selection, and runtime status.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { escapeHtml } from "../shared/utils.js";

async function loadAiProviders() {
  if (!elements.aiStatus && !elements.aiModelList) return;
  try {
    const result = await api("/api/ai/providers");
    state.aiProviders = result;
    state.ai = result.settings ?? state.ai;
    renderAiSettings(result);
    await refreshAiRuntimeStatus();
  } catch (error) {
    if (elements.aiStatus) elements.aiStatus.textContent = "Unavailable";
    if (elements.aiPreview) elements.aiPreview.textContent = error.message;
  }
}

function renderAiSettings(result = state.aiProviders) {
  const settings = result.settings ?? state.ai;
  const models = (result.models ?? settings.models ?? []).filter((model) => model.task === "translation");
  state.ai = settings;
  renderReaderAssistantModels(models, settings.translation?.modelId || "");
  renderAiModels(models);
  renderAiStatus(result);
}

function renderReaderAssistantModels(models = [], selectedModelId = "") {
  if (!elements.readerAssistantModel) return;
  const preferredId = "sugoi-14b-ultra-q4-k-m";
  const currentValue = elements.readerAssistantModel.value || selectedModelId || preferredId;
  elements.readerAssistantModel.innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join("");
  const nextValue = models.some((model) => model.id === currentValue)
    ? currentValue
    : models.some((model) => model.id === preferredId)
      ? preferredId
      : models[0]?.id || "";
  elements.readerAssistantModel.value = nextValue;
}

function renderAiStatus(result = state.aiProviders) {
  if (!elements.aiStatus) return;
  const status = result.status ?? {};
  const translation = status.translation ?? {};
  elements.aiStatus.textContent = translation.configured ? "Local" : "Setup needed";
  if (elements.aiPreview && !state.aiRuntime) {
    elements.aiPreview.textContent = translation.configured
      ? "Runtime: auto-starts on message"
      : "Runtime: setup needed";
  }
}

function renderAiModels(models = []) {
  if (!elements.aiModelList) return;
  if (models.length === 0) {
    elements.aiModelList.innerHTML = `<p class="empty compact-empty">No assistant models available.</p>`;
    return;
  }
  elements.aiModelList.innerHTML = models.map((model) => `
    <div class="voice-model-row">
      <div>
        <strong>${escapeHtml(model.name)}</strong>
        <span>${escapeHtml(model.status === "ready" ? "Ready - local runtime installed" : model.status === "imported" ? "Imported - runtime required" : model.status)}</span>
      </div>
      ${model.url ? `<a href="${escapeHtml(model.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
    </div>
  `).join("");
}

async function importAiModel(event) {
  event?.preventDefault();
  const url = elements.aiModelUrl?.value?.trim();
  if (!url) {
    elements.aiPreview.textContent = "Enter a Hugging Face model URL before importing.";
    return;
  }
  elements.importAiModel.disabled = true;
  try {
    const result = await api("/api/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, task: "translation" })
    });
    state.aiProviders = result;
    state.ai = result.settings;
    elements.aiModelUrl.value = "";
    renderAiSettings(result);
    elements.aiPreview.textContent = `${result.model.name} imported. Configure a local runtime before it can answer in the reader.`;
  } catch (error) {
    elements.aiPreview.textContent = error.message;
  } finally {
    elements.importAiModel.disabled = false;
  }
}

async function refreshAiRuntimeStatus() {
  if (!elements.aiPreview && !elements.stopAiRuntime) return;
  try {
    const runtime = await api("/api/ai/runtime");
    state.aiRuntime = runtime;
    renderAiRuntimeStatus(runtime);
  } catch (error) {
    if (elements.aiPreview) elements.aiPreview.textContent = `Runtime: ${error.message}`;
    if (elements.stopAiRuntime) elements.stopAiRuntime.disabled = true;
  }
}

function renderAiRuntimeStatus(runtime = state.aiRuntime) {
  if (!elements.aiPreview && !elements.stopAiRuntime) return;
  const running = Boolean(runtime?.running);
  const count = Number(runtime?.count || 0);
  const timeout = Number(runtime?.idleTimeoutSeconds || 0);
  const timeoutLabel = timeout > 0 ? `${Math.round(timeout / 60)} min idle timeout` : "no idle timeout";
  if (elements.aiPreview) {
    elements.aiPreview.textContent = running
      ? `Runtime: running (${count} model${count === 1 ? "" : "s"}, ${timeoutLabel})`
      : `Runtime: off (auto-starts on message, ${timeoutLabel})`;
  }
  if (elements.stopAiRuntime) elements.stopAiRuntime.disabled = !running;
}

async function stopAiRuntime() {
  if (!elements.stopAiRuntime) return;
  elements.stopAiRuntime.disabled = true;
  if (elements.aiPreview) elements.aiPreview.textContent = "Runtime: stopping...";
  try {
    const result = await api("/api/ai/runtime/stop", { method: "POST" });
    state.aiRuntime = result;
    renderAiRuntimeStatus(result);
  } catch (error) {
    if (elements.aiPreview) elements.aiPreview.textContent = `Runtime: ${error.message}`;
  }
}

function bindAiEvents() {
  elements.aiModelForm?.addEventListener("submit", importAiModel);
  elements.stopAiRuntime?.addEventListener("click", stopAiRuntime);
}

export { bindAiEvents, loadAiProviders };
