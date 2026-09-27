"""Tokenize Japanese with Sudachi and apply dictionary and Word Bank readings."""

import hashlib
import html
import re
import threading
from functools import lru_cache
from urllib.parse import unquote

from sudachipy import dictionary, tokenizer

from .dictionary import hiragana, normalize
from ..storage.sqlite import decode, encode

KANJI = re.compile(r'[\u3400-\u9fff\uf900-\ufaff]')
RUBY = re.compile(r'\[\[RUBY:([^|]+)\|([^\]]+)\]\]')


class NLP:
    def __init__(self, store, dictionaries):
        self.store, self.dictionaries = store, dictionaries
        self.local = threading.local()
        self.known_revision = -1
        self.known_variants = set()
        self.term_variants = {}
        self.known_kanji = set()
        self.known_lock = threading.Lock()

    def tokenizer(self):
        if not hasattr(self.local, 'tokenizer'):
            source = dictionary.Dictionary()
            self.local.tokenizer = source.tokenizer() if hasattr(source, 'tokenizer') else source.create()
        return self.local.tokenizer

    @lru_cache(maxsize=2048)
    def raw(self, text):
        return tuple({'surface': m.surface(), 'base': m.dictionary_form(), 'dictionaryForm': m.normalized_form(),
                      'reading': hiragana(m.reading_form()), 'pos': m.part_of_speech()[0],
                      'name': '固有名詞' in m.part_of_speech()} for m in self.tokenizer().tokenize(text, tokenizer.Tokenizer.SplitMode.C))

    def variants(self, text):
        text = normalize(text)
        tokens = self.raw(text)
        forms = [text]
        if tokens:
            forms.extend([''.join(t['dictionaryForm'] for t in tokens), ''.join(t['reading'] for t in tokens)])
            # Inflected verbs often have trailing auxiliaries; preserve the lexical head.
            forms.extend(t['base'] for t in tokens if t['pos'] not in {'助詞', '助動詞', '補助記号', '空白'})
            forms.extend(t['dictionaryForm'] for t in tokens if t['pos'] not in {'助詞', '助動詞', '補助記号', '空白'})
        return list(dict.fromkeys(forms))

    def known(self):
        revision = self.store.revision('known_terms')
        with self.known_lock:
            if revision != self.known_revision:
                terms = set(self.store.known())
                for term in self.term_variants.keys() - terms:
                    del self.term_variants[term]
                for term in terms - self.term_variants.keys():
                    self.term_variants[term] = self.variants(term)
                values = {v for variants in self.term_variants.values() for v in variants}
                self.known_variants, self.known_revision = values, revision
                self.known_kanji = {c for term in terms for c in KANJI.findall(term)}
            return self.known_variants

    @lru_cache(maxsize=4096)
    def rank(self, term, revision):
        rows = self.store.rows('''SELECT f.value FROM dictionary_frequencies f JOIN dictionaries d ON d.id=f.dictionary_id
            WHERE f.term=? AND d.enabled_for_lookup=1''', (term,))
        ranks = [int(r['value']) for r in rows if str(r['value']).isdigit()]
        return min(ranks) if ranks else None

    def readability(self, token, protected=()):
        base = token.get('dictionaryForm') or token.get('base') or token['surface']
        known = self.known()
        if token.get('authorRuby') or token['surface'] in protected:
            return {'status': 'known', 'score': 100, 'reasons': ['author ruby']}
        if any(t in known for t in [base, token['surface'], token.get('base')]):
            return {'status': 'known', 'score': 100, 'reasons': ['Word Bank']}
        kanji = set(KANJI.findall(base))
        entry = self.dictionaries.exact(base, self.store.revision('dictionaries'))
        rank = self.rank(base, self.store.revision('dictionaries'))
        readable = bool(kanji and kanji <= self.known_kanji and entry and rank is not None and rank <= 10000 and not token.get('name'))
        return {'status': 'inferred-readable' if readable else 'unknown', 'score': 85 if readable else 0,
                'reasons': ['known kanji', 'common frequency', 'dictionary match'] if readable else []}

    def tokens(self, text):
        key = hashlib.sha256(('sudachi-v1:' + str(self.store.revision('dictionaries')) + ':' + text).encode()).hexdigest()
        row = self.store.one('SELECT tokens_json FROM python_token_cache WHERE cache_key=?', (key,))
        if row:
            return decode(row['tokens_json'], [])
        result, offset = [], 0
        for match in RUBY.finditer(text):
            result.extend(dict(t) for t in self.raw(text[offset:match.start()]))
            surface, reading = (unquote(s) for s in match.groups())
            result.append({'surface': surface, 'base': surface, 'dictionaryForm': surface, 'reading': reading, 'authorRuby': True})
            offset = match.end()
        result.extend(dict(t) for t in self.raw(text[offset:]))
        revision = self.store.revision('dictionaries')
        for token in result:
            if token.get('authorRuby'):
                continue
            entry = self.dictionaries.exact(token['surface'], revision) or self.dictionaries.exact(token['dictionaryForm'], revision)
            if entry:
                token['dictionaryForm'] = entry['term']
                # Preserve the contextual inflected reading; dictionary readings only replace exact surfaces.
                if token['surface'] == entry['term'] and entry['reading']:
                    token['reading'] = hiragana(entry['reading'])
        self.store.write('INSERT OR REPLACE INTO python_token_cache VALUES (?,?)', (key, encode(result)))
        return result

    def render(self, text, protected=(), target='', force=False):
        settings = self.store.setting('reader')
        known = self.known()
        result = []
        for t in self.tokens(text):
            surface, reading = t['surface'], t.get('reading', '')
            base = t.get('dictionaryForm') or t.get('base') or surface
            learned = any(v in known for v in [surface, base, t.get('base')])
            author, safe = t.get('authorRuby'), surface in protected
            readability = self.readability(t, protected)
            inferred_hidden = readability['status'] == 'inferred-readable' and settings.get('hideInferredReadableFurigana')
            attrs = f'data-base="{html.escape(base, quote=True)}" data-reading="{html.escape(reading, quote=True)}"'
            escaped = html.escape(surface)
            if author:
                value = f'<ruby class="author-ruby" data-author-ruby="true" {attrs}>{escaped}<rt>{html.escape(reading)}</rt></ruby>'
            elif reading and KANJI.search(surface) and not safe and (force or not inferred_hidden) and (force or not learned or settings.get('showKnownFurigana')):
                value = f'<ruby {attrs} data-readability-status="{readability["status"]}">{escaped}<rt>{html.escape(reading)}</rt></ruby>'
            else:
                value = f'<span class="lookup-token" {attrs}>{escaped}</span>'
            if target and (surface == target or base == target or t.get('base') == target):
                value = f'<b class="target-word" style="color:#ff6633">{value}</b>'
            result.append(value)
        return ''.join(result)
