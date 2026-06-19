import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const STARTUP_FAILURE_MESSAGE = "Could not start Anki Desktop or AnkiConnect did not become ready.";

export function detectAnkiExecutablePath(env = process.env, exists = existsSync) {
  const candidates = [
    env.ANKI_EXECUTABLE_PATH,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "Anki", "anki.exe") : "",
    env.ProgramFiles ? path.join(env.ProgramFiles, "Anki", "anki.exe") : "",
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "Anki", "anki.exe") : ""
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) ?? "";
}

export function createAnkiLauncher({
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  exists = existsSync,
  pollIntervalMs = 500,
  timeoutMs = 20000
} = {}) {
  let pendingLaunch = null;

  const waitForAnkiConnect = async (connectUrl) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await canReachAnkiConnect(fetchImpl, connectUrl)) return true;
      await delay(pollIntervalMs);
    }
    return false;
  };

  return {
    async ensureRunning(settings = {}) {
      if (!settings.autoLaunchAnki) return false;
      if (pendingLaunch) return pendingLaunch;

      pendingLaunch = (async () => {
        const executablePath = settings.ankiExecutablePath || detectAnkiExecutablePath(process.env, exists);
        if (!executablePath || !exists(executablePath)) throw new Error(STARTUP_FAILURE_MESSAGE);
        const child = spawnImpl(executablePath, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.unref?.();
        const ready = await waitForAnkiConnect(settings.connectUrl || "http://127.0.0.1:8765");
        if (!ready) throw new Error(STARTUP_FAILURE_MESSAGE);
        return true;
      })();

      try {
        return await pendingLaunch;
      } finally {
        pendingLaunch = null;
      }
    }
  };
}

async function canReachAnkiConnect(fetchImpl, connectUrl) {
  try {
    const response = await fetchImpl(connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "version", version: 6 })
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return !payload.error;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
