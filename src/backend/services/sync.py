"""Synchronize source records and media with Supabase on explicit user requests."""

import os
import hashlib
import mimetypes
import threading
import uuid
from urllib.parse import quote

import httpx

from ..storage.sqlite import decode, encode, now


class SyncService:
    def __init__(self, store, books):
        self.store, self.books = store, books
        self.client = httpx.Client(timeout=60)
        self.lock = threading.Lock()

    def close(self):
        self.client.close()

    def settings(self):
        s = self.store.setting('sync')
        s['supabaseUrl'] = s.get('supabaseUrl') or os.getenv('SUPABASE_URL', '')
        s['supabaseAnonKey'] = s.get('supabaseAnonKey') or os.getenv('SUPABASE_PUBLISHABLE_KEY', os.getenv('SUPABASE_ANON_KEY', ''))
        return s

    def status(self):
        s = self.store.setting('sync')
        url = s.get('supabaseUrl') or os.getenv('SUPABASE_URL', '')
        key = s.get('supabaseAnonKey') or os.getenv('SUPABASE_PUBLISHABLE_KEY', os.getenv('SUPABASE_ANON_KEY', ''))
        keys = ['enabled', 'userId', 'userEmail', 'deviceId', 'deviceName', 'lastSyncAt', 'lastPushAt', 'lastPullAt', 'lastError', 'status']
        return {**{k: s.get(k, '') for k in keys}, 'supabaseUrl': url, 'configured': bool(url and key),
                'hasUrl': bool(url), 'hasAnonKey': bool(key), 'signedIn': bool(s.get('accessToken') and s.get('userId'))}

    def configure(self, body):
        self.store.settings('sync', {k: v for k, v in body.items() if k in {'enabled','supabaseUrl','supabaseAnonKey','deviceName'}})
        return self.status()

    def sign_out(self):
        try:
            if self.settings().get('accessToken'):
                self.request('POST', '/auth/v1/logout', retry=False)
        except (ValueError, httpx.HTTPError):
            pass
        self.store.settings('sync', {'enabled': False, 'accessToken': '', 'refreshToken': '', 'userId': '', 'userEmail': '', 'status': 'disabled', 'lastError': ''})
        return self.status()

    def request(self, method, path, retry=True, **kwargs):
        s = self.settings()
        if not s['supabaseUrl'] or not s['supabaseAnonKey']:
            raise ValueError('Supabase URL and publishable key are required.')
        extra_headers = kwargs.pop('headers', {})
        headers = {'apikey': s['supabaseAnonKey'], 'Authorization': 'Bearer ' + (s.get('accessToken') or s['supabaseAnonKey']), **extra_headers}
        response = self.client.request(method, s['supabaseUrl'].rstrip('/') + path, headers=headers, **kwargs)
        if response.status_code == 401 and retry and s.get('refreshToken'):
            session = self.request('POST', '/auth/v1/token?grant_type=refresh_token', retry=False, json={'refresh_token': s['refreshToken']}).json()
            self.save_session(session)
            return self.request(method, path, retry=False, headers=extra_headers, **kwargs)
        if response.is_error:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            raise ValueError(payload.get('message') or payload.get('error_description') or f'Supabase request failed ({response.status_code}).')
        return response

    def save_session(self, session):
        self.store.settings('sync', {'accessToken': session['access_token'], 'refreshToken': session.get('refresh_token', ''),
                                    'userId': session['user']['id'], 'userEmail': session['user'].get('email', ''),
                                    'deviceId': self.settings().get('deviceId') or str(uuid.uuid4()), 'enabled': True, 'status': 'signed-in', 'lastError': ''})

    def sign_in(self, body):
        try:
            self.configure({k: v for k, v in body.items() if v})
            response = self.request('POST', '/auth/v1/token?grant_type=password', retry=False, json={'email': body.get('email', ''), 'password': body.get('password', '')})
            self.save_session(response.json())
            return self.status()
        except Exception as error:
            self.store.settings('sync', {'status': 'error', 'lastError': str(error)})
            raise

    def select(self, table):
        user = self.settings().get('userId')
        if not user:
            raise ValueError('Sign in to Supabase before syncing.')
        rows = []
        while True:
            page = self.request('GET', '/rest/v1/' + table, params={'user_id': 'eq.' + user, 'select': '*', 'offset': len(rows), 'limit': 500}).json()
            rows.extend(page)
            if len(page) < 500:
                return rows

    def upsert(self, table, rows, conflict):
        for start in range(0, len(rows), 100):
            self.request('POST', '/rest/v1/' + table, params={'on_conflict': conflict}, headers={'Prefer': 'resolution=merge-duplicates,return=minimal'}, json=rows[start:start + 100])

    def run(self, action):
        if not self.lock.acquire(blocking=False):
            raise FileExistsError('A sync operation is already running.')
        try:
            # Merge remote records before sending local versions, including explicit push.
            self.pull()
            if action != 'pull':
                self.push()
            self.store.settings('sync', {'lastSyncAt': now(), 'status': 'synced', 'lastError': ''})
            return self.status()
        except Exception as error:
            self.store.settings('sync', {'status': 'error', 'lastError': str(error)})
            raise
        finally:
            self.lock.release()

    def pull(self):
        settings = self.select('app_settings')
        tombstones = next((r['value'] for r in settings if r['key'] == 'documentTombstones'), {})
        for doc_id, deleted_at in tombstones.items():
            local = self.store.document(doc_id)
            if local and local['updatedAt'] > deleted_at:
                continue
            if local:
                self.books.trash(doc_id)
            self.store.write('INSERT INTO document_tombstones(document_id,deleted_at) VALUES (?,?) ON CONFLICT(document_id) DO UPDATE SET deleted_at=MAX(deleted_at,excluded.deleted_at)', (doc_id, deleted_at))
        for row in self.select('documents'):
            local = self.store.document(row['id'])
            tomb = self.store.one('SELECT deleted_at FROM document_tombstones WHERE document_id=?', (row['id'],))
            if tomb and tomb['deleted_at'] >= row['updated_at']:
                continue
            if not local or row['updated_at'] > local['updatedAt']:
                self.store.save_document({'id': row['id'], 'title': row['title'], 'filename': row['filename'], 'type': row['type'],
                                          'coverPath': row.get('cover_path', ''), 'sourcePath': row.get('source_path', ''),
                                          'createdAt': row['created_at'], 'updatedAt': row['updated_at'], **row.get('content', {})})
                self.store.write('UPDATE documents SET order_index=? WHERE id=?', (row.get('order_index', 0), row['id']))
                self.store.write('DELETE FROM document_tombstones WHERE document_id=?', (row['id'],))
        for row in self.select('reading_progress'):
            old = self.store.progress(row['document_id'])
            if self.store.document(row['document_id']) and row['updated_at'] > old.get('updatedAt', ''):
                value = {**old, 'page': row['page'], 'chapterId': row.get('chapter_id'), 'mode': row.get('mode'), 'percentage': row.get('percentage'), 'scrollTop': row.get('scroll_top'), 'zoom': row.get('zoom', 100), 'updatedAt': row['updated_at']}
                self.store.write('INSERT OR REPLACE INTO reading_progress VALUES (?,?,?)', (row['document_id'], encode(value), row['updated_at']))
        for row in self.select('reader_annotations'):
            old = self.store.progress(row['document_id'])
            if self.store.document(row['document_id']) and row['updated_at'] >= old.get('updatedAt', ''):
                self.store.write('INSERT OR REPLACE INTO reading_progress VALUES (?,?,?)', (row['document_id'], encode({**old, **row['payload']}), row['updated_at']))
        for row in self.select('known_terms'):
            old = self.store.one('SELECT updated_at FROM known_terms WHERE term=?', (row['term'],))
            tomb = self.store.one('SELECT deleted_at FROM known_term_tombstones WHERE term=?', (row['term'],))
            if row['updated_at'] <= max((old or {}).get('updated_at', ''), (tomb or {}).get('deleted_at', '')):
                continue
            if row.get('deleted_at'):
                self.store.delete_terms([row['term']])
                self.store.write('INSERT OR REPLACE INTO known_term_tombstones(term,deleted_at) VALUES (?,?)', (row['term'], row['deleted_at']))
            else:
                self.store.add_terms([row['term']], {row['term']: row.get('meta', {})})
                self.store.write('UPDATE known_terms SET updated_at=? WHERE term=?', (row['updated_at'], row['term']))
        for row in self.select('cards'):
            old = self.store.one('SELECT updated_at FROM cards WHERE id=?', (row['id'],))
            if not old or row['updated_at'] > old['updated_at']:
                self.store.write('INSERT OR REPLACE INTO cards VALUES (?,?,?,?)', (row['id'], 0, encode(row['payload']), row['updated_at']))
        for row in settings:
            if row['key'] not in {'anki', 'media', 'dictionarySettings', 'templates'}:
                continue
            local = self.store.one('SELECT updated_at FROM app_settings WHERE key=?', (row['key'],))
            if local and row['updated_at'] <= local['updated_at']:
                continue
            if row['key'] == 'templates':
                with self.store.transaction() as db:
                    for i, value in enumerate(row['value']):
                        db.execute('INSERT OR REPLACE INTO templates VALUES (?,?,?,?)', (value['id'], i, encode(value), row['updated_at']))
            else:
                self.store.settings(row['key'], row['value'])
                self.store.write('UPDATE app_settings SET updated_at=? WHERE key=?', (row['updated_at'], row['key']))
        root = (self.store.data_dir / 'media').resolve()
        for file in self.select('document_files'):
            target = (root / file['filename']).resolve()
            if not target.is_relative_to(root) or target == root:
                raise ValueError('Unsafe remote media path.')
            if not target.exists():
                data = self.request('GET', '/storage/v1/object/authenticated/book-files/' + quote(file['storage_path'], safe='/')).content
                if file.get('file_hash') and hashlib.sha256(data).hexdigest() != file['file_hash']:
                    raise ValueError('Downloaded book failed its checksum.')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        for event in self.select('learning_events'):
            self.store.write('INSERT OR IGNORE INTO python_learning_events VALUES (?,?,?,?)', (event['id'], event['type'], encode(event['payload']), event['created_at']))
        self.store.settings('sync', {'lastPullAt': now()})

    def push(self):
        s = self.settings()
        user = s['userId']
        self.upsert('profiles', [{'id': user, 'email': s.get('userEmail', ''), 'updated_at': now()}], 'id')
        self.upsert('devices', [{'user_id': user, 'device_id': s['deviceId'], 'name': s.get('deviceName', 'This device'), 'platform': os.name, 'last_seen_at': now()}], 'user_id,device_id')
        tombstones = {r['document_id']: r['deleted_at'] for r in self.store.rows('SELECT document_id,deleted_at FROM document_tombstones')}
        self.upsert('app_settings', [{'user_id': user, 'key': 'documentTombstones', 'value': tombstones, 'updated_at': now()}], 'user_id,key')
        for doc_id in tombstones:
            if self.store.document(doc_id):
                continue
            for table, field in [('reading_progress','document_id'), ('reader_annotations','document_id'), ('cards','document_id'), ('documents','id')]:
                self.request('DELETE', '/rest/v1/' + table, params={'user_id': 'eq.' + user, field: 'eq.' + doc_id})
        for index, meta in enumerate(self.store.documents()):
            doc = self.store.document(meta['id'], body=True)
            self.upsert('documents', [{'user_id': user, 'id': doc['id'], 'title': doc['title'], 'filename': doc['filename'], 'type': doc['type'],
                                      'order_index': index, 'cover_path': doc.get('coverPath', ''), 'source_path': doc.get('sourcePath', ''),
                                      'file_hash': doc.get('contentHash') or hashlib.sha256(doc['text'].encode()).hexdigest(),
                                      'content': {k: doc.get(k, '' if k != 'chapters' else []) for k in ['text','chapters','author']},
                                      'created_at': doc['createdAt'], 'updated_at': doc['updatedAt']}], 'user_id,id')
            paths = {doc.get('sourcePath', ''), doc.get('coverPath', '')}
            def assets(blocks):
                for b in blocks:
                    paths.add(b.get('src', ''))
                    assets(b.get('blocks', []))
            for chapter in doc.get('chapters', []):
                assets(chapter.get('blocks', []))
            root = (self.store.data_dir / 'media').resolve()
            for path in paths:
                if not path.startswith('/media/'):
                    continue
                local = (root / path[7:]).resolve()
                if not local.is_relative_to(root) or not local.is_file():
                    continue
                data = local.read_bytes()
                key = user + '/media/' + path[7:]
                content_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'
                self.request('POST', '/storage/v1/object/book-files/' + quote(key, safe='/'), content=data, headers={'Content-Type': content_type, 'x-upsert': 'true'})
                self.upsert('document_files', [{'user_id': user, 'file_hash': hashlib.sha256(data).hexdigest(), 'filename': path[7:], 'storage_path': key,
                                                'content_type': content_type, 'size_bytes': len(data), 'created_at': doc['createdAt']}], 'user_id,file_hash')
            value = self.store.progress(doc['id'])
            if value:
                stamp = value.get('updatedAt') or now()
                self.upsert('reading_progress', [{'user_id': user, 'document_id': doc['id'], 'page': value.get('page', 0), 'chapter_id': value.get('chapterId', ''),
                                                  'mode': value.get('mode', 'scroll'), 'percentage': value.get('percentage', 0), 'scroll_top': value.get('scrollTop', 0), 'zoom': value.get('zoom', 100), 'updated_at': stamp}], 'user_id,document_id')
                self.upsert('reader_annotations', [{'user_id': user, 'document_id': doc['id'], 'kind': 'reader_state',
                                                    'payload': {k: value.get(k, [] if k == 'bookmarks' else {}) for k in ['bookmarks','highlights']}, 'updated_at': stamp}], 'user_id,document_id,kind')
        terms = [{'user_id': user, 'term': r['term'], 'meta': decode(r['meta_json'], {}), 'deleted_at': None, 'updated_at': r['updated_at']} for r in self.store.rows('SELECT term,meta_json,updated_at FROM known_terms')]
        terms += [{'user_id': user, 'term': r['term'], 'meta': {}, 'deleted_at': r['deleted_at'], 'updated_at': r['deleted_at']} for r in self.store.rows('SELECT term,deleted_at FROM known_term_tombstones')]
        self.upsert('known_terms', terms, 'user_id,term')
        cards = []
        for r in self.store.rows('SELECT id,payload_json,updated_at FROM cards'):
            c = decode(r['payload_json'], {})
            if self.store.document(c.get('documentId')):
                cards.append({'user_id': user, 'id': r['id'], 'document_id': c.get('documentId'), 'expression': c.get('expression', ''),
                              'dictionary_form': c.get('dictionaryForm', ''), 'anki_note_id': c.get('ankiNoteId'), 'payload': c, 'created_at': c.get('createdAt', r['updated_at']), 'updated_at': r['updated_at']})
        self.upsert('cards', cards, 'user_id,id')
        settings = []
        for r in self.store.rows("SELECT key,value_json,updated_at FROM app_settings WHERE key IN ('anki','media','dictionarySettings')"):
            value = decode(r['value_json'], {})
            if r['key'] == 'anki':
                value = {k: v for k, v in value.items() if k not in {'connectUrl', 'ankiExecutablePath'}}
            settings.append({'user_id': user, 'key': r['key'], 'value': value, 'updated_at': r['updated_at']})
        templates = self.store.rows('SELECT payload_json,updated_at FROM templates ORDER BY order_index')
        if templates:
            settings.append({'user_id': user, 'key': 'templates', 'value': [decode(r['payload_json'], {}) for r in templates], 'updated_at': max(r['updated_at'] for r in templates)})
        self.upsert('app_settings', settings, 'user_id,key')
        self.upsert('learning_events', [{'user_id': user, 'id': r['id'], 'type': r['type'], 'payload': decode(r['payload_json'], {}), 'created_at': r['created_at']} for r in self.store.rows('SELECT * FROM python_learning_events ORDER BY created_at DESC LIMIT 2000')], 'user_id,id')
        self.store.settings('sync', {'lastPushAt': now()})
