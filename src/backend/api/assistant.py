"""Register assistant endpoints while preserving frontend request and response contracts."""

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
    @app.get('/api/ai/providers')
    def ai_providers(request: Request):
        settings = request.app.state.store.setting('ai')
        return {'settings': settings, 'models': settings['models'], 'status': request.app.state.ai.status()}

    @app.get('/api/ai/runtime')
    def ai_runtime(request: Request):
        return request.app.state.ai.status()

    @app.post('/api/ai/runtime/stop')
    async def stop_ai(request: Request):
        async with request.app.state.ai.lock:
            return await request.app.state.ai.stop()

    @app.post('/api/ai/settings')
    def ai_settings(request: Request, body: dict = Body(...)):
        return {'settings': request.app.state.store.settings('ai', body)}

    @app.post('/api/reader/assistant/stream')
    async def assistant_stream(request: Request, body: dict = Body(...)):
        return StreamingResponse(request.app.state.ai.stream(body), media_type='text/event-stream',
                                 headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.post('/api/reader/assistant')
    async def assistant(request: Request, body: dict = Body(...)):
        async for event, result in request.app.state.ai.events(body):
            if event == 'done':
                return result

    @app.post('/api/ai/models', status_code=201)
    def ai_model(request: Request, body: dict = Body(...)):
        url = str(body.get('url', '')).strip()
        if not re.fullmatch(r'https://huggingface\.co/[^/\s]+/[^/\s]+/?', url):
            raise ValueError('Enter a Hugging Face model URL.')
        model = {'id': hashlib.sha256(url.encode()).hexdigest()[:16], 'url': url, 'name': body.get('name') or url.rsplit('/', 1)[-1], 'provider': 'llama.cpp', 'localPath': body.get('localPath', '')}
        s = request.app.state.store
        settings = s.settings('ai', {'models': [m for m in s.setting('ai')['models'] if m['id'] != model['id']] + [model]})
        return {'model': model, 'settings': settings}

    @app.post('/api/ai/test-translation')
    async def translate(request: Request, body: dict = Body(...)):
        async for event, result in request.app.state.ai.events({'question': 'Translate this: ' + str(body.get('text', ''))}):
            if event == 'done':
                return result.get('translation')
