"""Search book text with SQLite FTS5 and refresh only changed books' search rows."""

import hashlib
import threading

from .books import marker_text, sentences
from ..storage.sqlite import now


class SearchService:
    def __init__(self, store, books, nlp):
        self.store, self.books, self.nlp = store, books, nlp
        self.lock = threading.Lock()

    def status(self):
        saved = self.store.setting('pythonSearch')
        stale = saved.get('documentsRevision') != self.store.revision('documents') or saved.get('dictionaryRevision') != self.store.revision('dictionaries')
        count = self.store.one('SELECT COUNT(*) AS n FROM python_search_chunks c JOIN documents d ON d.id=c.document_id')['n']
        status = {**saved, 'ready': bool(saved.get('updatedAt')), 'stale': stale, 'chunks': count,
                  'tokenizerMode': 'sudachi-dictionary', 'storage': 'sqlite-fts5', 'provider': 'sqlite-fts5'}
        return {**status, 'textSearch': status, 'fts': status}

    def refresh(self):
        """Update search excerpts for changed books; skip unchanged books.

        Reject a second refresh while one is running. Compare each book's text
        hash and dictionary change counter with the saved values. Split text
        outside the write transaction, then replace only that book's search rows
        if it is still in the library. Always release the lock. Save the starting
        counters so edits made during refresh still show as needing an update.
        No embedding model or vectors are involved.
        """
        if not self.lock.acquire(blocking=False):
            raise FileExistsError('Text index refresh is already running.')
        try:
            inserted, skipped, deleted = 0, 0, 0
            revision = self.store.revision('documents')
            dictionary_revision = self.store.revision('dictionaries')
            for doc in self.store.documents():
                source = self.store.one('SELECT source_hash FROM document_bodies WHERE document_id=?', (doc['id'],))
                fingerprint = hashlib.sha256((str(source) + ':' + str(dictionary_revision)).encode()).hexdigest()
                old = self.store.one('SELECT fingerprint FROM python_index_documents WHERE document_id=?', (doc['id'],))
                if old and old['fingerprint'] == fingerprint:
                    skipped += 1
                    continue
                self.books.ensure_pages(doc['id'])
                chunks = []
                # Read bounded pages, and do tokenization outside the write transaction.
                for page in self.books.page_rows(doc['id']):
                    row = self.store.one('SELECT text FROM document_pages WHERE document_id=? AND page_index=?', (doc['id'], page['page_index']))
                    for index, sentence in enumerate(sentences(row['text'])):
                        raw = marker_text(sentence)
                        if not raw.strip():
                            continue
                        tokens = self.nlp.tokens(sentence)
                        terms = dict.fromkeys(v for t in tokens for v in [t['surface'], t.get('base', ''), t.get('dictionaryForm', ''), t.get('reading', '')] if v.strip())
                        chunks.append((f"{doc['id']}:{page['page_index']}:{index}", doc['id'], page['page_index'], page['chapter_id'], page['chapter_title'], raw, ' '.join(terms)))
                with self.store.transaction() as db:
                    # Recheck active status after slow tokenization; a concurrent delete wins.
                    if not db.execute('SELECT 1 FROM documents WHERE id=?', (doc['id'],)).fetchone():
                        continue
                    db.execute('DELETE FROM python_search_fts WHERE chunk_id IN (SELECT id FROM python_search_chunks WHERE document_id=?)', (doc['id'],))
                    deleted += db.execute('DELETE FROM python_search_chunks WHERE document_id=?', (doc['id'],)).rowcount
                    db.executemany('INSERT INTO python_search_chunks VALUES (?,?,?,?,?,?)', [c[:6] for c in chunks])
                    db.executemany('INSERT INTO python_search_fts VALUES (?,?)', [(c[0], c[6]) for c in chunks])
                    db.execute('INSERT OR REPLACE INTO python_index_documents VALUES (?,?)', (doc['id'], fingerprint))
                inserted += len(chunks)
            self.store.settings('pythonSearch', {'updatedAt': now(), 'rebuiltAt': now(), 'documentsRevision': revision,
                                                 'dictionaryRevision': dictionary_revision, 'inserted': inserted, 'skipped': skipped, 'deleted': deleted})
            return self.status()
        finally:
            self.lock.release()

    def search(self, query, document_id='', limit=30):
        """Return exact text matches first, then SQLite's ranked word matches.

        Escape query forms for FTS5 MATCH and remove duplicate results. Search
        only library books, optionally just one. BM25 is SQLite's word-match
        ranking function; this is not vector search. Page numbers start at zero.
        Unread pages are allowed, so these results are not spoiler-safe AI input.
        """
        query = str(query or '').strip()
        if not query:
            return {'query': query, 'results': []}
        limit = min(100, max(1, int(limit)))
        scope = ' AND c.document_id=?' if document_id else ''
        params = [document_id] if document_id else []
        columns = 'c.*,d.title'
        exact = self.store.rows(f'SELECT {columns} FROM python_search_chunks c JOIN documents d ON d.id=c.document_id WHERE instr(c.text,?)>0{scope} ORDER BY c.page LIMIT ?', [query, *params, limit])
        variants = self.nlp.variants(query)
        match = ' OR '.join('"' + v.replace('"', '""') + '"' for v in variants if v.strip())
        ranked = self.store.rows(f'''SELECT {columns},bm25(python_search_fts) AS bm25 FROM python_search_fts
            JOIN python_search_chunks c ON c.id=python_search_fts.chunk_id JOIN documents d ON d.id=c.document_id
            WHERE python_search_fts MATCH ?{scope} ORDER BY bm25 LIMIT ?''', [match, *params, limit]) if match else []
        results = {}
        for row in [*exact, *ranked]:
            results.setdefault(row['id'], {**row, 'documentId': row['document_id'], 'chapterTitle': row['chapter_title'],
                                           'type': 'sentence', 'score': 1 if query in row['text'] else -row.get('bm25', 0),
                                           'citation': {'documentId': row['document_id'], 'title': row['title'], 'page': row['page'], 'chapterTitle': row['chapter_title']}})
        return {'query': query, 'results': list(results.values())[:limit]}
