# Storage, Caches, and Concurrency

[Back to backend guide](../README.md) | [Flows](flows.md) | [Testing](development.md)

## What Is Authoritative?

`<DATA_DIR>/yomiapuri.sqlite` is the canonical record store. Original books and
images remain in `<DATA_DIR>/media`. JSON **columns inside SQLite** are not a
return to `state.json` as primary storage: they hold variable-shaped settings,
annotations, card fields, and chapter blocks within SQL rows.

`Store` does not load all bodies or dictionary definitions at startup. Import,
initial pagination, legacy metadata repair, sync, and manual export can explicitly
load full bodies. Normal reader content is windowed. Metadata lists, known-term
sets, and some other queries still use `fetchall`; the app is not universally
streaming or constant-memory.

## Tables and Owners

The base schema is [schema.sql](../storage/schema.sql). Python-specific tables
and compatibility column additions also live in [Store.__init__](../storage/sqlite.py).
Inspect both before adding a migration; do not assume either file is complete
on its own.

| Tables | Contents / role | Main writer |
| --- | --- | --- |
| `documents` | Active metadata, order, paths, metadata JSON; legacy body columns remain | `Store.save_document`, document routes |
| `document_bodies` | Full source text/chapters, text length, content hash | `Store.save_document` |
| `trash_documents`, `trash_document_bodies` | Soft-deleted source records | `BookService.trash` |
| `reading_progress` | One JSON row per book: page, zoom, mode, bookmarks, highlights, timestamps | Progress route, sync pull |
| `known_terms` | Vocabulary and metadata such as Anki note IDs | Store term methods, Anki export/import |
| `trash_known_terms` | Restorable removed vocabulary metadata | `Store.delete_terms` |
| `cards` | Locally saved/exported card payloads | Anki export, local card route, sync |
| `templates` | Named lists of card fields | Template route, sync, startup default |
| `dictionaries` | Dictionary metadata, priority, enable/selection flags | Dictionary service/routes |
| `dictionary_entries` | Small headword/reading rows referencing content | Dictionary import |
| `dictionary_entry_content` | Definition, details, tag JSON for matched entries | Dictionary import |
| `dictionary_frequencies` | Term/reading ranks and display values | Dictionary import |
| `app_settings` | Settings groups, sync session, search status | `Store.settings`, sync |
| `document_tombstones`, `known_term_tombstones` | Deletion timestamps to prevent stale sync resurrection | Store/books/sync |
| `anki_export_journal` | Pending/created/complete export attempts and remote results | `AnkiService.export` |
| `python_learning_events` | Lookup/preview/export and compatibility action events | `Store.event`, sync |
| `store_revisions` | Monotonic per-domain invalidation counters | `Store.bump` |
| `schema_meta` | Schema version and initialization/compatibility flags | Store startup |

Derived, rebuildable tables:

| Tables | Contents / invalidation |
| --- | --- |
| `document_pages` | Stable page boundaries and block payloads; `html` contains serialized block JSON for newly created pages, not final rendered HTML |
| `python_token_cache` | Structural tokens keyed by text + dictionary revision + tokenizer-version marker |
| `python_search_chunks` | Sentence text and page/chapter citations |
| `python_search_fts` | FTS5 unique token strings and unindexed chunk IDs |
| `python_index_documents` | Per-book fingerprint of the indexed baseline |

`migration_runs`, `python_meanings`, and `card_tombstones` exist in schema but are
not active end-to-end workflows in this backend. Older databases can also retain
tables/files from previous implementations. Their presence does not mean current
services use them; do not delete them merely because this guide does not list a
consumer. `python_learning_events` persists actions but does not imply a learning
analytics page exists.

## Lazy Dictionary Reads

Dictionary entry indexes cover global and dictionary-scoped term/reading lookup.
The lookup service reads candidate metadata before loading content by ID.
Prefix queries use a bounded range instead of scanning a hydrated Python list.
`exact()` reads only term/reading for rendering and has a 4096-entry LRU cache.
Full definition payloads are not currently held in a dedicated definition LRU.
Dictionary import temporarily accumulates parsed rows, then inserts one complete
dictionary in one SQL transaction.

## Revision and Cache Rules

| Change | Revision/action | Consequence |
| --- | --- | --- |
| Add/delete/re-add known terms | Bump `known_terms` in source transaction | Refresh learned variants/kanji on demand; reuse structural tokens/pages |
| Anki export finalization | Bump `known_terms` with card/term writes | New word becomes known without full-book processing |
| Import/configure/delete a dictionary | Bump `dictionaries`; clear exact-match LRU | New structural-token cache keys; FTS fingerprints become stale |
| Save a book's metadata, reorder, Trash/restore | Bump `documents` | Search status stale; unchanged body fingerprints can still skip work |
| Save a body with `text` present | Replace body, hash text+chapters, delete that book's pages | Regenerate pages when next needed; search detects changed body hash |
| Save reader settings | Bump `reader` through generic settings helper | Current rendering reads the new flags; no structural retokenization |
| Save progress/annotations | Update one progress row/timestamp | No document/known/dictionary revision bump |
| Refresh search | Save captured source revisions in `pythonSearch` settings | Status compares captured/current revisions; overlapping edits remain stale |

`NLP.raw()` caches up to 2048 text tokenizations. `NLP.known()` retains per-term
variants so only changed vocabulary needs new variant generation. Frequency
rank and exact dictionary caches include dictionary revision in their keys.
Old SQLite token-cache entries are not automatically garbage-collected by these
paths. Readability/display state is calculated at render time, never frozen into
the structural token rows.

## Transactions and Locks

- One SQLite connection per app instance, shared across worker threads with an `RLock`.
- `WAL` enables readers on other connections to coexist with a writer; it does not eliminate this app's shared-connection lock or allow multiple simultaneous writers.
- `synchronous=NORMAL` trades some power-loss durability for lower WAL commit overhead.
- `busy_timeout=5000` waits up to five seconds for SQLite contention, not indefinitely.
- `Store.transaction()` commits on success and rolls back on exceptions. It does not implement nested savepoints.
- `Store.rows()`/`one()` use the same lock, so long transactions block in-process reads too.
- Book pagination has a service-wide `RLock`; search refresh and sync each have a nonblocking process-local lock. AI uses an `asyncio.Lock`.

Keep CPU-heavy parsing/tokenization and network calls outside write transactions.
For grouped source writes, use the yielded connection and `bump(domain, db)`.
Calling a helper that starts another transaction inside one is not an independent
atomic scope. Lock flags are per process: run the intended single-worker local
server, not multiple Uvicorn workers sharing one data directory without redesign.

Synchronous FastAPI handlers run in worker threads. Async upload handlers use
`run_in_threadpool` for heavy parsing; assistant I/O uses `httpx.AsyncClient`.
Do not put blocking dictionary scans or tokenization directly into async handlers.

## Startup Guard and Migration Limits

Startup enables SQLite pragmas, then checks any existing `schema_meta` flags.
It rejects `migration_in_progress=true` or a schema version newer than 2. An
existing store with schema metadata but without `python_backend=1` receives a
SQLite backup under `data/backups/before-python-*.sqlite`.

It runs `quick_check`, creates base/Python tables and missing dictionary columns,
writes initialization/default-setting records, then checks foreign keys. This is
**in-place compatibility initialization**, not a staged `.next` database with
atomic promotion. `migration_runs` is not an active migration runner. Do not
assume every future migration automatically receives a backup or rollback plan.

Before structural changes: define supported old schemas, back up with SQLite's
backup API or a stopped database, test old/new initialization and failure paths,
and retain recoverable user data. Never fix a migration guard by blindly clearing
the flag in a user's live database.

## Deletion Boundaries

Soft deletion moves metadata/body to Trash and records a tombstone. Progress is
retained. The active-document foreign key can cascade-delete derived pages;
restore regenerates missing pages as needed. FTS rows/fingerprints remain stored
but search joins active documents, hiding Trash immediately.

Permanent deletion prunes the target's FTS rows, chunks, fingerprint, pages,
Trash body/metadata, and progress in SQL. It retains sync deletion intent. The
current routes do not delete filesystem assets or exported Anki notes. Local
card records are not removed by this SQL cleanup either. Restoring a book may
reuse retained lexical rows if its fingerprint still matches.

## Backup and Privacy

Back up both SQLite and `media/` for recoverable books/images. Do not copy only
the main `.sqlite` file while a live WAL has uncheckpointed changes; use SQLite's
backup API or stop the app cleanly first. Model binaries can be backed up
separately.

`python run.py export` writes compatibility JSON for inspection. It is not a
complete backup: media and all journals/tombstones are not included. Its settings
can contain sync credentials. Keep exports, `.env`, the database, media, and
runtime logs out of Git/public attachments. Supabase sync uploads selected source
records, not the local database or derived caches.
