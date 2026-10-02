# HTTP API Reference

[Back to backend guide](../README.md) | [Flows](flows.md) | [Testing](development.md)

All paths below are relative to the local server (normally
`http://127.0.0.1:3000`). FastAPI exposes interactive API documentation at `/docs`
and the generated schema at `/openapi.json`. Many bodies are plain `dict`, so
OpenAPI cannot describe every domain field; this reference and service code
provide that context. Bodies are JSON unless marked multipart.

## Errors and Streaming

`main.py` maps validation/operation exceptions into `{"error": "..."}`:

| Status | Meaning |
| --- | --- |
| 400 | `ValueError`: invalid domain input or external action failure |
| 404 | `LookupError`: missing resource; also unknown API route |
| 409 | `FileExistsError`: duplicate or already-running operation |
| 422 | FastAPI request validation; includes `details` |
| 502 | Unhandled `httpx.HTTPError`: external connection/HTTP failure |
| 500 | Unexpected failure; generic response, details in server log |

Once SSE response headers are sent, operation outcomes arrive inside the stream,
not as a replacement HTTP status. Assistant expected failures use a `done` payload
with `ai.available=false`; book ingestion has an explicit `error` event.

## State and Reader Settings: `api/state.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/state` | UI settings, metadata-only documents/Trash, known-term count, progress, cards, templates, dictionary metadata, redacted sync status |
| PATCH or POST `/api/reader/settings` | `showKnownFurigana`, `hideInferredReadableFurigana`; returns `reader` |
| POST `/api/reader/readable-suggestion/dismiss` | `term`; logs a compatibility event and returns dismissed status |

The state response excludes book bodies and dictionary entries, but is still a
local/private endpoint, not a sanitized public account API.

## Library and Reader: `api/documents.py`

| Method/path | Inputs and result |
| --- | --- |
| POST `/api/documents` | Multipart `book`, optional `title`; 201 `{document}` |
| POST `/api/documents/reorder` | `ids`: every active ID exactly once; returns ordered documents |
| GET `/api/documents/{doc_id}/ingest-stream` | SSE cache-check result |
| GET `/api/documents/{doc_id}` | Optional zero-based `page`; document with progress, chapters, page windows/placeholders |
| GET `/api/documents/{doc_id}/pages` | `start=0`, `limit=8` (clamped 1..24); `{pages,start,total}` |
| PATCH `/api/documents/{doc_id}` | Nonempty `title`; metadata rename |
| POST `/api/documents/{doc_id}/progress` | Partial `page,scrollTop,bookmarks,highlights,mode,zoom,chapterId,percentage`; merged progress |
| DELETE `/api/documents/{doc_id}` | Move to Trash; `{deleted:true}` |
| POST `/api/trash/documents/{doc_id}/restore` | Restore; `{document}` |
| DELETE `/api/trash/documents/{doc_id}` | Permanent SQL cleanup of one Trash book |
| DELETE `/api/trash/documents` | Permanent SQL cleanup of all Trash books; deleted count |

Keep `/documents/reorder` registered before dynamic document routes. API reader
pages are zero-based, while imported PDF block `pageNumber` is one-based.

Ingest event sequence:

```text
event: progress
data: {"message":"Checking local book cache","progress":0}

event: done
data: {"rebuilt":true,"deferred":false,"state":"ready","indexStale":true,"progress":1,"message":"Local cache ready"}
```

An already-built book changes the rebuilt/deferred flags. Failure after the
initial event emits `event: error` with `{"error":"..."}`. These are start/end
notifications, not continuous percentage measurements.

## Dictionaries: `api/dictionaries.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/dictionaries` | Dictionary metadata and dictionary settings |
| POST `/api/dictionaries` | Multipart repeated `dictionary` uploads (max 20), optional `name` for a single upload; 201 dictionaries/validations |
| PATCH `/api/dictionaries/settings` | Settings patch, including `prefixWildcardSearch` |
| PATCH `/api/dictionaries/{dictionary_id}/settings` | `enabledForLookup`, `selectedForWordBank`, `sortOrder` |
| DELETE `/api/dictionaries/{dictionary_id}` | Delete dictionary and cascaded entries/frequencies; updated metadata |
| GET `/api/dictionary` or `/api/dictionary/lookup` | `term` or `q`, optional `prefix`; entries, frequencies, queryTerms, knownTerm, readability |

Each upload is limited to 60 MB. Archive services separately reject declared
uncompressed sizes over 512 MB. Multi-dictionary import commits each dictionary
independently. Lookup GET can write a token cache row and learning event.

## Anki and Media: `api/integrations.py`

| Method/path | Inputs and result |
| --- | --- |
| POST `/api/anki/settings` | Anki settings patch (deck/model/connection/field maps) |
| GET `/api/anki/connect` | Live deck/model lists and settings |
| GET `/api/anki/model-fields` | Optional `modelName`; live fields and mapping |
| POST `/api/anki/card-preview` | `documentId,expression`, optional sentence/surface/base/reading/meaning/deck/model; canonical values, mapped values, entries |
| POST `/api/anki/export-card` | Reviewed `fields`, `documentId,expression`, deck/model or saved defaults; optional `requestId,fieldMapUpdates`; 201 saved card/Anki note ID |
| POST `/api/anki/sync-vocabulary` or `/api/anki/import` | Optional `preset,deckName,query`; imported/added/total/syncedAt |
| POST `/api/anki/open-known-term` | `term`; opens Anki browser by linked note IDs or term |
| GET `/api/media/providers` | Image settings/status; audio disabled |
| POST `/api/media/settings` | `image` settings; audio forcibly disabled |
| POST `/api/media/test-image` | Optional `expression,reading,meaning`; image HTML/status |

Read [export flow](flows.md#card-preview-and-export) before adding retries. A
preview's `values` are the edited export's `fields`; these are not interchangeable
with canonical role names unless the actual Anki note type uses those names.

## Internal Vocabulary Compatibility: `api/wordbank.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/known-terms` | `offset,limit,q,sort,dictionaryId`; legacy paged term/meaning response |
| POST `/api/known-terms` | JSON `term`/`terms`, or multipart `terms` file; additive counts |
| DELETE `/api/known-terms` | `term`/`terms`, or `all:true`; removed counts |
| POST `/api/known-terms/sync-anki` | Legacy alias using default Anki vocabulary sync |
| POST `/api/trash/known-terms/restore` | `terms`; restore saved metadata |
| DELETE `/api/trash/known-terms` | `terms` or `all:true`; purge Trash entries, retain tombstones |

These routes remain even though the Word Bank page was removed. Their presence
is not a request to reintroduce that UI.

## Local Cards/Templates: `api/cards.py`

| Method/path | Inputs and result |
| --- | --- |
| POST `/api/templates` | Multipart `template`: JSON list/`fields` object or comma/newline field names; 201 template |
| POST `/api/cards` | Active `documentId`, `expression`, optional `templateId`, card values; 201 local card, no Anki call |
| GET `/api/cards/export` | CSV attachment with union of saved card fields |

## Search: `api/search.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/ml/index/status` | FTS status: ready/stale/chunks/provider/tokenizer, saved update counts/timestamps; aliases under `textSearch` and `fts` |
| POST `/api/search/index/refresh` | Incremental lexical refresh, synchronous response; 409 if already running |
| POST `/api/search/fts` | `query`, optional `documentId`, `limit` (1..100); sentence results/citations |

`/api/ml/index/rebuild`, semantic/vector update routes, and `/api/rag/ask` from
older plans are not registered here. Current search has no `readSafe` or
`currentPage` filter. Do not rely on ignored dictionary body fields for safety.

## AI: `api/assistant.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/ai/providers` | Settings/models/runtime status |
| GET `/api/ai/runtime` | Managed process running/busy/model/idle timeout |
| POST `/api/ai/runtime/stop` | Stop under assistant lock |
| POST `/api/ai/settings` | Settings/prompts patch |
| POST `/api/ai/models` | Hugging Face repo `url`, optional `name,localPath`; 201 metadata registration, not a download |
| POST `/api/reader/assistant/stream` | `question`, optional `history,documentId,modelId`; SSE `meta`, zero or more `delta`, then `done` |
| POST `/api/reader/assistant` | Same input; returns terminal result as JSON |
| POST `/api/ai/test-translation` | Compatibility `text` input; translation availability/result |

Example delta frame: `event: delta` followed by `data: {"delta":"text"}` and
a blank line. The final payload includes `answer`, `intent`, and `ai` availability.
Expected runtime failures still finish the stream; check `ai.available`, not just
HTTP status. No automatic book retrieval occurs.

## Supabase: `api/sync.py`

| Method/path | Inputs and result |
| --- | --- |
| GET `/api/sync/status` | Public status without session tokens |
| POST `/api/sync/settings` | `enabled,supabaseUrl,supabaseAnonKey,deviceName` |
| POST `/api/sync/sign-in` | `email,password`, optional configuration; persisted session/status |
| POST `/api/sync/sign-out` | Best-effort remote logout, clear local credentials |
| POST `/api/sync/pull` | Merge remote source data only |
| POST `/api/sync/push` | Pull first, then push |
| POST `/api/sync/run` | Pull then push |
| POST `/api/sync/cleanup-deleted` | Also uses pull-then-push; not a separate local-only cleanup |

Sync routes can upload/download books and study data to the configured account.
Use mocks and temporary data for development tests, not a real user's account.
