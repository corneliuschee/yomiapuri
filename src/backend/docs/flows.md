# Feature Flows

[Back to backend guide](../README.md) | [Storage](storage.md) | [API](api.md)

## Import and Open a Book

```text
POST /api/documents (multipart book)
  -> uploaded(): limit file size
  -> worker thread: BookService.import_file()
  -> extract source, chapters, images, author ruby
  -> Store.save_document(): metadata + full body, bump documents revision

GET /api/documents/{id}/ingest-stream
  -> progress event
  -> ensure_pages(): preserve existing pages or create missing ones
  -> done/error event

GET /api/documents/{id}
  -> response(): metadata + progress + whole-book page placeholders
  -> window(): render only eight nearby pages
  -> NLP.render() on textual blocks

GET /api/documents/{id}/pages?start=8&limit=8
  -> next bounded rendered window (maximum 24 pages)
```

`import_file` saves the original file under `data/media/<document-id>/source.*`.
EPUB extraction follows its manifest/spine and preserves internal links. Author
readings become URL-encoded `[[RUBY:surface|reading]]` markers. PDF extraction
stores source page references/text; optional cover rendering failure does not
reject a valid PDF. TXT input is UTF-8, optionally with a BOM.

Imported bodies retain text/chapters for sync and future pagination. First page
generation loads that body, groups text near 850 characters without splitting
quoted dialogue, and gives images/PDF pages separate boundaries. A long single
passage can exceed that target. Existing pages are not regenerated on ordinary
opens. Legacy missing chapter/ruby metadata can cause one full-body repair read.

`response()` still returns a lightweight entry for every page, but only the
nearby window contains HTML. `window()` reads/render-bounds content, not all
page metadata. PDF canvas rendering happens in the frontend. Saved page indices
must remain stable because progress, bookmarks, highlights, and search depend
on them.

The ingest stream reports start and completion, **not** ongoing token-by-token
progress. A `done` cache event does not mean every page has already been rendered.

## Smart Furigana and Dictionary Lookup

These are related but separate paths:

```text
Rendering:
page text -> author-marker parsing -> Sudachi C tokens
          -> enabled dictionary headword/reading adjustment
          -> structural SQLite token cache
          -> current known vocabulary + reader settings -> HTML

Lookup:
selected text -> NFKC normalization -> NLP.variants()
              -> indexed headword/reading candidates
              -> matched definition payloads + frequencies + known-note links
```

SudachiPy uses the installed `SudachiDict-core` package; Yomitan imports do not
replace that tokenizer. Mode C prefers longer lexical units. `raw()` returns
surface text, dictionary form, normalized form, reading, POS, and a proper-name
flag. `variants()` also extracts lexical heads so inflected queries can find
dictionary entries.

`tokens()` refines forms/readings with enabled dictionaries. It substitutes a
dictionary reading only when the surface equals the entry, preserving contextual
inflected readings. Author ruby is handled as an indivisible protected token.
Book-level `authorRubyReadings` also protects later occurrences without ruby.

`render()` applies current known vocabulary on each render. Known forms are
expanded from Anki-imported/internal terms, including bases and readings. The
known-term revision causes this helper set to update without retokenizing books.
`showKnownFurigana` affects generated ruby only. Author ruby always survives.

Inferred-readable words use a conservative rule, not a trained model: all kanji
must be known, an enabled dictionary entry and numeric rank <=10000 must exist,
and the token must not be flagged as a proper name. The score is 85 or 0;
explicit known/protected tokens receive 100. `hideInferredReadableFurigana`
controls generated readings without automatically adding terms.

Dictionary definitions live separately from indexed headwords. `entries()`
queries term and reading in separate bounded branches, then loads definitions
for those candidates. `lookup()` accepts at most twenty query variants. Prefix
lookup requires both the request flag and saved `prefixWildcardSearch` setting.

## Anki Vocabulary Sync

`POST /api/anki/sync-vocabulary` calls `AnkiService.import_terms`:

1. Select a review preset and deck, unless an explicit Anki query is supplied.
2. `findNotes` returns note IDs; `notesInfo` reads batches of 75.
3. Resolve each model's Expression/DictionaryForm mapping.
4. Strip HTML, ruby readings, bracket readings, and audio markup from those fields.
5. Collect new terms or new note links; write only changed vocabulary.
6. Update the last-sync timestamp and return imported/added/total counts.

It is additive: removing notes in Anki does not delete local known terms.
Fetching completes before vocabulary writes, so an interrupted fetch does not
partially import terms. Presets currently mean `prop:reps>0` (reviewed once),
`rated:365` (reviewed), `prop:ivl>=21` (mature), or unrestricted (all).

The standalone Word Bank page is gone. `api/wordbank.py` and the SQL tables still
support compatibility operations and learned-state behavior.

## Card Preview and Export

```text
preview -> lookup definitions + render highlighted sentence
        -> live Anki model fields + mappings -> editable values

export reviewed values
  -> validate book/deck/model/fields
  -> fill existing blank Key and missing sentence highlighting
  -> journal pending (SQL commit)
  -> optional local image + storeMediaFile -> Anki addNote
  -> journal created with returned note ID (SQL commit)
  -> card + known-term links + journal complete (one SQL transaction)
  -> mapping settings/event -> HTTP 201
```

Preview never creates a note. Export never reruns dictionary generation over
reviewed definitions. `canonical_field` provides heuristic mappings; saved
per-model mappings override them. Mining templates may have both `Key` and
`Word`; the special `fill_note_key` fills only an existing empty Key so Anki's
required first field is satisfied without inventing fields.

Anki and SQLite cannot share one transaction. The journal exposes uncertain
outcomes: repeating the **same** `requestId` returns a completed result or rejects
a pending/created attempt for inspection. A fresh request without an ID gets a
new UUID. Do not blindly retry an uncertain export or claim global exactly-once
delivery. Check Anki for an existing note before retrying.

Auto-launch occurs only after an AnkiConnect connection failure and a valid
configured executable. Launch diagnostics go to `data/logs/anki.log`; actual
AnkiConnect errors still reach the caller. No TTS is generated, but existing
local sound references can be uploaded. Image generation is a cached Pillow
text mnemonic, not an AI image service.

`api/cards.py` is different: it creates local template-based cards and downloads
CSV, without contacting Anki.

## Local Search Refresh and Query

`SearchService.refresh()` fingerprints each active book using its stored body
hash plus dictionary revision. Matching books are skipped. Changed/new books are
read page-by-page and split into sentence chunks; surface, base, normalized, and
reading terms are deduplicated per chunk before FTS insertion.

Tokenization happens outside the final write transaction. For each changed book,
the transaction rechecks active status, removes only that book's old search
rows, inserts replacements, and records the fingerprint. Other books are not
rewritten. Status records captured revisions and counts; concurrent source edits
leave it stale. A process-local lock rejects overlapping refreshes with 409.

`search()` first finds raw substrings with SQLite `instr`, then runs escaped
expanded query forms through FTS5 `MATCH` and `bm25()`. Exact results precede
ranked results and chunk IDs are deduplicated. Both paths join active documents.
The raw-substring phase is a scan, not an indexed substring algorithm.

There are no query embeddings, vector refreshes, or neural rerankers here.
`/api/ml/index/status` is a historical URL for current FTS status. The frontend's
reader search/highlight code is a separate UI path; editing FTS ranking does not
automatically change in-page highlighting. This service has no current-page
spoiler filter and is not connected to the assistant.

## Assistant

`AIService.events()` selects translate/recap/explain/ask from question keywords,
chooses a saved prompt override or `PROMPTS`, appends author-name readings with
Hepburn romanization, and sends recent history plus the question to llama.cpp.
It uses up to six history messages, each limited to 2500 characters, and a
2500-character question. The response limit is 768 tokens.

There is no automatic page-context or library retrieval. The recap prompt's
instruction to use already-read supplied text is not a retrieval filter or a
guarantee that the caller supplied safe text. Future RAG work must introduce an
explicit filtered context boundary.

An async lock serializes model use. A healthy endpoint is reused; otherwise a
configured loopback llama-server can start lazily. Managed model changes stop
the previous process. The idle watcher checks every fifteen seconds, with a
default ten-minute idle timeout. Stop affects only the managed process, not an
externally launched server.

Expected configuration/network failures are returned in the terminal `done`
payload with `ai.available=false`; HTTP 200 on a stream does not prove success.

## Supabase Sync

All sync is user-triggered. `run()` holds a process-local lock and always calls
`pull()` first, even for the explicit push route. Only a pull action skips the
subsequent push. Errors are saved in sync status; completed individual writes
remain if later requests fail.

Pull applies document tombstones before newer books, compares timestamps for
progress/vocabulary/settings, and downloads missing media with path/checksum
validation. Push publishes deletion intent, reconstructs active book bodies,
uploads referenced media and source records, and sends selected settings/events.
Dictionary contents, token caches, FTS tables, local models, and the SQLite file
are not uploaded. This is not a delta-only media-transfer implementation.

Document and known-term deletion intent is used. A `card_tombstones` table exists,
but current card sync does not implement an equivalent complete deletion flow.
Remote table definitions are in the repository's `supabase/migrations/` folder.
