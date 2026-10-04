"""Manage image settings and generate sample mnemonic images for Anki."""

from fastapi import Body, Request


def register(app):
    """Add the image settings and preview endpoints to the FastAPI app."""
    @app.get('/api/media/providers')
    def media_providers(request: Request):
        return request.app.state.media.providers()

    @app.post('/api/media/settings')
    def media_settings(request: Request, body: dict = Body(...)):
        settings = request.app.state.store.settings('media', {'image': body.get('image', {}), 'audio': {'enabled': False}})
        return {'settings': settings, 'providers': request.app.state.media.providers()}

    @app.post('/api/media/test-image')
    def test_image(request: Request, body: dict = Body(default={})):
        media = request.app.state.media
        return {'value': media.image(body.get('expression') or '図書館', body.get('reading', ''), body.get('meaning', '')), 'status': media.status()}
