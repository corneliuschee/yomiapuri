"""Register native FastAPI route groups in a predictable order."""

from . import assistant, search, integrations, state, documents, wordbank, dictionaries, sync, cards


def register_routes(app):
    for module in [assistant, search, integrations, state, documents, wordbank, dictionaries, sync, cards]:
        module.register(app)
