# Yomiアプリ

Yomiアプリ is a local-first Japanese reading app for EPUB, PDF, and text novels. It combines a reader, dictionary lookup, Anki export, Word Bank tracking, local search indexes, optional Supabase sync, and an optional local AI assistant.

The app is designed to keep the core reading workflow local. Book data, dictionaries, SQLite state, generated caches, vector indexes, and model files live on your machine. Supabase sync is optional and syncs source data only, not local model files or vector indexes.

## Features

- Import EPUB, PDF, and plain-text books.
- Read in paged or scroll-style reader modes.
- Preserve book images, covers, chapters, bookmarks, highlights, and reading progress.
- Add generated furigana for unknown vocabulary while preserving author-provided ruby/furigana.
- Detect learned vocabulary from the Word Bank, including common conjugated forms.
- Import vocabulary from Anki through AnkiConnect.
- Export mined sentences to Anki with note-type field detection and editable preview.
- Generate local Anki media fields, including local TTS audio and mnemonic images when configured.
- Import Yomitan/Jitendex-style term dictionaries and frequency dictionaries.
- Use in-reader dictionary lookup from enabled dictionaries.
- Maintain a Word Bank with dictionary-selected meanings, sorting, pagination, trash, and restore.
- Sync books, progress, highlights, bookmarks, Word Bank, cards, and settings through Supabase.
- Run local learning analytics in the Insights page.
- Use SQLite FTS5/BM25 for fast phrase and vocabulary search.
- Use LanceDB semantic vectors for local semantic search and RAG-style retrieval.
- Use a local llama.cpp assistant for translation, grammar explanation, recap, and reader questions.

## Tech Stack

- Node.js + Express
- Vanilla HTML/CSS/JavaScript frontend
- SQLite via `better-sqlite3`
- SQLite FTS5 for lexical search
- LanceDB for local vector search
- Kuromoji for Japanese tokenization
- AnkiConnect for Anki Desktop integration
- Supabase for optional cross-device sync
- llama.cpp for optional local LLM chat/translation
- Sentence Transformers for optional multilingual embeddings

## Requirements

- Node.js 24 or newer is recommended.
- npm
- Anki Desktop and the AnkiConnect add-on, if you want Anki import/export.
- Python 3.10+ only if you want real embedding models instead of the built-in hash fallback.
- A local llama.cpp server binary and GGUF model files only if you want the AI reader assistant.
- A Supabase project only if you want cross-device sync.

## Install

Clone the repository and install dependencies:

```powershell
git clone https://github.com/corneliuschee/yomiapuri.git
cd yomiapuri
npm install
```

Start the app:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

For a normal non-watch run:

```powershell
npm start
```

## Configuration

Create a local `.env` file from the example:

```powershell
Copy-Item .env.example .env
```

The `.env` file is ignored by Git. Use it for local model paths and runtime settings.

### Optional AI Assistant

The AI reader assistant is local-first. It expects a llama.cpp-compatible server runtime and local GGUF models. The example configuration uses Sugoi 14B Ultra Q4/Q3 GGUF paths:

```env
LLAMA_SERVER_PATH=D:\YomiApuriModels\llama-tools\...\llama-server.exe
SUGOI_Q4_MODEL_PATH=D:\YomiApuriModels\Sugoi-14B-Ultra-GGUF\Sugoi-14B-Ultra-Q4_K_M.gguf
SUGOI_Q3_MODEL_PATH=D:\YomiApuriModels\Sugoi-14B-Ultra-GGUF\Sugoi-14B-Ultra-Q3_K_M.gguf
LLAMA_GPU_LAYERS=24
LLAMA_IDLE_TIMEOUT_SECONDS=600
```

Recommended starting points:

- Windows RTX desktop: `LLAMA_GPU_LAYERS=24`
- 16 GB Apple Silicon Mac: `LLAMA_GPU_LAYERS=16`

The assistant starts only when needed and shuts down after the configured idle timeout.

### Optional Embeddings

The app can use `intfloat/multilingual-e5-small` through Sentence Transformers for semantic retrieval. If Python or the model runtime is unavailable, the app falls back to the built-in local hash embedding provider.

Install Python dependencies in your preferred environment if you want the real embedding model:

```powershell
python -m pip install sentence-transformers torch
```

Set the Python path in the app's Integrations/Insights settings if needed. Embedding model files are cached under ignored local data paths.

### Optional Supabase Sync

Supabase sync is optional. It syncs source data between devices, while local derived indexes are rebuilt per device.

1. Create a Supabase project.
2. Run the SQL migrations in `supabase/migrations/`.
3. In the app, open Integrations.
4. Enter your Supabase URL and publishable key.
5. Sign in.
6. Use `Push local data`, `Pull remote data`, or `Sync now`.

Do not commit Supabase keys in `.env` or source files.

## Anki Setup

1. Install Anki Desktop.
2. Install the AnkiConnect add-on.
3. Start Anki Desktop.
4. Open Integrations > Anki.
5. Click connect.
6. Select a deck and note type.
7. Save the deck and note type.
8. Import reviewed vocabulary or export mined cards.

The app can auto-launch Anki Desktop on Windows when configured. Export uses AnkiConnect so custom note types, fields, media, and note IDs are preserved.

## Dictionaries

The dictionary manager supports:

- Yomitan/Jitendex-style term dictionary ZIPs.
- Yomitan frequency dictionary ZIPs.
- Legacy JSON dictionaries with usable term/definition rows.

Dictionary roles:

- Enabled dictionaries appear in reader lookup.
- Frequency dictionaries appear as lookup badges and support future difficulty/readability features.
- The Word Bank dictionary selector controls which dictionary supplies Word Bank meanings.

## Local Search Indexes

The Insights page has two separate local index actions:

- `Refresh text search index`: fast SQLite FTS5/BM25 refresh. This does not run embeddings.
- `Update semantic vectors`: incremental LanceDB vector update. This embeds only missing or changed chunks.

Use text refresh after importing books or when exact search looks stale. Use semantic vector update when you want semantic search/RAG to include new book text.

Local index files are derived cache and are not synced to Supabase.

## Data Storage

Important local paths:

- `data/yomiapuri.sqlite`: local SQLite application store.
- `data/vector-index/`: LanceDB vectors, chunk sidecars, and vector cache.
- `data/document-cache/`: reader/document processing cache.
- `data/events.jsonl`: append-only local learning events.
- `data/media/`: generated Anki media.
- `data/book-files/`: local imported book files when available.

These paths are ignored by Git.

## Development

Run tests:

```powershell
npm test
```

Useful syntax checks:

```powershell
node --check public/app.js
node --check server/index.js
node --check server/ml-service.js
node --check server/fts-search-service.js
```

## Git Safety

The repository ignores local data, credentials, generated files, and model folders:

- `.env`
- `data/`
- `node_modules/`
- `.venv*`
- `*.log`

Before pushing, check:

```powershell
git status --short
git ls-files .env data
```

`git ls-files .env data` should return nothing.

## Notes

- SQLite is the canonical local store for app state.
- FTS and LanceDB are rebuildable local indexes.
- Supabase sync is optional and does not upload local vector indexes or model files.
- The app is still evolving; route modules and storage repositories are being progressively separated to keep future features easier to scale.
