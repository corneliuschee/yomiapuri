"""Register integrations endpoints while preserving frontend request and response contracts."""

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
    @app.post('/api/anki/settings')
    def anki_settings(request: Request, body: dict = Body(...)):
        return request.app.state.store.settings('anki', body)

    @app.get('/api/anki/connect')
    def anki_connect(request: Request):
        service = request.app.state.anki
        return {'decks': service.connect('deckNames'), 'models': service.connect('modelNames'),
                'settings': request.app.state.store.setting('anki')}

    @app.get('/api/anki/model-fields')
    def model_fields(request: Request, modelName: str = ''):
        service = request.app.state.anki
        modelName = modelName or request.app.state.store.setting('anki')['modelName']
        fields = service.connect('modelFieldNames', {'modelName': modelName}) if modelName else []
        return {'modelName': modelName, 'fields': fields, 'fieldMap': service.mapping(modelName, fields)}

    @app.post('/api/anki/card-preview')
    def card_preview(request: Request, body: dict = Body(...)):
        return request.app.state.anki.preview(body)

    @app.post('/api/anki/export-card', status_code=201)
    def export_card(request: Request, body: dict = Body(...)):
        return request.app.state.anki.export(body)

    @app.post('/api/anki/import')
    def import_anki(request: Request, body: dict = Body(...)):
        return request.app.state.anki.import_terms(body)

    @app.post('/api/anki/open-known-term')
    def open_known(request: Request, body: dict = Body(...)):
        term = normalize(body.get('term'))
        meta = request.app.state.store.known().get(term, {})
        ids = meta.get('ankiNoteIds', [])
        query = ' OR '.join(f'nid:{int(i)}' for i in ids) if ids else encode(term)
        result = request.app.state.anki.connect('guiBrowse', {'query': query})
        return {'opened': True, 'noteIds': result}

    @app.get('/api/media/providers')
    def media_providers(request: Request):
        return request.app.state.media.providers()

    @app.post('/api/media/settings')
    def media_settings(request: Request, body: dict = Body(...)):
        settings = request.app.state.store.settings('media', body)
        return {'settings': settings, 'providers': request.app.state.media.providers()}

    @app.post('/api/media/voice-models', status_code=201)
    def voice_model(request: Request, body: dict = Body(...)):
        url = str(body.get('url', '')).strip()
        if not re.fullmatch(r'https://huggingface\.co/[^/\s]+/[^/\s]+/?', url):
            raise ValueError('Enter a Hugging Face model URL, for example https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-JP')
        model = {'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'url': url, 'name': body.get('name') or url.split('huggingface.co/')[1], 'provider': 'huggingface', 'status': 'imported'}
        s = request.app.state.store
        models = [m for m in s.setting('media')['voiceModels'] if m['id'] != model['id']] + [model]
        settings = s.settings('media', {'voiceModels': models, 'audio': {'voiceModelId': model['id']}})
        return {'model': model, 'settings': settings, 'providers': request.app.state.media.providers()}

    @app.post('/api/media/test-audio')
    def test_audio(request: Request, body: dict = Body(default={})):
        media = request.app.state.media
        return {'value': media.audio(body.get('expression') or '図書館'), 'status': media.status()}

    @app.post('/api/media/test-image')
    def test_image(request: Request, body: dict = Body(default={})):
        media = request.app.state.media
        return {'value': media.image(body.get('expression') or '図書館', body.get('reading', ''), body.get('meaning', '')), 'status': media.status()}
