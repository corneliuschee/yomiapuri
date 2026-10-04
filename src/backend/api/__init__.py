"""Add each feature's HTTP endpoints to the app in the order listed below."""

from . import assistant, search, anki, media, state, documents, vocabulary, dictionaries, sync, cards


def register_routes(app):
    """Call each module's register(app) function once during app creation."""
    for module in [assistant, search, anki, media, state, documents, vocabulary, dictionaries, sync, cards]:
        module.register(app)
