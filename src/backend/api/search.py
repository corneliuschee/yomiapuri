"""Register search endpoints while preserving frontend request and response contracts."""

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
    @app.get('/api/ml/index/status')
    def search_status(request: Request):
        return request.app.state.search.status()

    @app.post('/api/search/index/refresh')
    def refresh_search(request: Request):
        return request.app.state.search.refresh()

    @app.post('/api/search/fts')
    def search(request: Request, body: dict = Body(...)):
        return request.app.state.search.search(body.get('query'), body.get('documentId', ''), body.get('limit', 30))
