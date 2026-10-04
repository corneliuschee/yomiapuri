"""Import dictionaries and use SQLite indexes to find words and frequency ranks."""

import io
import json
import re
import unicodedata
import uuid
import zipfile
from functools import lru_cache

from ..storage.sqlite import decode, encode, now


def normalize(text):
    return unicodedata.normalize('NFKC', str(text or '')).strip()


def hiragana(text):
    return ''.join(chr(ord(c) - 0x60) if '\u30a1' <= c <= '\u30f6' else c for c in str(text or ''))


def plain(value):
    """Turn a Yomitan definition's nested lists and objects into plain text."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ' '.join(filter(None, map(plain, value)))
    if isinstance(value, dict):
        return plain(value.get('content', value.get('text', value.get('definition', ''))))
    return ''


def frequency(value):
    """Read a frequency label from a number, string, or nested dictionary entry."""
    if isinstance(value, (int, float, str)):
        return str(value)
    if isinstance(value, list):
        return ', '.join(filter(None, map(frequency, value)))
    if isinstance(value, dict):
        for key in ['displayValue', 'frequency', 'value', 'rank', 'score']:
            if key in value:
                return frequency(value[key])
    return ''


def cleaned(items):
    result = []
    for item in items:
        text = plain(item).strip()
        if not text or re.search(r'[\u2605\u26ec]', text):
            continue
        if text not in result:
            result.append(text)
    return result


class DictionaryService:
    def __init__(self, store):
        self.store = store

    def metadata(self):
        return [{'id': r['id'], 'name': r['name'], 'filename': r['filename'], 'type': r['type'],
                 'language': r['language'], 'format': r['format'], 'enabledForLookup': bool(r['enabled_for_lookup']),
                 'selectedForWordBank': bool(r['selected_for_wordbank']), 'sortOrder': r['sort_order'],
                 'entriesCount': r['entries_count'], 'frequencyCount': r['frequency_count'],
                 'validationStatus': r['validation_status'], 'importedAt': r['imported_at']}
                for r in self.store.rows('SELECT id,name,filename,type,language,format,enabled_for_lookup,selected_for_wordbank,sort_order,entries_count,frequency_count,validation_status,imported_at FROM dictionaries ORDER BY sort_order,rowid')]

    def import_file(self, filename, data, name=''):
        """Read a Yomitan ZIP or JSON dictionary, then save it in one transaction.

        Read the file before holding the database lock. Store words/readings
        separately from large definitions so lookups load only matched entries.
        Update the dictionary change counter for caches. Import holds the new
        entries in memory temporarily; later lookups do not load the whole file.
        """
        term_rows, frequency_rows, index = [], [], {}
        if filename.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if sum(i.file_size for i in archive.infolist()) > 512 * 1024 * 1024:
                    raise ValueError('Dictionary archive is too large after decompression.')
                if 'index.json' not in archive.namelist():
                    raise ValueError('Dictionary ZIP must contain index.json.')
                index = json.loads(archive.read('index.json'))
                for member in sorted(archive.namelist()):
                    if re.fullmatch(r'term_bank_\d+\.json', member):
                        term_rows.extend(json.loads(archive.read(member)))
                    elif re.fullmatch(r'term_meta_bank_\d+\.json', member):
                        frequency_rows.extend(json.loads(archive.read(member)))
        else:
            parsed = json.loads(data.decode('utf-8-sig'))
            index = parsed if isinstance(parsed, dict) else {}
            term_rows = parsed if isinstance(parsed, list) else parsed.get('terms', parsed.get('entries', []))
        entries = []
        for row in term_rows:
            if isinstance(row, list) and len(row) > 5:
                term, reading, tags, gloss = normalize(row[0]), normalize(row[1]), str(row[2]).split(), row[5]
                details = gloss
            elif isinstance(row, dict):
                term = normalize(row.get('term', row.get('expression', row.get('word'))))
                reading, tags = normalize(row.get('reading')), row.get('tags', [])
                gloss = row.get('definitions', row.get('definition', row.get('meaning', [])))
                details = row.get('details', row.get('fullDefinitions', row.get('glossary', gloss)))
            else:
                continue
            definitions = cleaned(gloss if isinstance(gloss, list) else [gloss])
            if term and definitions:
                entries.append((term, reading, definitions, details if isinstance(details, list) else [details], tags))
        frequencies = []
        for row in frequency_rows:
            if not isinstance(row, list) or len(row) < 3 or row[1] != 'freq':
                continue
            raw = row[2]
            value = frequency(raw)
            if normalize(row[0]) and value:
                frequencies.append((normalize(row[0]), normalize(raw.get('reading', '')) if isinstance(raw, dict) else '', value))
        if not entries and not frequencies:
            raise ValueError('No valid term or frequency rows found in this dictionary.')
        dictionary_id = str(uuid.uuid4())
        kind = 'term' if entries else 'frequency'
        existing = self.metadata()
        # New term dictionaries precede frequency dictionaries.
        order = next((d['sortOrder'] for d in existing if d['type'] == 'frequency'), len(existing)) if entries else len(existing)
        title = name.strip() or index.get('title', index.get('name', filename.rsplit('.', 1)[0]))
        with self.store.transaction() as db:
            db.execute('UPDATE dictionaries SET sort_order=sort_order+1 WHERE sort_order>=?', (order,))
            db.execute('''INSERT INTO dictionaries(id,type,name,filename,sort_order,payload_json,updated_at,language,format,
                enabled_for_lookup,selected_for_wordbank,imported_at,validation_status,entries_count,frequency_count)
                VALUES (?,?,?,?,?,?,?,?,?,1,?,?,'valid',?,?)''',
                (dictionary_id, kind, title, filename, order, '{}', now(), index.get('targetLanguage', index.get('language', 'unknown')),
                 'yomitan' if filename.lower().endswith('.zip') else 'legacy', int(bool(entries) and not any(d['selectedForWordBank'] for d in existing)), now(), len(entries), len(frequencies)))
            for i, (term, reading, definitions, details, tags) in enumerate(entries):
                entry_id = f'{dictionary_id}:{i}'
                db.execute('INSERT INTO dictionary_entries VALUES (?,?,?,?,?,?,?)', (entry_id, dictionary_id, i, term, reading, entry_id, now()))
                db.execute('INSERT INTO dictionary_entry_content VALUES (?,?,?,?,?,?)', (entry_id, dictionary_id, encode(definitions), encode(details), encode(tags), now()))
            for i, (term, reading, value) in enumerate(frequencies):
                db.execute('INSERT INTO dictionary_frequencies VALUES (?,?,?,?,?,?,?,?)', (f'{dictionary_id}:{i}', dictionary_id, i, term, reading, value, value, now()))
            self.store.bump('dictionaries', db)
        self.exact.cache_clear()
        return {'dictionary': next(d for d in self.metadata() if d['id'] == dictionary_id), 'validation': {'termRows': len(entries), 'frequencyRows': len(frequencies)}}

    def settings(self, dictionary_id, patch):
        """Change dictionary order/use and allow only one preferred meaning source.

        A frequency-only dictionary cannot provide meanings for known words.
        Update the change counter and clear cached exact matches.
        """
        current = next((d for d in self.metadata() if d['id'] == dictionary_id), None)
        if not current:
            raise LookupError('Dictionary not found.')
        with self.store.transaction() as db:
            if patch.get('selectedForWordBank'):
                if current['type'] != 'term':
                    raise ValueError('Select a term dictionary for Word Bank meanings.')
                db.execute('UPDATE dictionaries SET selected_for_wordbank=0')
            for key, column in [('enabledForLookup', 'enabled_for_lookup'), ('selectedForWordBank', 'selected_for_wordbank'), ('sortOrder', 'sort_order')]:
                if key in patch:
                    db.execute(f'UPDATE dictionaries SET {column}=?,updated_at=? WHERE id=?', (int(patch[key]), now(), dictionary_id))
            self.store.bump('dictionaries', db)
        self.exact.cache_clear()
        return next(d for d in self.metadata() if d['id'] == dictionary_id)

    @lru_cache(maxsize=4096)
    def exact(self, term, revision=0):
        """Find a word and reading in the first matching enabled dictionary.

        Do not load definitions. The dictionary change counter is part of the
        cache key, so imports and settings changes get fresh results.
        """
        return self.store.one('''SELECT e.term,e.reading FROM dictionary_entries e JOIN dictionaries d ON d.id=e.dictionary_id
            WHERE e.term=? AND d.enabled_for_lookup=1 ORDER BY d.sort_order,e.sequence LIMIT 1''', (term,))

    def entries(self, term, dictionary_id=None, prefix=False):
        """Find matching words/readings first, then load only their definitions.

        Search words and readings separately, up to 100 matches each. Prefix
        search uses an indexed range rather than scanning every entry. A supplied
        dictionary_id can select a disabled dictionary too. Remove duplicates.
        """
        conditions = ['d.id=?'] if dictionary_id else ['d.enabled_for_lookup=1']
        params = [dictionary_id] if dictionary_id else []
        # Separate branches keep dictionary-scoped OR queries from scanning every entry.
        rows = []
        for column in ('term', 'reading'):
            match = f'e.{column}>=? AND e.{column}<?' if prefix else f'e.{column}=?'
            values = [term, term + '\U0010ffff'] if prefix else [term]
            rows.extend(self.store.rows('''SELECT e.id,e.term,e.reading,e.content_id,d.id AS dictionaryId,d.name AS dictionary,
                d.language,d.sort_order AS sortOrder FROM dictionary_entries e JOIN dictionaries d ON d.id=e.dictionary_id WHERE ''' +
                ' AND '.join([*conditions, match]) + ' ORDER BY d.sort_order,e.sequence LIMIT 100', [*params, *values]))
        result, seen = [], set()
        for row in rows:
            if row['id'] in seen:
                continue
            seen.add(row['id'])
            content = self.store.one('SELECT definitions_json,details_json,tags_json FROM dictionary_entry_content WHERE id=?', (row.pop('content_id'),)) or {}
            row.update(definitions=cleaned(decode(content.get('definitions_json'), [])), details=decode(content.get('details_json'), []), tags=decode(content.get('tags_json'), []))
            signature = (row['dictionaryId'], row['term'], row['reading'], encode(row['definitions']))
            if signature not in seen:
                result.append(row)
                seen.add(signature)
        return result

    def lookup(self, term, variants=(), prefix=False):
        """Look up a word and up to twenty combined forms, with frequency labels.

        Put exact written matches first, then respect dictionary order. Prefix
        search must also be enabled in settings. Include known-word/Anki links.
        The caller supplies base forms/readings; this method only standardizes
        character width and other equivalent Unicode forms (NFKC).
        """
        term = normalize(term)
        if not term:
            return {'term': '', 'entries': [], 'frequencies': [], 'knownTerm': {'exists': False}}
        query = list(dict.fromkeys([term, *variants]))[:20]
        entries, frequencies, seen = [], [], set()
        prefix = prefix and self.store.setting('dictionarySettings').get('prefixWildcardSearch', False)
        for variant in query:
            for entry in self.entries(variant, prefix=prefix):
                if entry['id'] not in seen:
                    seen.add(entry['id'])
                    entries.append(entry)
            for entry in self.store.rows('''SELECT f.term,f.reading,f.value,f.display_value AS displayValue,d.name AS dictionary,
                d.id AS dictionaryId,d.sort_order AS sortOrder FROM dictionary_frequencies f JOIN dictionaries d ON d.id=f.dictionary_id
                WHERE d.enabled_for_lookup=1 AND (f.term=? OR f.reading=?) ORDER BY d.sort_order,f.sequence LIMIT 100''', (variant, variant)):
                if entry not in frequencies:
                    frequencies.append(entry)
        entries.sort(key=lambda e: (e['term'] != term, e['sortOrder']))
        frequencies.sort(key=lambda e: e['sortOrder'])
        known = self.store.known()
        match = next((q for q in query if q in known), None)
        meta = known.get(match, {})
        return {'term': term, 'entries': entries, 'frequencies': frequencies, 'queryTerms': query,
                'knownTerm': {'exists': match is not None, 'term': match or term, 'ankiNoteIds': meta.get('ankiNoteIds', []), 'hasAnkiNote': bool(meta.get('ankiNoteIds'))}}
