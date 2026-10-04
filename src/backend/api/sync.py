"""Handle Supabase sign-in, settings, and user-requested uploads/downloads."""

from fastapi import Body, Request

def register(app):
    """Add account and sync actions; the sync service does the network work."""
    @app.get('/api/sync/status')
    def sync_status(request: Request):
        return request.app.state.sync.status()

    @app.post('/api/sync/settings')
    def sync_settings(request: Request, body: dict = Body(...)):
        return request.app.state.sync.configure(body)

    @app.post('/api/sync/sign-out')
    def sync_sign_out(request: Request):
        return request.app.state.sync.sign_out()

    @app.post('/api/sync/sign-in')
    def sync_sign_in(request: Request, body: dict = Body(...)):
        return request.app.state.sync.sign_in(body)

    @app.post('/api/sync/push')
    def sync_push(request: Request):
        return request.app.state.sync.run('push')

    @app.post('/api/sync/pull')
    def sync_pull(request: Request):
        return request.app.state.sync.run('pull')

    @app.post('/api/sync/run')
    def sync_run(request: Request):
        return request.app.state.sync.run('run')

    @app.post('/api/sync/cleanup-deleted')
    def sync_cleanup(request: Request):
        return request.app.state.sync.run('cleanup-deleted')
