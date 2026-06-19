import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_RECENT_EVENTS = 2000;

export function createLearningEventLog({ eventsPath }) {
  let recentCache = null;

  async function ensureDir() {
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  }

  async function append(type, payload = {}) {
    await ensureDir();
    const event = {
      id: randomUUID(),
      type: String(type || "event"),
      payload,
      createdAt: new Date().toISOString()
    };
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    if (recentCache) {
      recentCache.push(event);
      if (recentCache.length > MAX_RECENT_EVENTS) recentCache = recentCache.slice(-MAX_RECENT_EVENTS);
    }
    return event;
  }

  async function recent(limit = 500) {
    const normalizedLimit = Math.max(1, Math.min(MAX_RECENT_EVENTS, Number(limit) || 500));
    if (!recentCache) recentCache = await readAll(MAX_RECENT_EVENTS);
    return recentCache.slice(-normalizedLimit);
  }

  async function readAll(limit = MAX_RECENT_EVENTS) {
    try {
      const raw = await fs.readFile(eventsPath, "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(1, Number(limit) || MAX_RECENT_EVENTS))
        .map((line) => JSON.parse(line))
        .filter((event) => event && typeof event === "object");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  return { append, recent, readAll };
}
