// Image generation settings, provider status, and preview.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { state } from "../core/state.js";
import { loadModelFields } from "./anki.js";

let mediaSettingsSaveTimer = null;

async function loadMediaProviders() {
  if (!elements.mediaSettingsForm) return;
  try {
    const result = await api("/api/media/providers");
    state.mediaProviders = result;
    state.media = result.settings ?? state.media;
    renderMediaSettings(result);
  } catch (error) {
    if (elements.mediaStatus) elements.mediaStatus.textContent = "Unavailable";
    if (elements.mediaPreview) elements.mediaPreview.textContent = error.message;
  }
}

function renderMediaSettings(result = state.mediaProviders) {
  if (!elements.mediaSettingsForm) return;
  state.media = result.settings ?? state.media;
  elements.mediaImageEnabled.checked = Boolean(state.media.image?.enabled);
  renderMediaStatus(result);
}

function renderMediaStatus(result = state.mediaProviders) {
  if (!elements.mediaStatus || !elements.mediaPreview) return;
  const enabled = Boolean(state.media.image?.enabled);
  elements.mediaStatus.textContent = enabled ? "Local" : "Off";
  elements.mediaPreview.textContent = enabled ? "Local mnemonic images enabled." : "Local image generation is disabled.";
}

async function saveMediaSettings(event, { updateStatus = true } = {}) {
  event?.preventDefault();
  if (!elements.mediaSettingsForm) return;
  if (elements.saveMediaSettings) elements.saveMediaSettings.disabled = true;
  try {
    const result = await api("/api/media/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: {
          enabled: elements.mediaImageEnabled.checked,
          provider: "local-mnemonic"
        }
      })
    });
    state.mediaProviders = result.providers;
    state.media = result.settings;
    if (updateStatus) renderMediaStatus(result.providers);
    await loadModelFields();
  } catch (error) {
    elements.mediaPreview.textContent = error.message;
  } finally {
    if (elements.saveMediaSettings) elements.saveMediaSettings.disabled = false;
  }
}

function queueSaveMediaSettings() {
  clearTimeout(mediaSettingsSaveTimer);
  mediaSettingsSaveTimer = setTimeout(() => saveMediaSettings(), 260);
}

async function testMedia() {
  const button = elements.testMediaImage;
  button.disabled = true;
  elements.mediaPreview.textContent = "Generating image...";
  try {
    clearTimeout(mediaSettingsSaveTimer);
    await saveMediaSettings();
    const result = await api("/api/media/test-image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "\u56f3\u66f8\u9928", reading: "\u3068\u3057\u3087\u304b\u3093", meaning: "library" })
    });
    renderMediaTestResult(result);
  } catch (error) {
    elements.mediaPreview.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderMediaTestResult(result = {}) {
  const filename = mediaFilenameFromValue(result.value);
  if (!filename) {
    elements.mediaPreview.textContent = "No image generated. Enable local mnemonic image.";
    return;
  }
  elements.mediaPreview.innerHTML = `<img class="media-preview-image" src="/media/anki-media/${encodeURIComponent(filename)}" alt="Generated mnemonic preview">`;
}

function mediaFilenameFromValue(value = "") {
  const text = String(value ?? "");
  return text.match(/\[sound:([^\]]+)\]/i)?.[1] ?? text.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
}

function bindMediaEvents() {
  elements.mediaSettingsForm?.addEventListener("submit", (event) => event.preventDefault());
  elements.mediaImageEnabled?.addEventListener("change", queueSaveMediaSettings);
  elements.testMediaImage?.addEventListener("click", () => testMedia());
}

export { bindMediaEvents, loadMediaProviders };
