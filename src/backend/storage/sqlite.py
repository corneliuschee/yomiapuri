"""Open SQLite, check its tables, and read/save the app's local data."""

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..config import defaults


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def decode(value, fallback=None):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return fallback


def merge(original, patch):
    """Apply a partial update while keeping keys that were not supplied.

    Nested dictionaries are merged too; lists and other values are replaced.
    A value of None is saved as None, not treated as a request to delete a key.
    """
    result = dict(original)
    for key, value in patch.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
    return result


class Store:
    """Share one locked database connection and save only the rows that change."""

    def __init__(self, data_dir):
        """Open the database and check it before accepting app requests.

        Enable SQLite's write-ahead log (WAL) and wait up to five seconds for a
        busy database. Back up databases from the earlier backend before adding
        Python tables. Refuse databases marked as incomplete, newer than we
        support, or damaged. Table changes happen in the opened database.
        """
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / 'yomiapuri.sqlite'
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('PRAGMA synchronous=NORMAL')
        if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_meta'").fetchone():
            meta = dict(self.db.execute('SELECT key,value FROM schema_meta'))
            if meta.get('migration_in_progress') == 'true' or int(meta.get('schema_version', 0)) > 2:
                raise RuntimeError('SQLite migration is incomplete or newer than this backend. Restore a validated backup.')
            if meta.get('python_backend') != '1':
                backup_dir = self.data_dir / 'backups'
                backup_dir.mkdir(exist_ok=True)
                with sqlite3.connect(backup_dir / f'before-python-{uuid.uuid4().hex[:8]}.sqlite') as backup:
                    self.db.backup(backup)
        if self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('SQLite integrity check failed.')
        self.db.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf8'))
        columns = {r['name'] for r in self.db.execute('PRAGMA table_info(dictionaries)')}
        for name, spec in {
            'language': "TEXT NOT NULL DEFAULT 'unknown'", 'format': "TEXT NOT NULL DEFAULT 'legacy'",
            'enabled_for_lookup': 'INTEGER NOT NULL DEFAULT 1', 'selected_for_wordbank': 'INTEGER NOT NULL DEFAULT 0',
            'sort_order': 'INTEGER NOT NULL DEFAULT 0', 'imported_at': "TEXT NOT NULL DEFAULT ''",
            'validation_status': "TEXT NOT NULL DEFAULT 'valid'", 'entries_count': 'INTEGER NOT NULL DEFAULT 0',
            'frequency_count': 'INTEGER NOT NULL DEFAULT 0',
        }.items():
            if name not in columns:
                self.db.execute(f'ALTER TABLE dictionaries ADD COLUMN {name} {spec}')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS python_learning_events(id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS python_token_cache(cache_key TEXT PRIMARY KEY, tokens_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS python_search_chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
                page INTEGER NOT NULL, chapter_id TEXT NOT NULL, chapter_title TEXT NOT NULL, text TEXT NOT NULL);
            CREATE VIRTUAL TABLE IF NOT EXISTS python_search_fts USING fts5(chunk_id UNINDEXED, terms);
            CREATE TABLE IF NOT EXISTS python_index_documents(document_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS known_term_tombstones(term TEXT PRIMARY KEY, deleted_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'deleted', origin_device_id TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS card_tombstones(id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'deleted', origin_device_id TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '');
        ''')
        with self.db:
            for key, value in [('schema_version', '2'), ('migration_in_progress', 'false'), ('python_backend', '1'), ('initialized', 'true')]:
                self.db.execute('INSERT OR REPLACE INTO schema_meta VALUES (?,?)', (key, value))
            for key, value in defaults().items():
                self.db.execute('INSERT OR IGNORE INTO app_settings VALUES (?,?,?)', (key, encode(value), now()))
            self.db.execute('INSERT OR IGNORE INTO templates VALUES (?,?,?,?)',
                            ('default-template', 0, encode({'id': 'default-template', 'name': 'Default Sentence Mining',
                             'fields': ['Expression', 'Reading', 'Sentence', 'Meaning', 'Audio', 'Image', 'Source']}), now()))
        if self.db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError('SQLite foreign key validation failed.')

    @contextmanager
    def transaction(self):
        """Save a group of SQL changes together, or undo them all on failure.

        Other threads wait while this block uses the connection. Keep network
        requests and text analysis outside it. Use the returned connection for
        all grouped writes; nesting these blocks does not create separate undo
        points (SQLite savepoints).
        """
        with self.lock:
            with self.db:
                yield self.db

    def rows(self, sql, args=()):
        """Return matching rows as dictionaries while holding the database lock.

        This loads every selected row. Use SQL LIMIT and choose columns when
        needed. Pass values in args rather than putting them into the SQL text.
        """
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        """Return the first matching row, or None, without loading the rest."""
        with self.lock:
            row = self.db.execute(sql, args).fetchone()
            return dict(row) if row is not None else None

    def write(self, sql, args=()):
        with self.transaction() as db:
            return db.execute(sql, args).rowcount

    def revision(self, domain):
        return (self.one('SELECT revision FROM store_revisions WHERE domain=?', (domain,)) or {}).get('revision', 0)

    def bump(self, domain, db=None):
        """Increase a change counter so caches know their saved data is outdated.

        Pass db to save this counter with the data change in the same transaction.
        Without db, the counter update gets its own short transaction.
        """
        sql = 'INSERT INTO store_revisions VALUES (?,1,?) ON CONFLICT(domain) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at'
        if db is None:
            self.write(sql, (domain, now()))
        else:
            db.execute(sql, (domain, now()))

    def setting(self, key):
        row = self.one('SELECT value_json FROM app_settings WHERE key=?', (key,))
        return merge(defaults().get(key, {}), decode(row['value_json'], {}) if row else {})

    def settings(self, key, patch):
        """Save changed settings in one group and increase its change counter."""
        with self.transaction() as db:
            value = merge(self.setting(key), patch)
            db.execute('INSERT OR REPLACE INTO app_settings VALUES (?,?,?)', (key, encode(value), now()))
            self.bump(key, db)
            return value

    def documents(self, trash=False):
        table = 'trash_documents' if trash else 'documents'
        return [self.document_metadata(r) for r in self.rows(f'SELECT id,title,filename,type,author,cover_path,source_path,metadata_json,created_at,updated_at FROM {table} ORDER BY order_index')]

    @staticmethod
    def document_metadata(row):
        return {**decode(row.get('metadata_json'), {}), **{k: row[k] for k in ['id', 'title', 'filename', 'type', 'author']},
                'coverPath': row['cover_path'], 'sourcePath': row['source_path'], 'createdAt': row['created_at'], 'updatedAt': row['updated_at']}

    def document(self, doc_id, body=False, trash=False):
        """Return one book's details, or None if the book is not in this table.

        body=True also loads all text and chapters, including older storage
        formats. Use BookService for reader pages; full-book reads are for
        import, sync, and export rather than ordinary page navigation.
        """
        table = 'trash_documents' if trash else 'documents'
        row = self.one(f'SELECT * FROM {table} WHERE id=?', (doc_id,))
        if not row:
            return None
        value = self.document_metadata(row)
        if body:
            body_table = 'trash_document_bodies' if trash else 'document_bodies'
            content = self.one(f'SELECT text,chapters_json FROM {body_table} WHERE document_id=?', (doc_id,)) or row
            value.update(text=content['text'], chapters=decode(content['chapters_json'], []))
        return value

    def save_document(self, doc):
        """Add or update a book and, when supplied, replace its complete text.

        A text key replaces the body and clears saved pages. Title/detail edits
        alone keep those pages and the book's order. Save the documents change
        counter in the same transaction so caches can detect either change.
        """
        import hashlib
        with self.transaction() as db:
            order = self.one('SELECT MIN(order_index) AS n FROM documents')['n'] or 0
            db.execute('''INSERT INTO documents(id,order_index,title,filename,type,author,cover_path,source_path,text,chapters_json,metadata_json,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,
                cover_path=excluded.cover_path,source_path=excluded.source_path,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at''',
                (doc['id'], order - 1, doc['title'], doc['filename'], doc['type'], doc.get('author', ''), doc.get('coverPath', ''),
                 doc.get('sourcePath', ''), '', '[]', encode({k: v for k, v in doc.items() if k not in {'text','chapters'}}), doc.get('createdAt', now()), doc.get('updatedAt', now())))
            if 'text' in doc:
                text, chapters = doc['text'], encode(doc.get('chapters', []))
                digest = hashlib.sha256((text + chapters).encode()).hexdigest()
                db.execute('INSERT OR REPLACE INTO document_bodies VALUES (?,?,?,?,?,?)', (doc['id'], text, chapters, len(text), digest, now()))
                db.execute('DELETE FROM document_pages WHERE document_id=?', (doc['id'],))
            self.bump('documents', db)

    def known(self):
        return {r['term']: decode(r['meta_json'], {}) for r in self.rows('SELECT term,meta_json FROM known_terms ORDER BY order_index')}

    def add_terms(self, terms, metadata=None):
        """Save known words and Anki note links; return the words that are new.

        Callers clean up word forms first. Re-adding a deleted word removes its
        Trash/deletion records. Existing words keep their order. Update the
        known-word change counter without clearing saved book tokens.
        """
        added = []
        with self.transaction() as db:
            count = self.one('SELECT COALESCE(MAX(order_index),0) AS n FROM known_terms')['n']
            for term in dict.fromkeys(terms):
                if not term:
                    continue
                old = self.one('SELECT meta_json FROM known_terms WHERE term=?', (term,))
                meta = merge(decode(old['meta_json'], {}) if old else {'addedAt': now()}, (metadata or {}).get(term, {}))
                if old:
                    meta['ankiNoteIds'] = list(dict.fromkeys(decode(old['meta_json'], {}).get('ankiNoteIds', []) + meta.get('ankiNoteIds', [])))
                else:
                    added.append(term)
                count += 1
                db.execute('''INSERT INTO known_terms VALUES (?,?,?,?) ON CONFLICT(term) DO UPDATE SET meta_json=excluded.meta_json,updated_at=excluded.updated_at''', (term, count, encode(meta), now()))
                db.execute('DELETE FROM trash_known_terms WHERE term=?', (term,))
                db.execute('DELETE FROM known_term_tombstones WHERE term=?', (term,))
            self.bump('known_terms', db)
        return added

    def delete_terms(self, terms):
        """Move known words to Trash and save deletion records for device sync.

        Ignore words that are not stored. Return the removed words and update
        the change counter so the reader checks known-word status again.
        """
        deleted = []
        with self.transaction() as db:
            for term in dict.fromkeys(terms):
                row = self.one('SELECT * FROM known_terms WHERE term=?', (term,))
                if not row:
                    continue
                deleted.append(term)
                entry = {'term': term, 'meta': decode(row['meta_json'], {}), 'deletedAt': now()}
                db.execute('INSERT OR REPLACE INTO trash_known_terms VALUES (?,?,?,?)', (term, row['order_index'], encode(entry), now()))
                db.execute('INSERT OR REPLACE INTO known_term_tombstones(term,deleted_at) VALUES (?,?)', (term, now()))
                db.execute('DELETE FROM known_terms WHERE term=?', (term,))
            self.bump('known_terms', db)
        return deleted

    def progress(self, doc_id=None):
        rows = self.rows('SELECT document_id,payload_json FROM reading_progress' + (' WHERE document_id=?' if doc_id else ''), (doc_id,) if doc_id else ())
        values = {r['document_id']: decode(r['payload_json'], {}) for r in rows}
        return values.get(doc_id, {}) if doc_id else values

    def close(self):
        with self.lock:
            self.db.close()

    def event(self, kind, payload):
        self.write('INSERT INTO python_learning_events VALUES (?,?,?,?)', (str(uuid.uuid4()), kind, encode(payload), now()))
