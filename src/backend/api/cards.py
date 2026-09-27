"""Register cards endpoints while preserving frontend request and response contracts."""

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
    @app.post('/api/templates', status_code=201)
    async def template(request: Request, template: UploadFile = File(...)):
        data = (await uploaded(template)).decode('utf-8-sig')
        try:
            parsed = json.loads(data)
            fields = parsed.get('fields', []) if isinstance(parsed, dict) else parsed
        except ValueError:
            fields = [f.strip() for f in re.split(r'[,\n]', data) if f.strip()]
        if not isinstance(fields, list) or not fields or not all(isinstance(f, str) for f in fields):
            raise ValueError('Template must contain a list of field names.')
        value = {'id': str(uuid.uuid4()), 'name': template.filename, 'fields': fields}
        request.app.state.store.write('INSERT INTO templates VALUES (?,?,?,?)', (value['id'], 0, encode(value), now()))
        return {'template': value}

    @app.post('/api/cards', status_code=201)
    def create_card(request: Request, body: dict = Body(...)):
        s = request.app.state.store
        doc = s.document(body.get('documentId'))
        if not doc:
            raise LookupError('Document not found.')
        expression = normalize(body.get('expression'))
        if not expression:
            raise ValueError('Expression is required.')
        row = s.one('SELECT payload_json FROM templates WHERE id=?', (body.get('templateId', 'default-template'),))
        if not row:
            raise LookupError('Template not found.')
        template = decode(row['payload_json'], {})
        card = {**body, 'id': str(uuid.uuid4()), 'expression': expression, 'source': doc['title'], 'createdAt': now()}
        card['fields'] = {f: card.get(f[:1].lower() + f[1:], '') for f in template['fields']}
        s.write('INSERT INTO cards VALUES (?,?,?,?)', (card['id'], 0, encode(card), now()))
        return card

    @app.get('/api/cards/export')
    def export_cards(request: Request):
        cards = [decode(r['payload_json'], {}).get('fields', {}) for r in request.app.state.store.rows('SELECT payload_json FROM cards ORDER BY order_index')]
        fields = list(dict.fromkeys(f for c in cards for f in c))
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(cards)
        return Response(output.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="anki-cards.csv"'})
