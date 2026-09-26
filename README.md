# Yomiアプリ

Yomiアプリ is a local-first Japanese reading application for EPUB, PDF, and plain-text novels. It combines a paged or scrolling reader with dictionary lookup, furigana, Word Bank tracking, Anki export, local search, learning analytics, optional Supabase sync, and an optional local AI assistant.

The core reading workflow runs on the local machine. SQLite is the canonical local store for application data. SQLite FTS5 with BM25 ranking is the derived text-search index for exact Japanese phrases and vocabulary.

## Features

- Import EPUB, PDF, and plain-text books.
- Read in paged or scrolling modes.
- Preserve covers, illustrations, chapters, bookmarks, highlights, and reading progress.
- Preserve author-provided ruby/furigana and add generated furigana for other vocabulary.
- Recognize learned vocabulary and common conjugated forms.
- Import reviewed vocabulary from Anki through AnkiConnect.
- Preview and export notes to Anki with automatic field detection and editable fields.
- Generate local Anki media, including system TTS audio and mnemonic images when configured.
- Import Yomitan/Jitendex-style term dictionaries and frequency dictionaries.
- Look up selected or hovered Japanese vocabulary in enabled dictionaries.
- Maintain a paginated, searchable Word Bank with dictionary-selected meanings, trash, and restore.
- Track local reading and learning analytics in Insights.
- Search book text with SQLite FTS5 and BM25.
- Use a local llama.cpp assistant for translation, grammar explanation, recap, and reader questions.
- Optionally sync books, progress, annotations, Word Bank, cards, and settings through Supabase.

## Architecture

- Node.js and Express provide the local server.
- Vanilla HTML, CSS, and JavaScript provide the frontend.
- SQLite, through better-sqlite3, stores application state and the local FTS5 index.
- Kuromoji provides Japanese tokenization for reader rendering and text-search normalization.
- AnkiConnect connects the app to Anki Desktop.
- llama.cpp runs the optional local assistant with local GGUF models.
- Supabase provides optional cross-device synchronization of source data.

The reader and local search continue to work without Anki, Supabase, or the local AI runtime.

## Requirements

- Node.js 24 or newer is recommended.
- npm.
- Anki Desktop and the AnkiConnect add-on for Anki import/export.
- A local llama.cpp server binary and GGUF model files for the AI assistant.
- A Supabase project only for cross-device synchronization.

## Install

Clone the repository and install dependencies:

~~~powershell
git clone https://github.com/corneliuschee/yomiapuri.git
cd yomiapuri
npm install
~~~

Start the development server:

~~~powershell
npm run dev
~~~

Open http://localhost:3000 in a browser.

For a normal non-watch run:

~~~powershell
npm start
~~~

## Configuration

Create a local environment file from the example:

~~~powershell
Copy-Item .env.example .env
~~~

The .env file is ignored by Git. Use it for local model paths and runtime settings.

### Local AI Assistant

The reader assistant uses a llama.cpp-compatible runtime and local GGUF models. The example configuration uses Sugoi 14B Ultra Q4 and Q3 models:

~~~env
LLAMA_SERVER_PATH=D:\YomiApuriModels\llama-tools\...\llama-server.exe
SUGOI_Q4_MODEL_PATH=D:\YomiApuriModels\Sugoi-14B-Ultra-GGUF\Sugoi-14B-Ultra-Q4_K_M.gguf
SUGOI_Q3_MODEL_PATH=D:\YomiApuriModels\Sugoi-14B-Ultra-GGUF\Sugoi-14B-Ultra-Q3_K_M.gguf
LLAMA_GPU_LAYERS=24
LLAMA_IDLE_TIMEOUT_SECONDS=600
~~~

Suggested starting points:

- Windows RTX desktop: LLAMA_GPU_LAYERS=24.
- 16 GB Apple Silicon Mac: LLAMA_GPU_LAYERS=16.

The assistant starts when a message is sent and can stop after the configured idle timeout. Assistant messages are kept in the current browser session and are not written to the application database.

The assistant accepts the current reader message, the selected page context, and a short rolling conversation history. Translation, explanation, recap, and question handling use the same selected model.

## Anki Setup

1. Install Anki Desktop.
2. Install the AnkiConnect add-on.
3. Start Anki Desktop.
4. Open Integrations > Anki.
5. Connect and select a deck and note type.
6. Save the deck and note type.
7. Import reviewed vocabulary or export a note from the reader.

On Windows, the app can open Anki Desktop automatically when AnkiConnect is unavailable. Exports use AnkiConnect so custom note types, fields, media, and note IDs are preserved.

## Dictionaries

The dictionary manager supports:

- Yomitan/Jitendex-style term dictionary ZIP files.
- Yomitan frequency dictionary ZIP files.
- Legacy JSON dictionaries with usable term and definition rows.

Enabled term dictionaries appear in reader lookup in their configured order. Frequency dictionaries provide frequency badges. The Word Bank dictionary selector chooses the dictionary used for Word Bank meanings. Full dictionary details are loaded only for matching lookup entries.

## Local Text Search

The Insights page provides the local text-search index controls:

- Refresh text search index: updates the SQLite FTS5/BM25 index for active book text.
- Search for phrase/vocab: searches indexed book sentences and paragraphs.
- Index status: shows whether the text index is ready or stale and when it was last refreshed.

Text search uses the same Japanese normalization inputs as the reader, including surfaces, dictionary forms, readings, compounds, and protected author-ruby readings. Raw book text remains available for exact substring matching.

Refresh the text index after importing books or after a tokenizer, dictionary, or normalization change. Deleted books are removed from the active search index; restored books are added after the next refresh.

## Supabase Sync

Supabase sync is optional and does not replace the local SQLite store.

1. Create a Supabase project.
2. Run the SQL migrations in supabase/migrations.
3. Open Integrations in the app.
4. Enter the Supabase URL and publishable key, or configure them through the local environment.
5. Sign in.
6. Use Push local data, Pull remote data, or Sync now.

Syncable source data includes books when the original file is available, progress, highlights, bookmarks, Word Bank terms, cards, settings, and learning events. Local dictionaries, generated media, SQLite files, search indexes, and model files stay on each device.

Do not commit Supabase keys in .env or source files.

## Data Storage

Important local paths:

- data/yomiapuri.sqlite: canonical local application state and FTS5 tables.
- data/document-cache: normalized reader/document cache.
- data/events.jsonl: append-only local learning events.
- data/media: generated Anki media.
- data/book-files: imported source files when available.
- models: local model files when configured.

These paths are ignored by Git.

## Development

Run the full test suite:

~~~powershell
npm test
~~~

Useful syntax checks:

~~~powershell
node --check src/frontend/app.js
node --check src/backend/index.js
node --check src/backend/ml-service.js
node --check src/backend/fts-search-service.js
~~~

The test suite covers Anki field mapping and export, dictionary parsing and lookup, local media providers, AI runtime contracts, SQLite FTS5 search, SQLite state storage, Supabase mapping, analytics, and API smoke behavior.

## Git Safety

Before pushing, inspect the worktree:

~~~powershell
git status --short
git ls-files .env data models
~~~

The second command should return no sensitive local environment, database, model, or generated data files.

## Design Notes

- SQLite is the canonical local store for application state.
- FTS5 is a rebuildable local text-search index.
- Source data remains usable offline.
- Supabase sync is optional and does not upload local databases, model files, or generated caches.
- The server is organized around route modules, services, and storage repositories so future changes can remain isolated.
