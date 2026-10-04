"""Connect to Anki, preview and export cards, and sync learned vocabulary."""

from fastapi import Body, Request

from ..storage.sqlite import encode
from ..services.dictionary import normalize

def register(app):
    """Add Anki connection, card, and learned-vocabulary endpoints."""
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

    @app.post('/api/anki/sync-vocabulary')
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
