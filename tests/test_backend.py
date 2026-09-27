"""Isolated native backend regressions. Never opens the user's data directory."""

import json
import tempfile
import unittest
import re
import io
import zipfile
from pathlib import Path

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
        self.assertEqual(self.app.state.store.known()['図書館']['ankiNoteIds'], [12345])

    def test_all_legacy_routes_are_registered(self):
        expected = json.loads(Path(__file__).with_name('api_contract.json').read_text())
        actual = {(method, re.sub(r'\{[^}]+\}', ':id', route.path))
                  for route in self.app.routes if hasattr(route, 'methods') for method in route.methods}
        self.assertFalse(set(map(tuple, expected)) - actual)

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
