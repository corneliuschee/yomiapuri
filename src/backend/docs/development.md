# Development, Testing, and Debugging

[Back to backend guide](../README.md) | [API](api.md) | [Storage](storage.md)

## Run Locally

Use Python 3.12 and the dependencies in the repository's `requirements.txt`.
From the project root on Windows:

```powershell
py -3.12 -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r requirements.txt
.\.venv-backend\Scripts\python.exe run.py --reload
```

On macOS/Linux, the virtualenv interpreter is `.venv-backend/bin/python`.
The frontend is served directly; there is no frontend build requirement for
normal use. `--reload` watches backend source and restarts the process after edits.

Default URL is `http://127.0.0.1:3000`. Change `PORT` if it is occupied. For an
isolated manual session, point `DATA_DIR` at a fresh temporary directory **before**
launching. Do not experiment on the user's database or clear their caches just
to reproduce a bug.

`config.py` loads `.env`; environment values already set take precedence.
Settings defaults are merged on reads, while saved values live in SQLite.
Model paths, endpoint/GPU configuration, and Supabase setup are documented in
the [project README](../../../README.md).

## Automated Checks

```powershell
.\.venv-backend\Scripts\python.exe run.py test
node scripts/smoke-test.js
git diff --check
```

The Python suite uses `unittest`, FastAPI `TestClient`, temporary data directories,
and mocked external calls. It tests repeated book opening, known-state rendering,
author ruby, dictionary lookup, page stability, Trash, incremental FTS, Anki
preview/export/sync, route compatibility, sync ordering/errors, and restart
persistence. It must not open the real data directory.

The optional Node smoke test starts its own Python server on port 3199 with
temporary storage and exercises HTTP flows. It requires the repository's Node
dependencies (including `adm-zip`) and a Node version supporting `node:sqlite`.
It uses `.venv-backend` by default; `TEST_PYTHON` overrides the interpreter.
Keep port 3199 free. Node is a test-tool dependency here, not the app backend.

Focused example:

```powershell
.\.venv-backend\Scripts\python.exe -m unittest tests.test_backend.BackendTests.test_anki_reviewed_fields_and_retry -v
```

Relevant test files:

- [tests/test_backend.py](../../../tests/test_backend.py): isolated backend regressions and fixtures.
- [tests/api_contract.json](../../../tests/api_contract.json): expected registered method/path pairs.
- [scripts/smoke-test.js](../../../scripts/smoke-test.js): integration checks over HTTP.

Route presence tests do not prove all response fields/side effects. Add a targeted
behavior test when changing a contract. Mock AnkiConnect/Supabase/model endpoints;
automated tests should not create real notes, upload books, or start a large model.

## Safe Change Workflow

1. Find the owning service/route using the backend file map.
2. Trace the frontend caller and current response shape before editing.
3. Add an isolated regression reproducing the specific issue.
4. Keep network calls/CPU work outside SQLite transactions and async event-loop code.
5. Check whether the change affects revisions, author ruby, page indices, or deletion intent.
6. Run focused tests, then the complete Python suite and relevant HTTP smoke checks.
7. For reader changes, manually reopen two different books repeatedly and verify bookmarks/highlights survive.

Do not combine unrelated cleanup with behavioral fixes. There are compatibility
names and tables that look obsolete but still have callers. Search references
before removing them. Update this guide when changing ownership, storage, or API
contracts so it remains a map of the implementation, not a wishlist.

## Adding a Feature

- Add its route in the existing domain module when possible. If a new group is needed, register it in `api/__init__.py` before static handling.
- Put reusable domain work in `services/`; pass shared dependencies through construction in `main.py`.
- Use `Store` and parameterized SQL. Add source mutation and revision bump to the same transaction where relevant.
- Do not import `main.app` into services; that creates lifecycle/circular-import coupling.
- Use existing error conventions: `ValueError`, `LookupError`, `FileExistsError`, or intentional HTTP exceptions.
- Keep returned JSON naming compatible with frontend camelCase even where SQL uses snake_case.
- For slow streaming work, define terminal events and client failure handling, not just a progress label.
- For storage changes, test an existing database as well as an empty one; see the migration limits in the storage guide.

## Troubleshooting Map

| Symptom | Inspect first | Important distinction |
| --- | --- | --- |
| App will not start | Server traceback, `Store.__init__`, schema flags/integrity | Do not clear guards or delete SQLite to hide a migration failure |
| Book stuck checking cache | Ingest SSE response, `ensure_pages` and its lock | Cache-ready means pages exist, not that every page is rendered |
| Second book open is slow | `window`, NLP cache misses, dictionary revision, long SQL transactions | Vocabulary updates should not invalidate structural page/token caches |
| Dictionary has no matches | Dictionary metadata/enabled flags, indexed rows, `variants`, `entries` | Tokenizer dictionary and imported definition dictionaries are different |
| Known word gains furigana | `known_terms`, its revision, generated HTML, reader settings | Author ruby intentionally remains visible |
| Search stale or no results | `pythonSearch` saved revisions, fingerprints, active-document membership | Refreshing FTS does not load/refresh embeddings |
| Card preview differs from export | Reviewed `fields`, mapping, Key fallback, `target-word` markup | Export should preserve user-edited definitions |
| Export timeout or duplicate risk | AnkiConnect result and export journal status/request ID | Note may exist remotely even if local completion failed |
| Anki prints warnings but export succeeds | `data/logs/anki.log` for app-launched Anki | Upstream console warnings are not necessarily HTTP/export failures |
| Assistant unavailable | Final SSE `done.ai`, configured endpoint/paths, `data/llama/python-server.log` | HTTP 200 can still contain unavailable status |
| Assistant cannot search books | `AIService.events` | Retrieval is disabled in current implementation |
| Sync failed | Redacted sync status/lastError, external response, source timestamps/tombstones | Earlier record/file changes may already have succeeded |

Backend unexpected exceptions are logged to the server's output. Runtime logs
may contain private content or machine paths; redact before sharing. The Anki
log redirect only applies to processes launched by this backend.

## Coverage Limits

Tests cover representative paths, not every PDF layout, EPUB ruby structure,
third-party dictionary payload, Anki template, or real multi-device conflict.
The assistant failure test does not validate live model quality. Mocked sync
tests do not establish a complete distributed conflict-resolution protocol.
Use disposable copies/accounts for explicit live integration tests.

For documentation-only changes, compare Python ASTs after removing docstrings
to verify executable statements stayed unchanged. Function docstrings can also
appear in generated FastAPI documentation, so never put credentials or private
data in them.
