"""Import books, load reader pages, save progress, and manage book Trash."""

from fastapi import Body, File, Request, UploadFile, Form
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..storage.sqlite import encode, merge, now
from .uploads import read_upload

def register(app):
    """Add library and reader endpoints before the frontend file routes."""
    @app.post('/api/documents', status_code=201)
    async def import_document(request: Request, book: UploadFile = File(...), title: str = Form('')):
        data = await read_upload(book)
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
        """Tell the reader when page preparation starts and when it finishes.

        The generator runs in a worker thread. Progress has a start and an end;
        it does not measure individual chapters or tokens as they are processed.
        """
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
        """Delete one book from Trash through the shared book cleanup method."""
        request.app.state.books.delete_permanently(doc_id)
        return {'deleted': True}

    @app.post('/api/documents/{doc_id}/progress')
    def progress(request: Request, doc_id: str, body: dict = Body(...)):
        """Save changed reading settings and position in this book's progress row.

        Keep bookmarks/highlights that the request leaves out. Limit zoom and
        page values to their allowed ranges; page 0 is the first page. Record the
        save time for sync without discarding cached text tokens.
        """
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
        """Empty book Trash using the same cleanup as deleting a single book."""
        return {'deleted': request.app.state.books.delete_permanently()}
