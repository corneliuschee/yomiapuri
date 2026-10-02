# Backend Developer Guide

This guide describes the **current Python backend**, not the earlier Node.js
implementation or historical RAG plans. Start here to locate a feature, then
follow the detailed guides when changing its behavior.

## Reading Order

1. This page: architecture, file ownership, and where to make a change.
2. [Feature flows](docs/flows.md): how reader, dictionary, Anki, search, AI, and sync requests work.
3. [Storage and caching](docs/storage.md): canonical data, derived tables, revisions, and concurrency.
4. [HTTP API](docs/api.md): route ownership, inputs, errors, and streaming contracts.
5. [Development and testing](docs/development.md): running locally, safe tests, and debugging.

For end-user installation, see the [project README](../../README.md).
For browser code, see the [frontend guide](../frontend/README.md).

## Architecture in One Minute

YomiApuri runs a loopback FastAPI server. It serves the browser frontend and JSON
API from the same origin. SQLite is the canonical local store. Services read it
as needed rather than hydrating all books/dictionaries into a global state object.

```text
run.py -> Uvicorn -> main.create_app() -> lifespan startup
                                           |
                                 Store + shared services
                                           |
Browser -> api/<feature>.py -> services/<feature>.py -> storage/sqlite.py
                  |                    |                       |
                  |                    |                yomiapuri.sqlite
                  |                    +-> media files
                  |                    +-> AnkiConnect / llama.cpp / Supabase
                  |
                  +-> JSON or SSE response -> frontend feature module
```

Routes handle HTTP parsing and response contracts. Services contain most domain
logic. `Store` owns the connection, common reads/writes, transactions, and
revision counters. Some routes still execute SQL directly for small operations;
there is **not** a separate repository class for every table.

Current search is lexical SQLite FTS5/BM25, not embeddings or LanceDB. AI chat
uses the submitted question/history and author-name readings; it does not query
the search service. The Word Bank page, learning analytics page, sentence-mining
candidate lists, and backend TTS generation have been removed. Internal known
vocabulary and several legacy API/settings names remain for compatibility.

## File Map

Paths below are relative to `src/backend/`, unless stated otherwise.

| File/directory | Owns | Does not own |
| --- | --- | --- |
| [main.py](main.py) | App factory, service construction/shutdown, error handlers, static mounts | Feature business logic |
| [config.py](config.py) | `.env`, project/data paths, fresh settings defaults | Anki/model connectivity |
| [__main__.py](__main__.py) | `python -m src.backend` server entry | Data initialization outside app lifespan |
| [api/__init__.py](api/__init__.py) | Ordered registration of route groups | Service creation |
| [api/common.py](api/common.py) | Bounded multipart file reads | ZIP parsing |
| [api/state.py](api/state.py) | UI read model, reader settings, legacy dismissal endpoint | A mutable canonical state snapshot |
| [api/documents.py](api/documents.py) | Import, order, reader windows, progress, Trash/permanent deletion | EPUB parsing/NLP |
| [api/dictionaries.py](api/dictionaries.py) | Dictionary uploads/settings/deletion and lookup routes | Tokenization implementation |
| [api/wordbank.py](api/wordbank.py) | Legacy known-term CRUD/restore/import APIs | A visible Word Bank page |
| [api/integrations.py](api/integrations.py) | Anki and image-provider HTTP adapters | Card preparation/export mechanics |
| [api/cards.py](api/cards.py) | Template upload, local card records, CSV export | AnkiConnect note creation |
| [api/assistant.py](api/assistant.py) | AI settings/model registration and chat responses | Retrieval or model downloads |
| [api/search.py](api/search.py) | FTS status, refresh, and query endpoints | Vector search |
| [api/sync.py](api/sync.py) | Explicit user-triggered Supabase operations | Background automatic sync |
| [services/books.py](services/books.py) | EPUB/PDF/TXT extraction, ruby markers, pagination, reader HTML, soft delete/restore | Browser PDF canvas drawing |
| [services/nlp.py](services/nlp.py) | Sudachi tokens, variants, learned forms, readability, generated ruby | Full dictionary definitions |
| [services/dictionary.py](services/dictionary.py) | Yomitan/JSON import, indexed candidates, definitions/frequencies | Morphological tokenization |
| [services/anki.py](services/anki.py) | AnkiConnect, field mapping, preview, journaled export, vocabulary sync | Card styling inside Anki |
| [services/media.py](services/media.py) | Local Pillow mnemonic images and uploading existing media to Anki | Speech or generative image models |
| [services/ai.py](services/ai.py) | Prompts, llama.cpp lifecycle, name romanization, streaming | Library retrieval |
| [services/search.py](services/search.py) | Incremental per-book FTS index and exact/BM25 results | Reader sidebar highlighting |
| [services/sync.py](services/sync.py) | Supabase auth, source-data merge/upload, media transfer | Uploading local DB/index/model files |
| [storage/sqlite.py](storage/sqlite.py) | Connection, schema initialization, transactions, revisions, canonical operations | Network requests |
| [storage/schema.sql](storage/schema.sql) | Base tables, foreign keys, indexes | All Python-specific tables; some are created in `Store.__init__` |
| [runtimes/__init__.py](runtimes/__init__.py) | Package placeholder | A second runtime implementation |
| [../../run.py](../../run.py) | Virtualenv dispatch, server/test/export commands | Feature logic |
| [../../scripts/export_sqlite_state.py](../../scripts/export_sqlite_state.py) | Private JSON inspection/export | A complete media-inclusive backup/restore system |

Other `__init__.py` files mark Python packages. They are not additional feature
implementations. Read the service named for the feature before searching old
settings or legacy route names.

## Where Should I Make a Change?

| Desired change | Start here | Also inspect |
| --- | --- | --- |
| Import format, cover, author, chapter links | `services/books.py`: `import_file`, `epub` | `api/documents.py`, frontend `js/library/` |
| Page boundaries or first-page chapter headings | `services/books.py`: `ensure_pages`, `window` | Existing bookmarks/progress and PDF behavior |
| Reader layout, highlight painting, sidebar search UI | Frontend `js/reader/` and `styles/` | `BookService.window` HTML classes/data attributes |
| Unknown/known furigana behavior | `services/nlp.py`: `known`, `tokens`, `render` | Reader settings route and author-ruby tests |
| Dictionary matches or meanings | `services/dictionary.py`: `entries`, `lookup` | `NLP.variants`, dictionary indexes/settings |
| Which Anki words become known | `services/anki.py`: `import_terms` | `Store.add_terms`, frontend integrations |
| Anki fields, preview, sentence highlighting | `services/anki.py`: `mapping`, `preview`, `export` | `fill_note_key`, frontend `js/anki/` |
| Bookmarks, zoom, reading position | `api/documents.py`: `progress` | `Store.progress`, frontend reader persistence |
| Search ranking or refresh | `services/search.py` | `NLP.variants`, `python_search_*` tables |
| AI answer style/context | `services/ai.py`: `PROMPTS`, `events` | Saved prompt overrides, frontend chat history |
| Model startup, idle shutdown, GPU flags | `services/ai.py`: `ensure`, `idle_watch` | Environment variables in root README |
| Cloud conflicts/deletion propagation | `services/sync.py`: `run`, `pull`, `push` | Tombstones and Supabase migrations |
| New stored field or schema change | `storage/sqlite.py`, `storage/schema.sql` | Old database compatibility and startup tests |
| New endpoint or HTTP error behavior | Relevant `api/` module; `main.py` for shared errors | `tests/api_contract.json`, caller in frontend |

## Startup and Service Lifetime

`run.py` selects `.venv-backend` when available, changes to the project root, and
launches Uvicorn. `config.py` loads `.env` without overriding existing environment
variables. `DATA_DIR` selects storage; otherwise it is `<project>/data`.

`create_app()` registers routes but defers database/service construction to the
FastAPI lifespan. The order is Store, dictionary, NLP, books, Anki, media, sync,
search, AI. Media is attached to Anki; an async idle watcher is started for AI.
No llama model is loaded just because the web app starts.

Each request accesses these shared instances through `request.app.state`.
Normal shutdown closes AI/background work, Anki and sync HTTP clients, then the
database. Tests supply a temporary data directory to the same factory.

API registration order is assistant, search, integrations, state, documents,
wordbank, dictionaries, sync, cards. Unknown `/api/...` routes return JSON 404.
PDF.js (if present), `/media`, and finally the frontend static mount follow.

## Rules to Preserve

- Keep page numbers zero-based in APIs/storage; distinguish them from PDF source page numbers, which are one-based.
- Never repaginate existing books merely because vocabulary or dictionary settings changed.
- Keep author ruby authoritative. Generated furigana settings must not hide or replace it.
- Do not hold a SQLite transaction during network calls, book parsing, or tokenization.
- Pair relevant source writes with revision bumps; do not put learned-state decisions into structural token caches.
- Keep dictionary candidate reads small before fetching definition payloads.
- Do not regenerate reviewed Anki definitions during export or replace targeted SQL writes with full snapshots.
- Preserve active-document filters when returning search hits from retained Trash index rows.
- Treat local settings/exports as private. This loopback app is not designed as a publicly authenticated web service.
