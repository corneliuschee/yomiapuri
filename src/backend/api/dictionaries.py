"""Import and manage dictionaries, then look up words for the reader."""

from fastapi import Body, File, Request, UploadFile, Form
from starlette.concurrency import run_in_threadpool

from ..services.dictionary import normalize
from .uploads import read_upload

def register(app):
    """Add dictionary import/settings, deletion, and word-lookup endpoints."""
    @app.get('/api/dictionaries')
    def dictionaries(request: Request):
        return {'dictionaries': request.app.state.dictionaries.metadata(), 'settings': request.app.state.store.setting('dictionarySettings')}

    @app.post('/api/dictionaries', status_code=201)
    async def import_dictionaries(request: Request, dictionary: list[UploadFile] = File(...), name: str = Form('')):
        """Import up to twenty files, one at a time, in a worker thread.

        Save each successful dictionary immediately. If a later file fails,
        dictionaries already imported by this request stay saved.
        """
        if len(dictionary) > 20:
            raise ValueError('Import at most 20 dictionaries at once.')
        results = []
        for file in dictionary:
            data = await read_upload(file)
            results.append(await run_in_threadpool(request.app.state.dictionaries.import_file, file.filename or 'dictionary.json', data, name if len(dictionary) == 1 else ''))
        return {'dictionary': results[0]['dictionary'], 'dictionaries': [r['dictionary'] for r in results],
                'validations': [r['validation'] for r in results]}

    @app.patch('/api/dictionaries/settings')
    def dictionary_settings(request: Request, body: dict = Body(...)):
        return {'settings': request.app.state.store.settings('dictionarySettings', body)}

    @app.patch('/api/dictionaries/{dictionary_id}/settings')
    def configure_dictionary(request: Request, dictionary_id: str, body: dict = Body(...)):
        return {'dictionary': request.app.state.dictionaries.settings(dictionary_id, body), **dictionaries(request)}

    @app.delete('/api/dictionaries/{dictionary_id}')
    def delete_dictionary(request: Request, dictionary_id: str):
        s = request.app.state.store
        with s.transaction() as db:
            db.execute('DELETE FROM dictionaries WHERE id=?', (dictionary_id,))
            s.bump('dictionaries', db)
        request.app.state.dictionaries.exact.cache_clear()
        return dictionaries(request)

    @app.get('/api/dictionary')
    @app.get('/api/dictionary/lookup')
    def lookup(request: Request, term: str = '', q: str = '', prefix: bool = False):
        """Look up a word and its base forms, then add its readability result.

        Both dictionary URLs call this function. A lookup may save new tokens
        in the cache and records a lookup event, even though it is a GET request.
        """
        term = normalize(term or q)
        result = request.app.state.dictionaries.lookup(term, request.app.state.nlp.variants(term), prefix)
        tokens = request.app.state.nlp.tokens(term)
        result['readability'] = request.app.state.nlp.readability(tokens[0]) if len(tokens) == 1 else {}
        request.app.state.store.event('dictionary.lookup', {'term': term})
        return result
