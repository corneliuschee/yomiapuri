"""Load .env, locate the data/frontend folders, and define default settings."""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / '.env', override=False)
DATA = Path(os.environ.get('DATA_DIR', ROOT / 'data')).resolve()
FRONTEND = ROOT / 'src' / 'frontend'
MEDIA = DATA / 'media'


def defaults():
    """Return a new set of defaults to fill gaps in saved settings.

    Keep the old ``ml`` and disabled audio keys because existing settings and
    API responses still use them. This does not start those removed features.
    """
    return {
        'reader': {'hideInferredReadableFurigana': False, 'showKnownFurigana': False},
        'dictionarySettings': {'prefixWildcardSearch': False},
        'anki': {'connectUrl': 'http://127.0.0.1:8765', 'deckName': '', 'modelName': '',
                 'fieldMap': {}, 'modelFieldMaps': {}, 'autoLaunchAnki': True, 'instantExport': False,
                 'ankiExecutablePath': str(Path.home() / 'AppData/Local/Programs/Anki/anki.exe')},
        'media': {'audio': {'enabled': False, 'provider': 'local-system-tts', 'voiceName': '', 'rate': 0,
                             'voiceModelId': ''}, 'image': {'enabled': False, 'provider': 'local-mnemonic'}, 'voiceModels': []},
        'ai': {'translation': {'enabled': True, 'modelId': 'sugoi-14b-ultra-q4-k-m'},
               'assistant': {'prompts': {}}, 'models': [
                   {'id': 'sugoi-14b-ultra-q4-k-m', 'name': 'Sugoi 14B Ultra Q4_K_M', 'provider': 'llama.cpp'},
                   {'id': 'sugoi-14b-ultra-q3-k-m', 'name': 'Sugoi 14B Ultra Q3_K_M', 'provider': 'llama.cpp'}]},
        'sync': {'enabled': False, 'status': 'signed-out', 'deviceName': 'This device', 'lastError': ''},
        'ml': {'indexStale': True, 'indexStaleReason': 'Text index not built.'},
    }
