import fs from "node:fs/promises";
import path from "node:path";
import { createSqliteStateStore } from "../src/backend/sqlite-state-store.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, "data");
const dbPath = process.env.SQLITE_STATE_PATH ? path.resolve(process.env.SQLITE_STATE_PATH) : path.join(dataDir, "yomiapuri.sqlite");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dataDir, "exports");

const store = createSqliteStateStore({ dbPath });
const state = store.loadState();
if (!state) {
  console.error(`No SQLite state found at ${dbPath}`);
  process.exit(1);
}

await fs.mkdir(outDir, { recursive: true });
const { dictionaries, ...mainState } = state;
mainState.dictionaries = dictionaries.map(dictionaryPublicStorageRecord);

await fs.writeFile(path.join(outDir, "state.json"), JSON.stringify(mainState, null, 2), "utf8");
await fs.writeFile(path.join(outDir, "dictionaries.json"), JSON.stringify({ dictionaries }, null, 2), "utf8");
store.close();

console.log(`Exported SQLite state to ${outDir}`);

function dictionaryPublicStorageRecord(dictionary = {}) {
  const {
    termEntries,
    frequencyEntries,
    entries,
    terms,
    index,
    frequencyIndex,
    ...metadata
  } = dictionary;
  return metadata;
}
