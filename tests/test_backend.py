"""Isolated native backend regressions. Never opens the user's data directory."""

import json
import sqlite3
import tempfile
import unittest
import re
import io
import zipfile
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from src.backend.main import create_app
from src.backend.storage.sqlite import encode, now


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.directory.name))
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.directory.cleanup()

    def book(self, text='図書館で本を読む。', filename='book.txt'):
        response = self.client.post('/api/documents', files={'book': (filename, text.encode())})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()['document']['id']

    def test_reader_repeated_open_and_known_state(self):
        doc = self.book()
        initial = self.client.get('/api/documents/' + doc).json()
        self.assertIn('<rt>', initial['pages'][0]['html'])
        self.client.post('/api/known-terms', json={'term': '図書館'})
        for _ in range(3):
            rendered = self.client.get('/api/documents/' + doc)
            self.assertEqual(rendered.status_code, 200)
            self.assertNotIn('>図書館<rt>', rendered.json()['pages'][0]['html'])
        self.client.request('DELETE', '/api/known-terms', json={'terms': ['図書館']})
        self.assertIn('>図書館<rt>', self.client.get('/api/documents/' + doc).json()['pages'][0]['html'])
        state = self.client.get('/api/state').json()
        self.assertNotIn('text', state['documents'][0])
        self.assertNotIn('chapters', state['documents'][0])

    def test_progress_trash_restore(self):
        doc = self.book()
        endpoint = '/api/documents/' + doc + '/progress'
        self.client.post(endpoint, json={'bookmarks': [{'page': 0}], 'mode': 'paged', 'chapterId': 'chapter-1'})
        result = self.client.post(endpoint, json={'page': 2, 'zoom': 999}).json()
        self.assertEqual(result['zoom'], 175)
        self.assertEqual(result['bookmarks'], [{'page': 0}])
        self.client.delete('/api/documents/' + doc)
        self.assertEqual(self.client.get('/api/documents/' + doc).status_code, 404)
        self.assertEqual(self.client.post('/api/trash/documents/' + doc + '/restore').status_code, 200)
        self.assertEqual(self.client.get('/api/documents/' + doc).json()['progress']['bookmarks'], [{'page': 0}])

    def test_dictionary_and_meanings(self):
        entries = [{'term': '図書館', 'reading': 'としょかん', 'definitions': ['library']},
                   {'term': '考える', 'reading': 'かんがえる', 'definitions': ['to think']}]
        response = self.client.post('/api/dictionaries', files={'dictionary': ('test.json', encode(entries).encode())})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(self.client.get('/api/dictionary', params={'term': '図書館'}).json()['entries'][0]['definitions'], ['library'])
        self.assertEqual(self.client.get('/api/dictionary', params={'term': '考えられる'}).json()['entries'][0]['term'], '考える')
        self.client.post('/api/known-terms', json={'term': '図書館'})
        self.assertEqual(self.client.get('/api/known-terms').json()['terms'][0]['dictionaryEntries'][0]['definitions'], ['library'])

    def test_author_ruby(self):
        doc = self.book('[[RUBY:周|あまね]]は笑った。周は本を読んだ。')
        rendered = self.client.get('/api/documents/' + doc).json()['pages'][0]['html']
        self.assertIn('class="author-ruby"', rendered)
        self.assertEqual(rendered.count('<rt>あまね</rt>'), 1)
        self.assertNotIn('<rt>しゅう</rt>', rendered)

    def test_incremental_search_and_soft_delete_filter(self):
        first = self.book('愛の告白を聞いた。')
        second = self.book('今日は図書館へ行く。', 'second.txt')
        result = self.client.post('/api/search/index/refresh').json()
        self.assertEqual(result['inserted'], 2)
        result = self.client.post('/api/search/index/refresh').json()
        self.assertEqual(result['inserted'], 0)
        self.assertEqual(result['skipped'], 2)
        result = self.client.post('/api/search/fts', json={'query': '告白'}).json()
        self.assertEqual(result['results'][0]['documentId'], first)
        self.client.delete('/api/documents/' + first)
        self.assertEqual(self.client.post('/api/search/fts', json={'query': '告白'}).json()['results'], [])
        for query in ['"', '*', 'NOT OR', 'a-b']:
            self.assertEqual(self.client.post('/api/search/fts', json={'query': query}).status_code, 200)

    def test_existing_page_indices_survive(self):
        doc = self.book()
        s = self.app.state.store
        s.write('INSERT INTO document_pages VALUES (?,?,?,?,?,?,?,?,?)', ('legacy', doc, 0, 'c1', 'Chapter', '図書館', '<p>old renderer</p>', 'hash', now()))
        self.assertEqual(self.client.get('/api/documents/' + doc).status_code, 200)
        self.assertEqual(s.one('SELECT id FROM document_pages WHERE document_id=?', (doc,))['id'], 'legacy')

    def test_assistant_disabled_stream_finishes(self):
        self.app.state.store.settings('ai', {'translation': {'enabled': False}})
        response = self.client.post('/api/reader/assistant/stream', json={'question': 'Translate this: 本です。'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('event: meta', response.text)
        self.assertIn('event: done', response.text)
        self.assertIn('disabled', response.text)
        self.assertFalse(self.app.state.ai.status()['running'])

    def test_legacy_metadata_recovered_without_repaginating(self):
        doc = self.book('[[RUBY:周|あまね]]は笑った。')
        s = self.app.state.store
        s.write('UPDATE documents SET metadata_json=? WHERE id=?', ('{}', doc))
        s.write('INSERT INTO document_pages VALUES (?,?,?,?,?,?,?,?,?)',
                ('legacy-name', doc, 0, 'chapter-1', 'Chapter', '周は笑った。', '', 'hash', now()))
        result = self.client.get('/api/documents/' + doc).json()
        self.assertEqual(result['authorRubyReadings']['周'], 'あまね')
        self.assertNotIn('<rt>しゅう</rt>', result['pages'][0]['html'])
        self.assertEqual(s.one('SELECT id FROM document_pages WHERE document_id=?', (doc,))['id'], 'legacy-name')

    def test_permanent_delete_prunes_only_target(self):
        first = self.book('告白した。')
        second = self.book('本を読んだ。', 'second.txt')
        self.client.post('/api/search/index/refresh')
        self.client.delete('/api/documents/' + first)
        self.assertEqual(self.client.delete('/api/trash/documents/' + first).status_code, 200)
        s = self.app.state.store
        self.assertIsNone(s.one('SELECT id FROM python_search_chunks WHERE document_id=?', (first,)))
        self.assertIsNotNone(s.one('SELECT id FROM python_search_chunks WHERE document_id=?', (second,)))
        self.assertIsNotNone(s.one('SELECT document_id FROM document_tombstones WHERE document_id=?', (first,)))

    def test_empty_trash_leaves_active_books_and_search_untouched(self):
        removed = [self.book('First book.', 'first.txt'), self.book('Second book.', 'second.txt')]
        active = self.book('Active book.', 'active.txt')
        self.assertEqual(self.client.post('/api/search/index/refresh').status_code, 200)
        for doc in removed:
            self.client.post('/api/documents/' + doc + '/progress', json={'page': 0, 'bookmarks': [{'page': 0}]})
            self.assertEqual(self.client.delete('/api/documents/' + doc).status_code, 200)
        self.assertEqual(self.client.delete('/api/trash/documents/' + active).status_code, 404)
        self.assertEqual(self.client.delete('/api/trash/documents/missing').status_code, 404)
        response = self.client.delete('/api/trash/documents')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'deleted': 2})
        s = self.app.state.store
        for doc in removed:
            for table, key in [('trash_documents', 'id'), ('trash_document_bodies', 'document_id'),
                               ('document_pages', 'document_id'), ('reading_progress', 'document_id'),
                               ('python_search_chunks', 'document_id'), ('python_index_documents', 'document_id')]:
                self.assertIsNone(s.one(f'SELECT 1 FROM {table} WHERE {key}=?', (doc,)))
            self.assertIsNotNone(s.one('SELECT 1 FROM document_tombstones WHERE document_id=?', (doc,)))
        self.assertIsNone(s.one('SELECT 1 FROM python_search_fts WHERE chunk_id NOT IN (SELECT id FROM python_search_chunks)'))
        self.assertEqual(self.client.post('/api/search/fts', json={'query': 'Active'}).json()['results'][0]['documentId'], active)
        self.assertEqual(self.client.get('/api/documents/' + active).status_code, 200)
        self.assertEqual(self.client.delete('/api/trash/documents').json(), {'deleted': 0})

    def test_failed_permanent_delete_rolls_back_search_cleanup(self):
        doc = self.book('Rollback example.')
        self.client.post('/api/search/index/refresh')
        self.client.delete('/api/documents/' + doc)
        s = self.app.state.store
        before = s.rows('SELECT * FROM python_search_fts')
        revision = s.revision('documents')
        s.write("CREATE TRIGGER reject_trash_delete BEFORE DELETE ON trash_documents BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        try:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'test failure'):
                self.app.state.books.delete_permanently(doc)
            self.assertIsNotNone(s.document(doc, body=True, trash=True))
            self.assertEqual(s.rows('SELECT * FROM python_search_fts'), before)
            self.assertIsNotNone(s.one('SELECT id FROM python_search_chunks WHERE document_id=?', (doc,)))
            self.assertIsNotNone(s.one('SELECT document_id FROM python_index_documents WHERE document_id=?', (doc,)))
            self.assertEqual(s.revision('documents'), revision)
        finally:
            s.write('DROP TRIGGER reject_trash_delete')

    def test_anki_auto_launch_keeps_diagnostics_in_own_log(self):
        executable = Path(self.directory.name) / 'anki.exe'
        executable.touch()
        self.app.state.store.settings('anki', {'autoLaunchAnki': True, 'ankiExecutablePath': str(executable)})
        calls = []

        def transport(request):
            calls.append(request)
            if len(calls) == 1:
                raise httpx.ConnectError('Anki is not started.', request=request)
            return httpx.Response(200, json={'result': 6, 'error': None})

        service = self.app.state.anki
        service.client.close()
        service.client = httpx.Client(transport=httpx.MockTransport(transport))

        def launch(args, **kwargs):
            self.assertEqual(args, [str(executable)])
            self.assertEqual(kwargs['stderr'], -2)  # subprocess.STDOUT
            self.assertEqual(Path(kwargs['stdout'].name), Path(self.directory.name) / 'logs' / 'anki.log')
            kwargs['stdout'].write(b'Anki add-on compatibility warning\n')

        with patch('src.backend.services.anki.subprocess.Popen', side_effect=launch) as spawned, \
                patch('src.backend.services.anki.time.sleep'):
            self.assertEqual(service.connect('version'), 6)
            spawned.assert_called_once()
        log = Path(self.directory.name) / 'logs' / 'anki.log'
        self.assertEqual(log.read_text(), 'Anki add-on compatibility warning\n')

    def test_anki_running_errors_still_reach_the_app(self):
        service = self.app.state.anki
        service.client.close()
        service.client = httpx.Client(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'result': None, 'error': 'cannot create note because it is a duplicate'})))
        with patch('src.backend.services.anki.subprocess.Popen') as spawned:
            response = self.client.get('/api/anki/connect')
            self.assertEqual(response.status_code, 400)
            self.assertIn('duplicate', response.json()['error'])
            spawned.assert_not_called()
        self.assertFalse((Path(self.directory.name) / 'logs' / 'anki.log').exists())

    def test_anki_reviewed_fields_and_retry(self):
        doc = self.book()
        calls = []

        def transport(request):
            body = json.loads(request.content)
            calls.append(body)
            return httpx.Response(200, json={'result': 12345 if body['action'] == 'addNote' else [], 'error': None})

        service = self.app.state.anki
        service.client.close()
        service.client = httpx.Client(transport=httpx.MockTransport(transport))
        body = {'requestId': 'test-export', 'documentId': doc, 'expression': '図書館', 'dictionaryForm': '図書館',
                'modelName': 'Basic', 'deckName': 'Test', 'fields': {'Expression': '図書館', 'Sentence': '図書館に行く。', 'Meaning': 'my edited definition'}}
        for _ in range(2):
            result = self.client.post('/api/anki/export-card', json=body)
            self.assertEqual(result.status_code, 201, result.text)
            self.assertEqual(result.json()['fields']['Meaning'], 'my edited definition')
            self.assertIn('target-word', result.json()['fields']['Sentence'])
        self.assertEqual(len(calls), 1)
        self.assertNotIn('Key', calls[0]['params']['note']['fields'])
        self.assertEqual(self.app.state.store.known()['図書館']['ankiNoteIds'], [12345])

    def test_anki_mining_key_preview_and_stale_export(self):
        doc = self.book()
        notes = []

        def transport(request):
            body = json.loads(request.content)
            if body['action'] == 'modelFieldNames':
                result = ['Key', 'Word', 'WordReading', 'Sentence', 'PrimaryDefinition']
            else:
                self.assertEqual(body['action'], 'addNote')
                note = body['params']['note']
                if not note['fields']['Key'].strip():
                    return httpx.Response(200, json={'result': None, 'error': 'cannot create note because it is empty'})
                notes.append(note)
                result = 20000 + len(notes)
            return httpx.Response(200, json={'result': result, 'error': None})

        service = self.app.state.anki
        service.client.close()
        service.client = httpx.Client(transport=httpx.MockTransport(transport))
        candidate = {'documentId': doc, 'expression': '図書館', 'reading': 'としょかん',
                     'modelName': 'JP Mining Note', 'deckName': 'Test'}
        response = self.client.post('/api/anki/card-preview', json=candidate)
        self.assertEqual(response.status_code, 200, response.text)
        preview = response.json()
        self.assertEqual(preview['fieldMap']['Expression'], 'Word')
        self.assertEqual(preview['values']['Word'], '図書館')
        self.assertEqual(preview['values']['Key'], '図書館')

        for key_value, expected in [('', '図書館'), ('   ', '図書館'), ('my-custom-key', 'my-custom-key')]:
            with self.subTest(key=key_value):
                fields = {**preview['values'], 'Key': key_value, 'PrimaryDefinition': 'edited definition'}
                response = self.client.post('/api/anki/export-card', json={**candidate, 'fields': fields,
                                           'fieldMapUpdates': preview['fieldMap']})
                self.assertEqual(response.status_code, 201, response.text)
                exported = response.json()
                self.assertEqual(exported['fields']['Key'], expected)
                self.assertEqual(exported['fields']['Word'], '図書館')
                self.assertEqual(exported['fields']['PrimaryDefinition'], 'edited definition')
                self.assertFalse(notes[-1]['options']['allowDuplicate'])
                journal = self.app.state.store.one('SELECT status FROM anki_export_journal WHERE id=?', (exported['id'],))
                self.assertEqual(journal['status'], 'complete')

    def test_documented_routes_are_registered(self):
        expected = json.loads(Path(__file__).with_name('api_contract.json').read_text())
        actual = {(method, re.sub(r'\{[^}]+\}', ':id', route.path))
                  for route in self.app.routes if hasattr(route, 'methods')
                  and route.path.startswith('/api/') and route.path != '/api/{missing:path}'
                  for method in route.methods}
        self.assertEqual(set(map(tuple, expected)), actual)

    def test_anki_vocabulary_sync_is_additive_and_idempotent(self):
        store = self.app.state.store
        store.add_terms(['本'])
        store.settings('anki', {'deckName': 'Japanese', 'modelFieldMaps': {'Custom': {'Expression': '単語'}}})
        doc = self.book()
        self.assertIn('>図書館<rt>', self.client.get('/api/documents/' + doc).json()['pages'][0]['html'])
        notes = [{'noteId': 101, 'modelName': 'Custom', 'fields': {'単語': {'value': '<ruby>図書館<rt>としょかん</rt></ruby>'},
                                                                 'Meaning': {'value': 'library'}}}]
        calls = []

        def transport(request):
            body = json.loads(request.content)
            calls.append(body)
            result = [n['noteId'] for n in notes] if body['action'] == 'findNotes' else notes
            return httpx.Response(200, json={'result': result, 'error': None})

        self.app.state.anki.client.close()
        self.app.state.anki.client = httpx.Client(transport=httpx.MockTransport(transport))
        endpoint = '/api/anki/sync-vocabulary'
        first = self.client.post(endpoint, json={})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['added'], 1)
        self.assertEqual(first.json()['total'], 2)
        self.assertEqual(calls[0]['params']['query'], 'deck:"Japanese" prop:reps>0')
        self.assertNotIn('>図書館<rt>', self.client.get('/api/documents/' + doc).json()['pages'][0]['html'])
        revision = store.revision('known_terms')
        self.assertEqual(self.client.post(endpoint, json={}).json()['added'], 0)
        self.assertEqual(store.revision('known_terms'), revision)
        notes.append({'noteId': 102, 'modelName': 'Basic', 'fields': {'Expression': {'value': '図書館[としょかん]'}}})
        notes.append({'noteId': 103, 'modelName': 'Basic', 'fields': {'Expression': {'value': '学校'}}})
        self.assertEqual(self.client.post(endpoint, json={}).json()['added'], 1)
        self.assertEqual(set(store.known()['図書館']['ankiNoteIds']), {101, 102})
        notes.clear()
        self.assertEqual(self.client.post(endpoint, json={}).json()['added'], 0)
        self.assertEqual(set(store.known()), {'本', '図書館', '学校'})
        self.assertTrue(store.setting('anki')['lastVocabularySyncAt'])

    def test_failed_anki_sync_preserves_vocabulary(self):
        store = self.app.state.store
        store.add_terms(['本'])
        self.app.state.anki.client.close()
        self.app.state.anki.client = httpx.Client(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'result': None, 'error': 'Anki unavailable'})))
        response = self.client.post('/api/anki/sync-vocabulary', json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(store.known()), ['本'])
        self.assertFalse(store.setting('anki').get('lastVocabularySyncAt'))

    def test_wordbank_ui_and_local_tts_removed(self):
        page = self.client.get('/').text
        for removed in ['wordbank-page', 'cache-wordbank', 'media-audio-enabled', 'voice-model-form', 'test-media-audio']:
            self.assertNotIn(removed, page)
        self.assertIn('Sync Anki', page)
        self.assertIn('anki-vocabulary-status', page)
        self.app.state.store.settings('media', {'audio': {'enabled': True, 'voiceName': 'Old saved voice'}})
        self.assertFalse(self.client.get('/api/media/providers').json()['status']['audio']['enabled'])
        self.assertEqual(self.client.post('/api/media/test-audio', json={}).status_code, 404)
        self.assertEqual(self.client.post('/api/media/voice-models', json={}).status_code, 404)

    def test_learning_analytics_removed(self):
        self.assertEqual(self.client.get('/api/ml/analytics').status_code, 404)
        page = self.client.get('/').text
        self.assertNotIn('insights-page', page)
        self.assertNotIn('Learning Analytics', page)
        self.assertIn('reader-side-search', page)

    def test_sync_merges_before_push_and_hides_tokens(self):
        service = self.app.state.sync
        service.client.close()
        self.app.state.store.settings('sync', {'supabaseUrl': 'https://example.invalid', 'supabaseAnonKey': 'test-key',
                                             'userId': 'user-1', 'deviceId': 'device-1', 'accessToken': 'private-token'})
        self.app.state.store.add_terms(['図書館'])
        calls = []
        def remote(request):
            calls.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
            return httpx.Response(200, json=[])
        service.client = httpx.Client(transport=httpx.MockTransport(remote))
        response = self.client.post('/api/sync/run')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls[0][0], 'GET')
        written = next(c[2] for c in calls if c[0] == 'POST' and c[1].endswith('/known_terms'))
        self.assertEqual(written[0]['term'], '図書館')
        self.assertNotIn('private-token', self.client.get('/api/state').text)

    def test_sync_failure_is_persisted(self):
        service = self.app.state.sync
        service.client.close()
        self.app.state.store.settings('sync', {'supabaseUrl': 'https://example.invalid', 'supabaseAnonKey': 'test-key', 'userId': 'user-1'})
        service.client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(400, json={'message': 'Test failure'})))
        self.assertEqual(self.client.post('/api/sync/pull').status_code, 400)
        self.assertEqual(self.app.state.store.setting('sync')['lastError'], 'Test failure')
        self.assertFalse(service.lock.locked())

    def test_epub_navigation_and_cross_page_ruby(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as z:
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
            z.writestr('book.opf', '<package><metadata><title>Novel</title><creator>Author</creator></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
            z.writestr('c1.xhtml', '<html><body><h1>Chapter One</h1><p><ruby>周<rt>あまね</rt></ruby>は笑う。</p><a href="c2.xhtml">Chapter Two</a></body></html>')
            z.writestr('c2.xhtml', '<html><body><h1>Chapter Two</h1><p>周は本を読む。</p></body></html>')
        result = self.client.post('/api/documents', files={'book': ('novel.epub', data.getvalue())})
        self.assertEqual(result.status_code, 201, result.text)
        doc = self.client.get('/api/documents/' + result.json()['document']['id']).json()
        self.assertEqual(doc['author'], 'Author')
        self.assertEqual(doc['chapters'][1]['href'], 'c2.xhtml')
        html = ''.join(p['html'] for p in doc['pages'])
        self.assertIn('data-epub-href="c2.xhtml"', html)
        self.assertEqual(html.count('class="reader-chapter-heading"'), 2)
        self.assertNotIn('<rt>しゅう</rt>', html)

    def test_restart_preserves_canonical_data(self):
        doc = self.book()
        self.client.post('/api/known-terms', json={'term': '図書館'})
        self.client.__exit__(None, None, None)
        self.app = create_app(Path(self.directory.name))
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.assertEqual(self.client.get('/api/state').json()['knownTermsCount'], 1)
        self.assertEqual(self.client.get('/api/documents/' + doc).status_code, 200)


if __name__ == '__main__':
    unittest.main()
