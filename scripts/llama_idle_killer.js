import fs from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
const pidFile = String(args["pid-file"] ?? "").trim();
const activityFile = String(args["activity-file"] ?? "").trim();
const timeoutSeconds = Math.max(1, Number(args["timeout-seconds"] ?? 600) || 600);

if (!pidFile || !activityFile) process.exit(0);

const initialPid = await readPid(pidFile);
if (!initialPid) process.exit(0);

while (true) {
  const remainingMs = await idleRemainingMs(activityFile, timeoutSeconds);
  if (remainingMs > 0) {
    await sleep(Math.min(remainingMs, timeoutSeconds * 1000));
    continue;
  }

  const currentPid = await readPid(pidFile);
  if (currentPid !== initialPid) process.exit(0);
  if (!isProcessAlive(currentPid)) process.exit(0);

  try {
    process.kill(currentPid);
  } catch {
    // Best-effort cleanup; the process may have exited naturally.
  }
  process.exit(0);
}

async function idleRemainingMs(filePath, seconds) {
  try {
    const stat = await fs.stat(filePath);
    const idleMs = Date.now() - stat.mtimeMs;
    return Math.max(0, seconds * 1000 - idleMs);
  } catch {
    return 0;
  }
}

async function readPid(filePath) {
  try {
    const value = Number(String(await fs.readFile(filePath, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    result[key.slice(2)] = values[index + 1] ?? "";
    index += 1;
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
