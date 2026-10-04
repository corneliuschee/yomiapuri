"""Report search status, refresh the text index, and search indexed book text."""

from fastapi import Body, Request

def register(app):
    """Add the SQLite text-search endpoints."""
    @app.get('/api/ml/index/status')
    def search_status(request: Request):
        return request.app.state.search.status()

    @app.post('/api/search/index/refresh')
    def refresh_search(request: Request):
        return request.app.state.search.refresh()

    @app.post('/api/search/fts')
    def search(request: Request, body: dict = Body(...)):
        return request.app.state.search.search(body.get('query'), body.get('documentId', ''), body.get('limit', 30))
