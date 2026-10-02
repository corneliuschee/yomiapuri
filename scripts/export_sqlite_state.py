"""Export canonical SQLite records to JSON for manual backup or inspection."""

import json
from pathlib import Path
import sys

from src.backend.config import DATA
from src.backend.storage.sqlite import Store, decode
from src.backend.services.dictionary import DictionaryService


def main():
    """Write private JSON inspection exports, explicitly loading complete bodies.

    This compatibility export is not a complete filesystem backup: media stays
    on disk and journals/tombstones are not all included. Settings can contain
    credentials, so keep the output outside version control and shared folders.
    """
    output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DATA / 'exports'
    output.mkdir(parents=True, exist_ok=True)
    store = Store(DATA)
    try:
        dictionaries = DictionaryService(store).metadata()
        state = {k: store.setting(k) for k in ['reader','anki','media','ai','sync','dictionarySettings']}
        known = store.known()
        state.update(documents=[store.document(d['id'], body=True) for d in store.documents()], progress=store.progress(),
                     knownTerms=list(known), knownTermMeta=known, dictionaries=dictionaries,
                     cards=[decode(r['payload_json'], {}) for r in store.rows('SELECT payload_json FROM cards ORDER BY order_index')],
                     templates=[decode(r['payload_json'], {}) for r in store.rows('SELECT payload_json FROM templates ORDER BY order_index')],
                     trash={'documents': [store.document(d['id'], body=True, trash=True) for d in store.documents(True)],
                            'knownTerms': [decode(r['entry_json'], {}) for r in store.rows('SELECT entry_json FROM trash_known_terms')]})
        with (output / 'state.json').open('w', encoding='utf8') as file:
            json.dump(state, file, ensure_ascii=False)
        with (output / 'dictionaries.json').open('w', encoding='utf8') as file:
            file.write('{"dictionaries":[')
            for index, dictionary in enumerate(dictionaries):
                if index:
                    file.write(',')
                entries = []
                for row in store.rows('SELECT e.term,e.reading,c.definitions_json,c.details_json,c.tags_json FROM dictionary_entries e JOIN dictionary_entry_content c ON c.id=e.content_id WHERE e.dictionary_id=? ORDER BY e.sequence', (dictionary['id'],)):
                    entries.append({'term': row['term'], 'reading': row['reading'], 'definitions': decode(row['definitions_json'], []), 'details': decode(row['details_json'], []), 'tags': decode(row['tags_json'], [])})
                frequencies = store.rows('SELECT term,reading,value,display_value AS displayValue FROM dictionary_frequencies WHERE dictionary_id=? ORDER BY sequence', (dictionary['id'],))
                json.dump({**dictionary, 'termEntries': entries, 'frequencyEntries': frequencies}, file, ensure_ascii=False)
            file.write(']}')
    finally:
        store.close()
    print(f'Exported to {output}. Treat these files as private: they include local settings.')


if __name__ == '__main__':
    main()
