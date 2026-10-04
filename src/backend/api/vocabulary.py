"""Read, import, delete, and restore the known words used to hide furigana."""

import re

from fastapi import Body, Request
from starlette.concurrency import run_in_threadpool

from ..storage.sqlite import decode
from ..services.dictionary import normalize
from .uploads import read_upload

def register(app):
    """Add known-word import, browsing, deletion, and Trash endpoints."""
    @app.get('/api/known-terms')
    def known_terms(request: Request, offset: int = 0, limit: int = 100, q: str = '', sort: str = 'added', dictionaryId: str = ''):
        """Return a page of known words, optionally with dictionary meanings.

        The Word Bank screen is gone, but this API still supports vocabulary
        inspection. Filter and sort words first; fetch meanings only for the
        requested page. The gojuon sort options currently compare written text.
        """
        s, dictionaries = request.app.state.store, request.app.state.dictionaries
        metadata = s.known()
        all_terms = list(metadata)
        terms = [t for t in all_terms if normalize(q) in t]
        if sort in {'alphabetical', 'gojuon', 'gojuon-desc'}:
            terms.sort(reverse=sort == 'gojuon-desc')
        elif sort in {'length-asc', 'length-desc'}:
            terms.sort(key=lambda t: (len(t), t), reverse=sort == 'length-desc')
        elif sort in {'added-asc', 'added-desc'}:
            terms.sort(key=lambda t: metadata[t].get('addedAt', metadata[t].get('createdAt', '')), reverse=sort == 'added-desc')
        selected = dictionaryId or next((d['id'] for d in dictionaries.metadata() if d['selectedForWordBank']), '')
        return {'allTotal': len(all_terms), 'total': len(terms), 'offset': max(0, offset), 'limit': limit, 'sort': sort,
                'terms': [{'term': t, 'dictionaryEntries': dictionaries.entries(t, selected) if selected else []}
                          for t in terms[max(0, offset):max(0, offset) + min(500, max(1, limit))]]}

    @app.post('/api/known-terms')
    async def add_terms(request: Request):
        """Add unique words from JSON or a text file uploaded as ``terms``.

        Clean spelling/spacing before saving and record which words are new.
        Save in a worker thread. Existing books keep their cached tokens.
        """
        if 'multipart/form-data' in request.headers.get('content-type', ''):
            form = await request.form()
            file = form.get('terms')
            text = (await read_upload(file)).decode('utf-8-sig')
            terms = re.split(r'[\r\n,\t]+', text)
        else:
            body = await request.json()
            terms = body.get('terms', [body.get('term', '')])
            if isinstance(terms, str):
                terms = re.split(r'[\r\n,\t]+', terms)
        terms = list(dict.fromkeys(normalize(t) for t in terms if normalize(t)))
        s = request.app.state.store
        added = await run_in_threadpool(s.add_terms, terms)
        for term in added:
            s.event('wordbank.added', {'term': term})
        return {'imported': len(terms), 'added': len(added), 'total': len(s.known())}

    @app.delete('/api/known-terms')
    def delete_terms(request: Request, body: dict = Body(...)):
        s = request.app.state.store
        terms = list(s.known()) if body.get('all') else body.get('terms', [body.get('term', '')])
        removed = s.delete_terms([normalize(t) for t in terms])
        return {'deleted': len(removed), 'removed': len(removed), 'total': len(s.known())}

    @app.post('/api/trash/known-terms/restore')
    def restore_terms(request: Request, body: dict = Body(...)):
        """Restore the selected words from Trash with their saved Anki note links."""
        s = request.app.state.store
        terms = [normalize(t) for t in body.get('terms', [])]
        metadata = {}
        for term in terms:
            row = s.one('SELECT entry_json FROM trash_known_terms WHERE term=?', (term,))
            if row:
                metadata[term] = decode(row['entry_json'], {}).get('meta', {})
        return {'restored': len(s.add_terms(list(metadata), metadata)), 'total': len(s.known())}

    @app.delete('/api/trash/known-terms')
    def purge_terms(request: Request, body: dict = Body(...)):
        s = request.app.state.store
        terms = [r['term'] for r in s.rows('SELECT term FROM trash_known_terms')] if body.get('all') else body.get('terms', [])
        with s.transaction() as db:
            deleted = sum(db.execute('DELETE FROM trash_known_terms WHERE term=?', (normalize(t),)).rowcount for t in terms)
        return {'deleted': deleted, 'total': s.one('SELECT COUNT(*) n FROM trash_known_terms')['n']}
