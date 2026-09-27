"""Register state endpoints while preserving frontend request and response contracts."""

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

    def cache_status(request, dictionary_id):
        s, dictionaries = request.app.state.store, request.app.state.dictionaries
        dictionary_id = dictionary_id or next((d['id'] for d in dictionaries.metadata() if d['selectedForWordBank']), '')
        dictionary = next((d for d in dictionaries.metadata() if d['id'] == dictionary_id), {})
        stamp = s.setting('meaningCache:' + dictionary_id)
        count = s.one('SELECT COUNT(*) n FROM python_meanings WHERE dictionary_id=? AND revision=?', (dictionary_id, s.revision('dictionaries')))['n']
        stale = stamp.get('knownRevision') != s.revision('known_terms') or stamp.get('dictionaryRevision') != s.revision('dictionaries')
        return {'dictionaryId': dictionary_id, 'dictionaryName': dictionary.get('name', ''), 'cachedTerms': count, 'ready': bool(stamp.get('rebuiltAt')), 'stale': stale,
                'rebuiltAt': stamp.get('rebuiltAt', ''), 'message': 'Meanings need refresh.' if stale else 'Meanings are up to date.'}

    @app.get('/api/cache/wordbank-meanings/status')
    def meanings_status(request: Request, dictionaryId: str = ''):
        return cache_status(request, dictionaryId)

    @app.post('/api/cache/wordbank-meanings/rebuild')
    def meanings_rebuild(request: Request, body: dict = Body(default={})):
        s = request.app.state.store
        dictionary_id = cache_status(request, body.get('dictionaryId', ''))['dictionaryId']
        if not dictionary_id:
            raise ValueError('Choose a term dictionary first.')
        revision, known_revision = s.revision('dictionaries'), s.revision('known_terms')
        for term in s.known():
            entries = request.app.state.dictionaries.entries(term, dictionary_id)
            s.write('INSERT OR REPLACE INTO python_meanings VALUES (?,?,?,?)', (dictionary_id, term, revision, encode(entries)))
        s.settings('meaningCache:' + dictionary_id, {'rebuiltAt': now(), 'knownRevision': known_revision, 'dictionaryRevision': revision})
        return cache_status(request, dictionary_id)
