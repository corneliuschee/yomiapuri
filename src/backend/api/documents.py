"""Register documents endpoints while preserving frontend request and response contracts."""

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
    @app.post('/api/documents', status_code=201)
    async def import_document(request: Request, book: UploadFile = File(...), title: str = Form('')):
        data = await uploaded(book)
        result = await run_in_threadpool(request.app.state.books.import_file, book.filename or 'book.txt', data, title)
        return {'document': result}

    @app.post('/api/documents/reorder')
    def reorder(request: Request, body: dict = Body(...)):
        s = request.app.state.store
        ids = body.get('ids', [])
        active = [d['id'] for d in s.documents()]
        if len(ids) != len(set(ids)) or set(ids) != set(active):
            raise ValueError('Provide every active document id exactly once.')
        with s.transaction() as db:
            db.executemany('UPDATE documents SET order_index=? WHERE id=?', enumerate(ids))
            s.bump('documents', db)
        return {'documents': s.documents()}

    @app.get('/api/documents/{doc_id}/ingest-stream')
    def ingest(request: Request, doc_id: str):
        def events():
            yield 'event: progress\ndata: ' + encode({'message': 'Checking local book cache', 'progress': 0}) + '\n\n'
            try:
                existed = request.app.state.store.one('SELECT id FROM document_pages WHERE document_id=? LIMIT 1', (doc_id,))
                request.app.state.books.ensure_pages(doc_id)
                yield 'event: done\ndata: ' + encode({'rebuilt': not bool(existed), 'deferred': bool(existed), 'state': 'ready', 'indexStale': True, 'progress': 1, 'message': 'Local cache ready'}) + '\n\n'
            except Exception as error:
                yield 'event: error\ndata: ' + encode({'error': str(error)}) + '\n\n'
        return StreamingResponse(events(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.get('/api/documents/{doc_id}/pages')
    def pages(request: Request, doc_id: str, start: int = 0, limit: int = 8):
        return request.app.state.books.window(doc_id, start, limit)

    @app.get('/api/documents/{doc_id}')
    def document(request: Request, doc_id: str, page: int | None = None):
        return request.app.state.books.response(doc_id, page)

    @app.patch('/api/documents/{doc_id}')
    def rename(request: Request, doc_id: str, body: dict = Body(...)):
        s = request.app.state.store
        doc = s.document(doc_id)
        if not doc:
            raise LookupError('Document not found.')
        title = str(body.get('title', '')).strip()
        if not title:
            raise ValueError('Title is required.')
        s.save_document({**doc, 'title': title, 'updatedAt': now()})
        return {'document': s.document(doc_id)}

    @app.delete('/api/documents/{doc_id}')
    def delete_document(request: Request, doc_id: str):
        request.app.state.books.trash(doc_id)
        return {'deleted': True}

    @app.post('/api/trash/documents/{doc_id}/restore')
    def restore_document(request: Request, doc_id: str):
        return {'document': request.app.state.books.trash(doc_id, restore=True)}

    @app.delete('/api/trash/documents/{doc_id}')
    def permanently_delete_document(request: Request, doc_id: str):
        s = request.app.state.store
        with s.transaction() as db:
            if not db.execute('SELECT 1 FROM trash_documents WHERE id=?', (doc_id,)).fetchone():
                raise LookupError('Document not found in Trash.')
            db.execute('DELETE FROM python_search_fts WHERE chunk_id IN (SELECT id FROM python_search_chunks WHERE document_id=?)', (doc_id,))
            for table in ['python_search_chunks', 'python_index_documents', 'document_pages', 'trash_document_bodies', 'reading_progress']:
                db.execute(f'DELETE FROM {table} WHERE document_id=?', (doc_id,))
            db.execute('DELETE FROM trash_documents WHERE id=?', (doc_id,))
            s.bump('documents', db)
        return {'deleted': True}

    @app.post('/api/documents/{doc_id}/progress')
    def progress(request: Request, doc_id: str, body: dict = Body(...)):
        s = request.app.state.store
        if not s.document(doc_id):
            raise LookupError('Document not found.')
        allowed = {'page', 'scrollTop', 'bookmarks', 'highlights', 'mode', 'zoom', 'chapterId', 'percentage'}
        patch = {k: v for k, v in body.items() if k in allowed}
        if 'zoom' in patch:
            patch['zoom'] = min(175, max(75, float(patch['zoom'])))
        if 'page' in patch:
            patch['page'] = max(0, int(patch['page']))
        with s.transaction() as db:
            result = merge(s.progress(doc_id), patch)
            result['updatedAt'] = now()
            db.execute('INSERT OR REPLACE INTO reading_progress VALUES (?,?,?)', (doc_id, encode(result), now()))
        return result

    @app.delete('/api/trash/documents')
    def purge_books(request: Request):
        s = request.app.state.store
        with s.transaction() as db:
            ids = [r['id'] for r in s.documents(True)]
            for doc_id in ids:
                db.execute('DELETE FROM python_search_fts WHERE chunk_id IN (SELECT id FROM python_search_chunks WHERE document_id=?)', (doc_id,))
                for table in ['python_search_chunks', 'python_index_documents', 'document_pages', 'trash_document_bodies', 'reading_progress']:
                    db.execute(f'DELETE FROM {table} WHERE document_id=?', (doc_id,))
                db.execute('DELETE FROM trash_documents WHERE id=?', (doc_id,))
            s.bump('documents', db)
        return {'deleted': len(ids)}
