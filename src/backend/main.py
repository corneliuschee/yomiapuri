"""Create the application explicitly to control database lifetime."""

from contextlib import asynccontextmanager
import asyncio
from pathlib import Path
import logging
import httpx
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .services.books import BookService
from .services.anki import AnkiService
from .services.ai import AIService
from .config import DATA, FRONTEND
from .services.dictionary import DictionaryService
from .services.nlp import NLP
from .storage.sqlite import Store
from .services.search import SearchService
from .services.media import MediaService
from .services.sync import SyncService
from .api import register_routes


def create_app(data_dir=DATA):
    data_dir = Path(data_dir)
    @asynccontextmanager
    async def lifespan(app):
        store = Store(data_dir)
        app.state.store = store
        app.state.dictionaries = DictionaryService(store)
        app.state.nlp = NLP(store, app.state.dictionaries)
        app.state.books = BookService(store, app.state.nlp)
        app.state.anki = AnkiService(store, app.state.dictionaries, app.state.nlp)
        app.state.media = MediaService(store)
        app.state.anki.media = app.state.media
        app.state.sync = SyncService(store, app.state.books)
        app.state.search = SearchService(store, app.state.books, app.state.nlp)
        app.state.ai = AIService(store)
        app.state.ai.idle_task = asyncio.create_task(app.state.ai.idle_watch())
        try:
            yield
        finally:
            await app.state.ai.close()
            app.state.anki.close()
            app.state.sync.close()
            store.close()

    app = FastAPI(title='YomiApuri', lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_payload(request, error):
        return JSONResponse({'error': 'Invalid request fields.', 'details': str(error)}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({'error': str(error.detail)}, status_code=error.status_code)

    @app.exception_handler(httpx.HTTPError)
    async def provider_error(request, error):
        return JSONResponse({'error': 'The configured external service is unavailable. Check its address and that it is running.'}, status_code=502)

    @app.exception_handler(Exception)
    async def internal_error(request, error):
        logging.getLogger(__name__).exception('Request failed: %s', request.url.path)
        return JSONResponse({'error': 'Request failed. See the server log for details.'}, status_code=500)

    @app.exception_handler(ValueError)
    async def invalid_request(request: Request, error: ValueError):
        return JSONResponse({'error': str(error)}, status_code=400)

    @app.exception_handler(LookupError)
    async def missing_resource(request: Request, error: LookupError):
        return JSONResponse({'error': str(error)}, status_code=404)

    @app.exception_handler(FileExistsError)
    async def duplicate_resource(request: Request, error: FileExistsError):
        return JSONResponse({'error': str(error)}, status_code=409)

    register_routes(app)

    @app.api_route('/api/{missing:path}', methods=['GET', 'POST', 'PATCH', 'DELETE', 'PUT'])
    def missing_api(missing: str):
        return JSONResponse({'error': 'Not found.'}, status_code=404)

    vendor = FRONTEND / 'vendor' / 'pdfjs'
    if vendor.is_dir():
        app.mount('/vendor/pdfjs', StaticFiles(directory=vendor), name='pdfjs')
    app.mount('/media', StaticFiles(directory=str(data_dir / 'media'), check_dir=False), name='media')
    app.mount('/', StaticFiles(directory=FRONTEND, html=True), name='frontend')
    return app


app = create_app()
