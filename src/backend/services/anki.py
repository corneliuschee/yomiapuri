"""Talk to AnkiConnect, build card previews, track exports, and sync known words."""

import html
import re
import uuid
import os
import subprocess
import time
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from .dictionary import hiragana, normalize
from ..storage.sqlite import decode, encode, now

CANONICAL_FIELDS = ['Expression', 'Reading', 'WordReading', 'WordReadingHiragana', 'SentenceReading',
                    'Sentence', 'Meaning', 'PrimaryDefinition', 'SecondaryDefinition', 'ExtraDefinition',
                    'Audio', 'WordAudio', 'SentenceAudio', 'Image', 'Source', 'DictionaryForm']


def canonical_field(name):
    """Guess whether an Anki field holds a word, reading, meaning, or other value.

    Try standard names first, then names used by common card templates. Skip
    known utility fields. Return an empty string when nothing matches. Saved
    user choices are applied separately by AnkiService.mapping.
    """
    if name == '例文':
        return 'Sentence'
    key = re.sub(r'[^a-z]', '', name.lower())
    exact = {re.sub(r'[^a-z]', '', f.lower()): f for f in CANONICAL_FIELDS}
    if key in exact:
        return exact[key]
    if key in {'key','id','noteid','term','target','kanji','japanese'}:
        return 'Expression'
    if re.match(r'^(pa|ajt|alt|is|separate|frequency|utility)', key) or key in {'additionalnotes','hint','hintnothidden','comment','primarydefinitionpicture'}:
        return ''
    for pattern, field in [('primary.*def|first.*def', 'PrimaryDefinition'), ('secondary.*def|second.*def', 'SecondaryDefinition'),
                           ('extra.*def|extra.*dict|additional.*def|other.*def', 'ExtraDefinition'), ('dictionary|base|lemma', 'DictionaryForm')]:
        if re.search(pattern, key):
            return field
    for pattern, field in [('sentence.*audio', 'SentenceAudio'), ('sentence.*reading', 'SentenceReading'),
                           ('sentence|example', 'Sentence'), ('audio|sound', 'WordAudio'),
                           ('definition|meaning|gloss', 'Meaning'), ('reading|kana|furigana', 'Reading'),
                           ('expression|vocab|word|front', 'Expression'), ('image|picture', 'Image'), ('source', 'Source')]:
        if re.search(pattern, key):
            return field
    return ''


def fill_note_key(fields, expression):
    """Fill an empty mining-note Key without changing reviewed fields or adding unknown fields."""
    # Key and Word both map to Expression, but the one-to-one field map retains only Word.
    # Anki still requires Key when it is the note type's first field.
    for field, value in fields.items():
        if field.casefold() == 'key' and not value.strip():
            fields[field] = expression


class AnkiService:
    def __init__(self, store, dictionaries, nlp, transport=None):
        self.store, self.dictionaries, self.nlp = store, dictionaries, nlp
        self.client = httpx.Client(timeout=20, transport=transport)
        self.media = None

    def close(self):
        self.client.close()

    def connect(self, action, params=None):
        """Send an AnkiConnect request and report connection or action errors.

        If Anki is closed and auto-launch is enabled, start the configured program
        and retry for up to fifteen seconds. Write Anki's own log messages to
        data/logs/anki.log. Real request errors still reach the caller.
        """
        settings = self.store.setting('anki')
        payload = {'action': action, 'version': 6, 'params': params or {}}
        try:
            response = self.client.post(settings['connectUrl'], json=payload)
        except httpx.ConnectError:
            executable = Path(settings.get('ankiExecutablePath', ''))
            if not settings.get('autoLaunchAnki') or not executable.is_file():
                raise
            # Anki and its add-ons emit diagnostics unrelated to the HTTP export result.
            # Keep them available without mixing them into the app server's output.
            log_dir = self.store.data_dir / 'logs'
            log_dir.mkdir(exist_ok=True)
            with (log_dir / 'anki.log').open('ab') as log:
                subprocess.Popen([str(executable)], stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            deadline = time.monotonic() + 15
            while True:
                time.sleep(.25)
                try:
                    response = self.client.post(settings['connectUrl'], json=payload, timeout=2)
                    break
                except httpx.ConnectError:
                    if time.monotonic() >= deadline:
                        raise
        response.raise_for_status()
        payload = response.json()
        if payload.get('error'):
            raise ValueError(str(payload['error']))
        return payload.get('result')

    def mapping(self, model, fields):
        """Match standard card values to Anki's field names, then use saved choices.

        Each value has one destination, so both Key and Word cannot map to the
        same value here. fill_note_key fills a required empty Key separately.
        """
        settings = self.store.setting('anki')
        explicit = settings.get('modelFieldMaps', {}).get(model, settings.get('fieldMap', {}))
        result = {canonical_field(f): f for f in fields if canonical_field(f)}
        result.update(explicit)
        return result

    def preview(self, body):
        """Prepare editable card values from dictionary entries and a sentence.

        Require a book in the library and an Anki note type. Read its field names,
        prepare sentence furigana/highlighting, and record that a preview opened.
        Return both standard values and the matching Anki fields. Do not create
        an Anki note yet.
        """
        doc = self.store.document(body.get('documentId'))
        if not doc:
            raise LookupError('Document not found.')
        settings = self.store.setting('anki')
        model = body.get('modelName') or settings['modelName']
        if not model:
            raise ValueError('Choose an Anki note type before previewing.')
        term = normalize(body.get('expression'))
        if not term:
            raise ValueError('Expression is required.')
        base = normalize(body.get('dictionaryForm') or term)
        entries = self.dictionaries.lookup(base, self.nlp.variants(base))['entries']
        meanings = ['; '.join(e['definitions']) for e in entries]
        sentence = self.nlp.render(body.get('sentence', ''), target=body.get('surface') or term, force=True)
        reading = body.get('reading', '')
        canonical = dict.fromkeys(CANONICAL_FIELDS, '')
        canonical.update(Expression=term, DictionaryForm=base, Reading=reading, WordReading=reading,
                         WordReadingHiragana=hiragana(reading), Sentence=sentence, SentenceReading=sentence,
                         Meaning=body.get('meaning') or next(iter(meanings), ''),
                         PrimaryDefinition=next(iter(meanings), ''), SecondaryDefinition=meanings[1] if len(meanings) > 1 else '',
                         ExtraDefinition='; '.join(meanings[2:]), Source=doc['title'])
        fields = self.connect('modelFieldNames', {'modelName': model})
        mapping = self.mapping(model, fields)
        values = {f: next((canonical.get(k, '') for k, v in mapping.items() if v == f), '') for f in fields}
        fill_note_key(values, term)
        self.store.event('sentence.previewed', {'documentId': doc['id'], 'expression': term})
        return {'deckName': body.get('deckName') or settings['deckName'], 'modelName': model, 'canonical': canonical,
                'fields': fields, 'values': values, 'fieldMap': mapping,
                'unmappedFields': [f for f in fields if f not in mapping.values()], 'dictionaryEntries': entries,
                'media': self.media.status() if self.media else {}}

    def export(self, body):
        """Export the user's reviewed fields and save the result in SQLite.

        Keep edited definitions; only fill a blank existing Key and missing
        sentence highlights/media. Record 'pending' before contacting Anki and
        'created' after receiving its note ID. Then save the card, known-word
        links, and 'complete' status together. Do not hold a database transaction
        open during network calls.

        Reusing a requestId returns the saved completed result, or refuses to
        repeat an export whose outcome is uncertain. Without requestId, each
        call is a separate export; this log cannot identify duplicate requests.
        """
        doc = self.store.document(body.get('documentId'))
        if not doc:
            raise LookupError('Document not found.')
        settings = self.store.setting('anki')
        model, deck = body.get('modelName') or settings['modelName'], body.get('deckName') or settings['deckName']
        if not model or not deck:
            raise ValueError('Choose an Anki deck and note type before exporting.')
        expression = normalize(body.get('expression'))
        fields = {str(k): str(v or '') for k, v in body.get('fields', {}).items()}
        if not expression or not fields or not any(fields.values()):
            raise ValueError('Expression and reviewed Anki fields are required.')
        fill_note_key(fields, expression)
        mapping = {**self.mapping(model, fields), **body.get('fieldMapUpdates', {})}
        # Only add highlighting to reviewed sentence text; never regenerate edited definitions.
        for key in ['Sentence', 'SentenceReading']:
            field = mapping.get(key)
            if field not in fields or 'target-word' in fields[field]:
                continue
            soup = BeautifulSoup(fields[field], 'html.parser')
            targets = list(dict.fromkeys(filter(None, [body.get('surface'), expression, body.get('dictionaryForm')])))
            for node in list(soup.find_all(string=True)):
                if node.parent.name in {'rt', 'rp', 'script', 'style'}:
                    continue
                text = str(node)
                pattern = '|'.join(re.escape(t) for t in sorted(targets, key=len, reverse=True))
                if pattern and re.search(pattern, text):
                    fragment = ''.join('<b class="target-word" style="color:#ff6633">' + html.escape(p) + '</b>'
                                       if i % 2 else html.escape(p) for i, p in enumerate(re.split('(' + pattern + ')', text)))
                    node.replace_with(BeautifulSoup(fragment, 'html.parser'))
            fields[field] = str(soup)
        key = str(body.get('requestId') or uuid.uuid4())
        previous = self.store.one('SELECT status,result_json FROM anki_export_journal WHERE id=?', (key,))
        if previous:
            if previous['status'] == 'complete':
                return decode(previous['result_json'], {})
            raise ValueError('This export is already pending. Check Anki before retrying.')
        self.store.write('INSERT INTO anki_export_journal VALUES (?,?,?,?,?,?)', (key, 'pending', encode(body), '{}', now(), now()))
        if self.media:
            for canonical, field in mapping.items():
                if field not in fields or fields[field].strip():
                    continue
                if canonical == 'Image':
                    fields[field] = self.media.image(expression, body.get('reading', ''), body.get('meaning', ''))
            self.media.store_files(fields, self.connect)
        note_id = self.connect('addNote', {'note': {'deckName': deck, 'modelName': model, 'fields': fields,
                                                  'options': {'allowDuplicate': False}, 'tags': ['sentence-mining', 'kanji-reader']}})
        card = {**{k: body.get(k, '') for k in ['documentId','expression','dictionaryForm','reading','sentence','meaning']},
                'id': key, 'ankiNoteId': note_id, 'source': doc['title'], 'deckName': deck, 'modelName': model,
                'fields': fields, 'createdAt': now()}
        # Journal the remote result before finalizing so failures cannot silently duplicate a note.
        self.store.write('UPDATE anki_export_journal SET status=?,result_json=?,updated_at=? WHERE id=?', ('created', encode(card), now(), key))
        with self.store.transaction() as db:
            db.execute('INSERT INTO cards VALUES (?,?,?,?)', (key, -int(time.time() * 1000), encode(card), now()))
            term = normalize(body.get('dictionaryForm') or expression)
            old = self.store.one('SELECT meta_json FROM known_terms WHERE term=?', (term,))
            meta = decode(old['meta_json'], {}) if old else {'addedAt': now()}
            meta['ankiNoteIds'] = list(dict.fromkeys([*meta.get('ankiNoteIds', []), note_id]))
            db.execute('INSERT INTO known_terms VALUES (?,?,?,?) ON CONFLICT(term) DO UPDATE SET meta_json=excluded.meta_json,updated_at=excluded.updated_at',
                       (term, 0, encode(meta), now()))
            db.execute('DELETE FROM known_term_tombstones WHERE term=?', (term,))
            db.execute('DELETE FROM trash_known_terms WHERE term=?', (term,))
            self.store.bump('known_terms', db)
            db.execute('UPDATE anki_export_journal SET status=?,updated_at=? WHERE id=?', ('complete', now(), key))
        if body.get('fieldMapUpdates'):
            maps = self.store.setting('anki').get('modelFieldMaps', {})
            maps[model] = {**maps.get(model, {}), **body['fieldMapUpdates']}
            self.store.settings('anki', {'modelFieldMaps': maps})
        self.store.event('anki.exported', {'documentId': doc['id'], 'expression': expression})
        return card

    def import_terms(self, body):
        """Add learned words from Anki without deleting existing local words.

        Use the selected review filter/deck or a supplied Anki query. Read notes
        in batches of 75 and remove HTML, furigana, and audio tags from word fields.
        Save only new words/note links, after every batch succeeds. Removing a
        note in Anki does not remove the app's copy of the learned word.
        """
        preset = body.get('preset') or self.store.setting('anki').get('vocabularyPreset', 'reviewed-once')
        query = body.get('query') or {'reviewed-once': 'prop:reps>0', 'reviewed': 'rated:365', 'mature': 'prop:ivl>=21', 'all': ''}.get(preset, 'prop:reps>0')
        deck = body.get('deckName') or self.store.setting('anki')['deckName']
        if deck and not body.get('query'):
            query = 'deck:' + encode(deck) + ' ' + query
        ids = list(dict.fromkeys(self.connect('findNotes', {'query': query})))
        metadata = {}
        for start in range(0, len(ids), 75):
            for note in self.connect('notesInfo', {'notes': ids[start:start + 75]}):
                fields = note.get('fields', {})
                mapping = self.mapping(note.get('modelName', ''), fields)
                vocabulary_fields = {mapping.get('Expression'), mapping.get('DictionaryForm')}
                for field, value in note.get('fields', {}).items():
                    if field not in vocabulary_fields:
                        continue
                    soup = BeautifulSoup(value.get('value', ''), 'html.parser')
                    for ruby in soup.select('rt,rp'):
                        ruby.decompose()
                    text = re.sub(r'\[sound:[^\]]+\]', '', soup.get_text())
                    text = re.sub(r'(?<=[\u3400-\u9fff])\[[\u3040-\u30ff\u30fc]+\]', '', text)
                    term = normalize(text)
                    if term:
                        metadata.setdefault(term, {'ankiNoteIds': [], 'importedAt': now()})['ankiNoteIds'].append(note['noteId'])
        existing = self.store.known()
        changed = {term: meta for term, meta in metadata.items()
                   if term not in existing or set(meta['ankiNoteIds']) - set(existing[term].get('ankiNoteIds', []))}
        added = self.store.add_terms(list(changed), changed) if changed else []
        synced_at = now()
        self.store.settings('anki', {'lastVocabularySyncAt': synced_at, 'vocabularyPreset': preset})
        return {'imported': len(metadata), 'added': len(added), 'total': len(self.store.known()), 'syncedAt': synced_at}
