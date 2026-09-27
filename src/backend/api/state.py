"""Register state endpoints while preserving frontend request and response contracts."""

from fastapi import Body, Request

from ..storage.sqlite import decode
from ..services.dictionary import normalize

def register(app):
    @app.get('/api/state')
    def state(request: Request):
        s = request.app.state.store
        sync = request.app.state.sync.status()
        return {**{k: s.setting(k) for k in ['reader', 'anki', 'media', 'ai', 'ml', 'dictionarySettings']},
                'documents': s.documents(), 'knownTermsCount': len(s.known()), 'progress': s.progress(),
                'trash': {'documents': s.documents(True), 'knownTerms': [decode(r['entry_json'], {}) for r in s.rows('SELECT entry_json FROM trash_known_terms ORDER BY order_index')]},
                'cards': [decode(r['payload_json'], {}) for r in s.rows('SELECT payload_json FROM cards ORDER BY order_index')],
                'templates': [decode(r['payload_json'], {}) for r in s.rows('SELECT payload_json FROM templates ORDER BY order_index')],
                'dictionaries': request.app.state.dictionaries.metadata(), 'sync': sync}

    @app.patch('/api/reader/settings')
    @app.post('/api/reader/settings')
    def reader_settings(request: Request, body: dict = Body(...)):
        allowed = {'hideInferredReadableFurigana', 'showKnownFurigana'}
        return {'reader': request.app.state.store.settings('reader', {k: bool(v) for k, v in body.items() if k in allowed})}

    @app.post('/api/reader/readable-suggestion/dismiss')
    def dismiss(request: Request, body: dict = Body(...)):
        term = normalize(body.get('term'))
        if not term:
            raise ValueError('No vocabulary selected.')
        request.app.state.store.event('reader.readable-suggestion-dismissed', body)
        return {'dismissed': True, 'term': term}
