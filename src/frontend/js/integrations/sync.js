// Supabase settings, sign-in, and user-triggered data synchronization.
import { api } from "../core/api.js";
import { elements } from "../core/dom.js";
import { loadState } from "../core/session.js";
import { state } from "../core/state.js";
import { formatDateTime } from "../shared/utils.js";

function renderSyncStatus(extra = "") {
  if (!elements.syncSummary) return;
  const sync = state.sync ?? {};
  if (elements.syncStatus) {
    elements.syncStatus.textContent = sync.signedIn ? "Connected" : sync.configured ? "Configured" : "Off";
  }
  if (elements.syncUrl) elements.syncUrl.value = sync.supabaseUrl ?? "";
  if (elements.syncAnonKey) elements.syncAnonKey.value = sync.hasAnonKey ? "********" : "";
  if (elements.syncDeviceName) elements.syncDeviceName.value = sync.deviceName ?? "";
  if (elements.syncEnabled) elements.syncEnabled.checked = Boolean(sync.enabled);
  const rows = [
    `Status: ${sync.status || "disabled"}`,
    `Signed in: ${sync.userEmail || "No"}`,
    `Device: ${sync.deviceName || "Local device"}`,
    `Last sync: ${sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Never"}`,
    sync.diagnostics ? `Book files: ${Number(sync.diagnostics.uploadableFiles ?? 0).toLocaleString()} uploadable / ${Number(sync.diagnostics.documents ?? 0).toLocaleString()} total${sync.diagnostics.missingFiles ? ` (${Number(sync.diagnostics.missingFiles).toLocaleString()} missing original files)` : ""}` : "",
    sync.diagnostics?.textIndexStale ? "Text search index: refresh needed after pull" : "",
    sync.lastError ? `Last error: ${sync.lastError}` : "",
    extra
  ].filter(Boolean);
  elements.syncSummary.textContent = rows.join("\n");
}

function syncSettingsPayload() {
  const anonKey = elements.syncAnonKey?.value?.trim() ?? "";
  return {
    supabaseUrl: elements.syncUrl?.value?.trim() ?? "",
    ...(anonKey && anonKey !== "********" ? { supabaseAnonKey: anonKey } : {}),
    deviceName: elements.syncDeviceName?.value?.trim() ?? "",
    enabled: Boolean(elements.syncEnabled?.checked)
  };
}

async function saveSyncSettings() {
  const result = await api("/api/sync/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(syncSettingsPayload())
  });
  state.sync = result;
  renderSyncStatus("Sync settings saved.");
}

async function signInSync() {
  await saveSyncSettings();
  const result = await api("/api/sync/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: elements.syncEmail?.value?.trim() ?? "",
      password: elements.syncPassword?.value ?? "",
      ...syncSettingsPayload()
    })
  });
  state.sync = result;
  if (elements.syncPassword) elements.syncPassword.value = "";
  renderSyncStatus("Signed in to Supabase.");
}

async function runSyncAction(action, label) {
  setSyncLoading(true, label);
  try {
    const result = await api(`/api/sync/${action}`, { method: "POST" });
    state.sync = result;
    if (action === "pull" || action === "run") await loadState();
    renderSyncStatus(syncResultSummary(result));
  } catch (error) {
    renderSyncStatus(error.message);
  } finally {
    setSyncLoading(false);
  }
}

function syncResultSummary(result = {}) {
  const payload = result.pushed ?? result.pulled;
  if (!payload) return "Sync complete.";
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${Number(value).toLocaleString()}`)
    .join(" | ");
}

function setSyncLoading(loading, label = "Syncing") {
  for (const button of [elements.syncSaveSettings, elements.syncSignIn, elements.syncSignOut, elements.syncPush, elements.syncPull, elements.syncNow]) {
    if (button) button.disabled = loading;
  }
  if (loading && elements.syncSummary) elements.syncSummary.textContent = `${label}...`;
}

function bindSyncEvents() {
  elements.syncSaveSettings?.addEventListener("click", async () => {
    try {
      await saveSyncSettings();
    } catch (error) {
      renderSyncStatus(error.message);
    }
  });
  elements.syncSignIn?.addEventListener("click", async () => {
    try {
      await signInSync();
    } catch (error) {
      renderSyncStatus(error.message);
    }
  });
  elements.syncSignOut?.addEventListener("click", async () => {
    try {
      state.sync = await api("/api/sync/sign-out", { method: "POST" });
      renderSyncStatus("Signed out.");
    } catch (error) {
      renderSyncStatus(error.message);
    }
  });
  elements.syncPush?.addEventListener("click", () => runSyncAction("push", "Pushing local data"));
  elements.syncPull?.addEventListener("click", () => runSyncAction("pull", "Pulling remote data"));
  elements.syncNow?.addEventListener("click", () => runSyncAction("run", "Syncing"));
}

export { bindSyncEvents, renderSyncStatus };
