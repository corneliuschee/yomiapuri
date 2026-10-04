"""Supply the frontend's initial data and save reader display settings."""

from fastapi import Body, Request

from ..storage.sqlite import decode

def register(app):
    """Add the initial-data and reader-settings endpoints to the app."""
    @app.get('/api/state')
    def state(request: Request):
        """Read the information the frontend needs to display its pages.

        Include book details, progress, settings, cards, and vocabulary count.
        Leave out book text, dictionary definitions, and sync credentials.
        SQLite remains the source for this response.
        """
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
