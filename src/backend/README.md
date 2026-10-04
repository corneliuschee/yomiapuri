# Backend Developer Guide

This is the map of the current Python/FastAPI backend. Start here to find the
file for a feature. For installation, see the [project README](../../README.md).

## How the App Starts

```text
python run.py
  -> Uvicorn (the web server) imports src.backend.main:app
  -> main.py calls create_app() to build routes and error handlers
  -> server startup opens SQLite and creates the shared feature services
  -> browser requests reach the registered routes
  -> server shutdown closes database/network connections and the local AI model
```

`create_app()` builds the app; it does not itself start a listening server.
The startup/shutdown function in `main.py` is called `lifespan` by FastAPI.
Tests use `create_app(temporary_directory)` to keep real user data untouched.

`__main__.py` is a separate entry point for `python -m src.backend`. It starts
Uvicorn too. It is **not** automatically run when `create_app()` is called.

`api/__init__.py` lists the route modules in registration order. Its loop calls
each file's own `register(app)` function. This is an ordinary Python function
that adds endpoints to FastAPI, not a special Python keyword. Registration
connects a URL to a function; it does not execute that request's feature work.
Keep fixed paths such as `/api/documents/reorder` before variable book paths.

## Following a Request

```text
Browser requests GET /api/documents/<id>
  -> api/documents.py: reads the request and calls the book service
  -> services/books.py: prepares an eight-page reader window
  -> services/nlp.py: finds words and decides which furigana to show
  -> services/dictionary.py: finds matching words/readings in SQLite
  -> storage/sqlite.py: reads/saves data through the shared connection
  -> JSON with page HTML goes back to the browser
```

- **api/** handles URLs, uploaded files, request values, and response formatting.
- **services/** does the feature work, such as reading EPUBs or exporting Anki notes.
- **storage/** manages SQLite tables, reads, writes, and grouped changes.
- **main.py** creates services once and shares them through `request.app.state`.

Small routes sometimes execute SQL through `Store` directly. There is no
separate database class for every feature, and no JavaScript backend to call.

## Where Each Feature Lives

All file paths in this table are relative to this folder.

| Feature | Request handling | Main implementation |
| --- | --- | --- |
| Library, imports, chapters, reader pages, Trash | [api/documents.py](api/documents.py) | [services/books.py](services/books.py) |
| Bookmarks, highlights, last page, zoom | [api/documents.py](api/documents.py) | Progress row in [storage/sqlite.py](storage/sqlite.py); browser draws annotations |
| Furigana and known-word display | [api/state.py](api/state.py) saves reader settings | [services/nlp.py](services/nlp.py) |
| Dictionary import, order, lookup, frequency | [api/dictionaries.py](api/dictionaries.py) | [services/dictionary.py](services/dictionary.py), plus NLP lookup forms |
| Internal known vocabulary and word Trash | [api/vocabulary.py](api/vocabulary.py) | `Store.add_terms`, `delete_terms`, `known` |
| Sync learned words from Anki | [api/anki.py](api/anki.py) | `AnkiService.import_terms` in [services/anki.py](services/anki.py) |
| Anki connection, preview, field mapping, export | [api/anki.py](api/anki.py) | [services/anki.py](services/anki.py) |
| Card images and existing media transfer | [api/media.py](api/media.py) | [services/media.py](services/media.py) |
| Local card templates and CSV download | [api/cards.py](api/cards.py) | Small SQLite operations in that route file; no Anki call |
| Library text search and index refresh | [api/search.py](api/search.py) | [services/search.py](services/search.py) |
| Reader AI chat and model controls | [api/assistant.py](api/assistant.py) | [services/ai.py](services/ai.py) |
| Supabase account and device sync | [api/sync.py](api/sync.py) | [services/sync.py](services/sync.py) |
| Initial browser data | [api/state.py](api/state.py) | Reads book details/settings, not whole book bodies |

Supporting files:

| File | Purpose |
| --- | --- |
| [main.py](main.py) | Creates the app/services, handles errors, serves frontend/media files |
| [config.py](config.py) | Loads `.env`, finds folders, supplies settings defaults |
| [__main__.py](__main__.py) | Starts the server for `python -m src.backend` |
| [api/__init__.py](api/__init__.py) | Registers route groups in an explicit order |
| [api/uploads.py](api/uploads.py) | `read_upload()` reads an upload and enforces the 60 MB limit |
| [storage/sqlite.py](storage/sqlite.py) | Shared SQLite connection, startup checks, settings/data operations, change counters |
| [storage/schema.sql](storage/schema.sql) | Base table/index definitions; Python-specific additions also live in `Store.__init__` |
| Other `__init__.py` files | Identify Python packages and explain their purpose; no extra server startup |

`nlp` means natural language processing. Here it specifically means splitting
Japanese with Sudachi, finding base forms/readings, and generating reader HTML.
There is no general `common.py`: the old upload helper is named `uploads.py`
because it is not a collection of unrelated utilities.

The feature services stay together rather than being split into one-file-per-
function helpers. For example, EPUB parsing and reader page preparation share
the same rules for chapters and author readings. Anki preview/export share field
mapping rules. Keeping these related functions together makes changes easier to
trace. Only repeated book-deletion work was moved out of routes into the book
service; there is no new wrapper or repository layer to learn.

## What Is Stored, and What Is Rebuilt?

SQLite in `data/yomiapuri.sqlite` is the main local store. It contains books,
progress, known words, dictionaries, cards, settings, and sync deletion records.
Files such as book images and models stay on disk, outside SQLite.

The same database also stores **rebuildable data**: prepared pages, word tokens,
and text-search rows. Do not delete the whole database to reset a cache.
Dictionary definitions load only after matching entries are found. Normal page
navigation loads a small window, not the full book. Imports, first-time page
preparation, and sync can still read a complete book.

Useful terms used in code:

- **Token:** one piece of Japanese text with its base form and reading.
- **Ruby:** the HTML notation for furigana above the main text. Author-provided ruby must stay unchanged.
- **Revision:** a change counter saved in SQLite. Caches compare counters to detect outdated results.
- **Transaction:** SQL changes that succeed together or are all undone on failure.
- **Tombstone:** a deletion record, kept so sync does not bring deleted data back.
- **FTS5/BM25:** SQLite's text-search extension and its word-match ranking function.

Keep network calls and text analysis outside database transactions. When source
data changes, update its revision in the same transaction. Known-word updates
must not clear book pages or force the entire library to be tokenized again.

## Important Boundaries

- Anki vocabulary sync adds new learned words/note links; it does not delete local words missing from Anki.
- Anki exports keep user-edited fields and track request IDs to make retries safer.
- Author readings and existing page boundaries take priority over cleanup. Bookmarks depend on those page numbers.
- A Trash book is excluded from search. Permanent deletion removes its saved search rows, pages, and progress through `BookService.delete_permanently()`.
- Current library search is SQLite text search, **not vector search or RAG**. It can return unread pages.
- AI chat uses the submitted message/history and author-name readings. It does not automatically retrieve book passages.
- The Word Bank and learning analytics pages, sentence-candidate UI, and generated speech are removed. Internal known vocabulary and existing card audio still work.
- Some old database columns and response/settings names remain to read existing libraries. Their age alone does not make them safe to remove.

## Making a Change and Testing It

Find the feature above, read its frontend caller, then change the smallest owning
route/service. Keep shared service construction in `main.py`; do not import
`main.app` from a service. Keep response field names compatible with the frontend.

From the project root on Windows:

```powershell
.\.venv-backend\Scripts\python.exe run.py --reload
.\.venv-backend\Scripts\python.exe run.py test
node scripts/smoke-test.js
```

On macOS/Linux use `.venv-backend/bin/python`. The optional Node smoke test needs
the development dependencies installed with `npm install` and a free port 3199.
Python tests use temporary SQLite files and mocked external services. Do not
test destructive operations against the real library or create real Anki notes.

Tests live in [tests/test_backend.py](../../tests/test_backend.py),
[tests/test_uploads.py](../../tests/test_uploads.py), and the expected route list
[tests/api_contract.json](../../tests/api_contract.json). Keep the older-book
tests: they check that saved pages and author readings survive upgrades.

For more detail, read [feature flows](docs/flows.md),
[database/cache details](docs/storage.md), [endpoint reference](docs/api.md),
and [testing/troubleshooting](docs/development.md). The
[frontend guide](../frontend/README.md) maps browser-side features.
