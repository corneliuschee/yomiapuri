"""Register dictionaries endpoints while preserving frontend request and response contracts."""

import csv
import hashlib
import io
import json
import re
import uuid

from fastapi import Body, File, Request, UploadFile, Form
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..storage.sqlite import decode, encode, merge, now
from ..services.dictionary import normalize
from .common import uploaded

def register(app):
    @app.get('/api/dictionaries')
    def dictionaries(request: Request):
        return {'dictionaries': request.app.state.dictionaries.metadata(), 'settings': request.app.state.store.setting('dictionarySettings')}

    @app.post('/api/dictionaries', status_code=201)
    async def import_dictionaries(request: Request, dictionary: list[UploadFile] = File(...), name: str = Form('')):
        """Import up to twenty uploads sequentially outside the async event loop.

        Each dictionary commits independently: a later invalid file does not
        roll back earlier successfully imported dictionaries in the request.
        """
        if len(dictionary) > 20:
            raise ValueError('Import at most 20 dictionaries at once.')
        results = []
        for file in dictionary:
            data = await uploaded(file)
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
        """Expand a normalized query, attach single-token readability, and log it.

        Both dictionary URL aliases share this behavior. Although HTTP GET,
        this path can write structural token cache rows and a lookup event.
        """
        term = normalize(term or q)
        result = request.app.state.dictionaries.lookup(term, request.app.state.nlp.variants(term), prefix)
        tokens = request.app.state.nlp.tokens(term)
        result['readability'] = request.app.state.nlp.readability(tokens[0]) if len(tokens) == 1 else {}
        request.app.state.store.event('dictionary.lookup', {'term': term})
        return result
