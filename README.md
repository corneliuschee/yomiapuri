# Yomiアプリ

A local-first Japanese novel reader with smart furigana, dictionary lookup, Anki vocabulary sync, Anki card generation, local text search, and optional local AI assistance.

## Features

- EPUB, PDF, and TXT import, covers, illustrations, and chapter navigation.
- Paged and scrolling reading, bookmarks, highlights, and saved progress.
- Generated furigana for unknown vocabulary; author-provided ruby stays intact.
- Sync reviewed Anki vocabulary into the internal SQLite database from Integrations; repeat syncs add newly learned words without duplicates.
- Yomitan term/frequency dictionaries and dictionary-aware conjugation lookup.
- Editable Anki card previews, field mapping, sentence highlighting, and images.
- Incremental SQLite FTS5/BM25 book search.
- Streaming local llama.cpp translation and grammar assistance, model selection, and idle shutdown.
- Optional, user-triggered Supabase sync of source data.


## Architecture

The backend is Python with FastAPI. No Node process or JavaScript service is called by the backend.

```text
run.py
src/
  backend/
    main.py              FastAPI application and service lifecycle
    config.py            Paths and settings defaults
    api/                 HTTP endpoints grouped by domain
    services/            Books, NLP, dictionaries, search, Anki, AI, media, sync
    storage/             SQLite persistence and schema
  frontend/
    index.html           Page shell, forms, and dialogs
    app.js               Startup and event registration
    js/                  Native JavaScript modules grouped by feature
    styles.css           Ordered stylesheet imports
    styles/              Component and responsive styles
    vendor/pdfjs/        Browser PDF renderer and license
tests/                   Python regression tests and API contract
scripts/                 Export utility and HTTP smoke test
```

SQLite remains the canonical local store, with WAL enabled. Dictionary definitions are fetched for matching entries rather than loaded wholesale at startup. Reader pages and token caches are stored locally in SQLite. Known-vocabulary changes update rendering without re-tokenizing the entire library.

Japanese tokenization uses **SudachiPy**, replacing Kuromoji. Token boundaries can differ from older versions. Text search uses deduplicated surfaces, base forms, and readings, with exact substring matches ranked first.

## Install

Use Python **3.12**. Anki, llama.cpp, and Supabase are optional integrations.

Windows PowerShell:

```powershell
git clone https://github.com/corneliuschee/yomiapuri.git
cd yomiapuri
py -3.12 -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r requirements.txt
.\.venv-backend\Scripts\python.exe run.py
```

macOS/Linux:

```sh
python3.12 -m venv .venv-backend
.venv-backend/bin/python -m pip install -r requirements.txt
.venv-backend/bin/python run.py
```

Open [localhost:3000](http://localhost:3000). The server binds to the local machine only.

For automatic backend reload, append `--reload`. Set `PORT` to use a different port, and `DATA_DIR` to use a separate library.

Node.js is **not required to run the app**. It is used only for the optional browser-facing smoke test. Existing `npm start` and `npm run dev` commands delegate to the Python launcher when Python is on PATH.

## Existing Data

The Python backend uses the existing `data/yomiapuri.sqlite` tables. On its first opening of an existing database, it creates a backup in `data/backups`. Stop the old server before starting this version.

Do not delete the SQLite database unless you deliberately want to reset your library. Old JSON token caches and search sidecars are no longer used by this backend. Refresh the text-search index after upgrading; Python-derived search tables are separate from the old index.

Imported source files, models, and existing media are not removed by the code migration. Reimport books or dictionaries only when you intend to replace their source data.

## Dictionaries and Furigana

Import term and frequency dictionary ZIPs under Integrations. Legacy JSON dictionaries are also supported. Enable dictionaries for reader lookup.

Known terms suppress generated furigana. Author-provided ruby is preserved independently. The inferred-readable setting uses conservative rules, not a trained model, and never adds vocabulary to the known-word database automatically.

## Anki

1. Install Anki Desktop and AnkiConnect.
2. Start Anki, or configure its executable path for automatic launch.
3. In Integrations, connect and choose a deck and note type.
4. Click **Sync Anki** to import reviewed vocabulary. Repeat after learning more cards. Existing known words stay stored locally.
5. Select reader vocabulary to preview a new card.
6. Review the mapped fields, then export.

Exports use a local journal and targeted SQLite writes. Reviewed fields are preserved, and vocabulary in sentence fields is highlighted. Local TTS generation has been removed; existing audio in reviewed card fields is preserved.

When the app automatically starts Anki, Anki's console diagnostics are saved in `data/logs/anki.log` (under `DATA_DIR` when configured). Compatibility warnings from Anki or its add-ons are separate from export errors, which still appear in the app. This logging applies the next time Anki is started by the app; an already-running Anki process keeps its current output destination.

## Local AI

Copy `.env.example` to `.env`, then configure the executable and model paths:

```env
LLAMA_SERVER_PATH=D:\YomiApuriModels\llama-server.exe
SUGOI_Q4_MODEL_PATH=D:\YomiApuriModels\model-q4.gguf
SUGOI_Q3_MODEL_PATH=D:\YomiApuriModels\model-q3.gguf
LLAMA_GPU_LAYERS=24
LLAMA_IDLE_TIMEOUT_SECONDS=600
```

FastAPI manages llama-server directly. The old `LOCAL_TRANSLATION_COMMAND` JavaScript launcher is no longer used. The default GPU layer count is 24 on Windows and 16 elsewhere when no override is supplied.

The model starts on demand, streams responses, and shuts down after the configured idle period. Switching models unloads an app-owned previous runtime. Chat history stays in the browser session rather than the database.

## Search

In-book search remains available in the reader sidebar. The local FTS5/BM25 service remains available through the API; unchanged books are skipped on refresh, and Trash books are excluded from results.

## Supabase

Run the migrations under `supabase/migrations` in your Supabase project, then configure its URL and publishable key in Integrations and sign in.

Sync transfers books and referenced source media, progress, annotations, Word Bank, cards, templates, settings, and learning events. It does not upload SQLite files, local dictionary contents, model files, or search indexes. Push merges remote records first. Deletion metadata prevents deleted records from being silently reintroduced.

Sync is user-triggered; merely starting the app does not upload your library. Credentials stay in local settings and are not included in the browser state response.

## Testing

Native backend tests use temporary databases and mocked external services:

```powershell
.\.venv-backend\Scripts\python.exe run.py test
```

For the HTTP smoke test, install Node.js 24 and then:

```sh
npm install
npm test
```

Tests cover reader reopening, author ruby, chapter navigation, dictionary lookup, Word Bank, progress, incremental search, trash, Anki exports, sync contracts, and the previous API route inventory. Live Anki, model quality, and a real Supabase project require separate integration checks.

Every Python module includes a docstring explaining its purpose.

## Local Files

- `data/yomiapuri.sqlite`: canonical records and derived caches.
- `data/media`: book assets and generated card media.
- `data/backups`: pre-migration SQLite backups.
- `data/llama`: local model runtime logs.
- `.venv-backend`: Python application environment.
- `.env`: private local configuration.

These are ignored by Git. To explicitly export local records to JSON, run `python run.py export`. Exports contain private settings and must not be committed or shared publicly.
