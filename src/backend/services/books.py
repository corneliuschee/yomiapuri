"""Import books, prepare reader pages, preserve author furigana, and manage Trash."""

import hashlib
import html
import io
import posixpath
import re
import threading
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote, unquote
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup
from pypdf import PdfReader

from .nlp import RUBY
from ..storage.sqlite import decode, encode, now


def marker_text(text):
    return RUBY.sub(lambda m: unquote(m[1]), text)


def blocks_text(blocks):
    """Join text from chapter blocks, leaving out images and navigation links."""
    return '\n'.join(b.get('text', blocks_text(b.get('blocks', []))) for b in blocks if b.get('type') not in {'image', 'link'})


def sentences(text):
    """Split passages without breaking dialogue inside Japanese quotation marks.

    A closing outer quote, or punctuation/newlines outside quotes, ends a
    passage. Both page preparation and search use this, so changing it can
    change where saved pages and search excerpts start and end.
    """
    # Keep quoted dialogue intact, but begin/end a line at its outer boundaries.
    depth, line = 0, ''
    for c in text:
        if c == '「':
            if not depth and line.strip():
                yield line.strip()
                line = ''
            depth += 1
        line += c
        if c == '」':
            depth = max(0, depth - 1)
        if (c in '。！？!?\n' and not depth) or (c == '」' and not depth):
            if line.strip():
                yield line.strip()
            line = ''
    if line.strip():
        yield line.strip()


class BookService:
    def __init__(self, store, nlp):
        self.store, self.nlp = store, nlp
        self.media = store.data_dir / 'media'
        self.media.mkdir(exist_ok=True)
        self.lock = threading.RLock()

    def import_file(self, filename, data, title=''):
        """Read an EPUB, PDF, or UTF-8 TXT and save the book's text and files.

        Reject a file already in the library by its name or content hash. Save
        files under media/<document id> before saving SQLite rows; those files
        cannot be rolled back with SQL. Return book details and prepare pages
        later when needed. A missing PDF cover does not prevent import.
        """
        filename = Path(filename.replace('\\', '/')).name
        kind = Path(filename).suffix.lower().lstrip('.')
        if kind not in {'epub', 'pdf', 'txt'}:
            raise ValueError('Choose an EPUB, PDF, or TXT file.')
        digest = hashlib.sha256(data).hexdigest()
        if any(d.get('contentHash') == digest or d['filename'] == filename for d in self.store.documents()):
            raise FileExistsError('Duplicate copy')
        doc_id = str(uuid.uuid4())
        folder = self.media / doc_id
        folder.mkdir()
        source_name = 'source.' + kind
        (folder / source_name).write_bytes(data)
        source = f'/media/{doc_id}/{source_name}'
        cover, author, chapters = '', '', []
        detected_title = Path(filename).stem
        if kind == 'epub':
            detected_title, author, cover, chapters = self.epub(data, doc_id, folder)
        elif kind == 'pdf':
            pdf = PdfReader(io.BytesIO(data))
            detected_title = str((pdf.metadata or {}).get('/Title') or detected_title)
            author = str((pdf.metadata or {}).get('/Author') or '')
            outline = {}

            def visit(items):
                for item in items:
                    if isinstance(item, list):
                        visit(item)
                    else:
                        try:
                            outline[pdf.get_destination_page_number(item)] = item.title
                        except (ValueError, KeyError, TypeError):
                            pass
            visit(pdf.outline)
            chapter = None
            for i, page in enumerate(pdf.pages):
                if chapter is None or i in outline:
                    chapter = {'id': f'chapter-{i + 1}', 'title': outline.get(i, detected_title), 'href': f'#page={i + 1}', 'blocks': []}
                    chapters.append(chapter)
                text = page.extract_text() or ''
                chapter['blocks'].append({'type': 'pdf-page', 'pdfSrc': source, 'pageNumber': i + 1, 'text': text})
            # Cover failure must not prevent reading a valid PDF.
            try:
                import pypdfium2
                with pypdfium2.PdfDocument(data) as render_pdf:
                    page = render_pdf[0]
                    bitmap = page.render(scale=0.7)
                    bitmap.to_pil().save(folder / 'cover.png')
                    bitmap.close()
                    page.close()
                    cover = f'/media/{doc_id}/cover.png'
            except Exception:
                cover = ''
        else:
            text = data.decode('utf-8-sig')
            chapters = [{'id': 'chapter-1', 'title': detected_title, 'blocks': [{'type': 'text', 'text': text}]}]
        for chapter in chapters:
            chapter['text'] = blocks_text(chapter['blocks'])
        text = '\n'.join(c['text'] for c in chapters)
        doc = {'id': doc_id, 'title': title.strip() or detected_title, 'author': author, 'filename': filename,
               'type': kind, 'createdAt': now(), 'updatedAt': now(), 'text': text, 'chapters': chapters,
               'sourcePath': source, 'coverPath': cover, 'contentHash': digest}
        doc['authorRubyReadings'] = {unquote(m[1]): unquote(m[2]) for m in RUBY.finditer(text)}
        doc['chapterMetadata'] = [{k: c.get(k, '') for k in ['id', 'title', 'href']} for c in chapters]
        self.store.save_document(doc)
        return self.store.document(doc_id)

    def epub(self, data, doc_id, folder):
        """Read an EPUB in its specified chapter order, keeping links and images.

        Return the title, author, cover, and chapters. Store author furigana as
        RUBY markers before removing HTML so text analysis cannot replace it.
        Save images with content-based filenames. Reject ZIPs whose declared
        uncompressed contents exceed 512 MB.
        """
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sum(i.file_size for i in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError('Book archive is too large after decompression.')
            container = ET.fromstring(archive.read('META-INF/container.xml'))
            opf_path = container.find('.//{*}rootfile').attrib['full-path']
            package = ET.fromstring(archive.read(opf_path))
            base = posixpath.dirname(opf_path)
            title_node, author_node = package.find('.//{*}title'), package.find('.//{*}creator')
            title = ''.join(title_node.itertext()).strip() if title_node is not None else 'Untitled'
            author = ''.join(author_node.itertext()).strip() if author_node is not None else ''
            manifest = {item.attrib['id']: dict(item.attrib) for item in package.findall('.//{*}manifest/{*}item')}
            for item in manifest.values():
                item['path'] = posixpath.normpath(posixpath.join(base, unquote(item['href'])))
            images, cover = {}, ''
            cover_id = next((e.attrib.get('content') for e in package.findall('.//{*}meta') if e.attrib.get('name') == 'cover'), '')
            for id_, item in manifest.items():
                if not item.get('media-type', '').startswith('image/'):
                    continue
                asset = hashlib.sha256(item['path'].encode()).hexdigest()[:16] + Path(item['path']).suffix
                (folder / asset).write_bytes(archive.read(item['path']))
                images[item['path']] = f'/media/{doc_id}/{asset}'
                if id_ == cover_id or 'cover-image' in item.get('properties', ''):
                    cover = images[item['path']]
            toc = {}
            for item in manifest.values():
                if 'nav' in item.get('properties', ''):
                    soup = BeautifulSoup(archive.read(item['path']), 'html.parser')
                    for link in soup.select('nav a[href]'):
                        href = posixpath.normpath(posixpath.join(posixpath.dirname(item['path']), unquote(link['href'].split('#')[0])))
                        toc.setdefault(href, link.get_text(' ', strip=True))
                elif item.get('media-type') == 'application/x-dtbncx+xml':
                    tree = ET.fromstring(archive.read(item['path']))
                    for point in tree.findall('.//{*}navPoint'):
                        content, label = point.find('{*}content'), point.find('{*}navLabel/{*}text')
                        if content is not None and label is not None:
                            href = posixpath.normpath(posixpath.join(posixpath.dirname(item['path']), unquote(content.attrib['src'].split('#')[0])))
                            toc.setdefault(href, label.text or '')
            chapters = []
            for i, ref in enumerate(package.findall('.//{*}spine/{*}itemref')):
                item = manifest.get(ref.attrib.get('idref'))
                if not item:
                    continue
                soup = BeautifulSoup(archive.read(item['path']), 'html.parser')
                for node in soup.select('script,style'):
                    node.decompose()
                for ruby in soup.find_all('ruby'):
                    reading = ''.join(rt.get_text() for rt in ruby.find_all('rt'))
                    for rt in ruby.find_all(['rt', 'rp']):
                        rt.decompose()
                    surface = ruby.get_text()
                    ruby.replace_with(f'[[RUBY:{quote(surface, safe="")}|{quote(reading, safe="")}]]')
                heading = soup.find(re.compile('^h[1-6]$'))
                chapter_title = toc.get(item['path']) or (heading.get_text(' ', strip=True) if heading else f'Chapter {i + 1}')
                for image in soup.find_all(['img', 'image']):
                    src = image.get('src', image.get('xlink:href', image.get('href', '')))
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(item['path']), unquote(src)))
                    image.replace_with(f'\n[[IMAGE:{images.get(resolved, "")}]]\n')
                for a in soup.select('a[href]'):
                    href = a['href']
                    if not re.match(r'^[a-z]+:', href, re.I):
                        href = posixpath.normpath(posixpath.join(posixpath.dirname(item['path']), unquote(href)))
                    a.replace_with(f'\n[[LINK:{quote(href, safe="")}|{quote(a.get_text(" ", strip=True), safe="")}]]\n')
                for node in soup.find_all(['p','div','br','h1','h2','h3','li']):
                    node.insert_after('\n')
                text = (soup.body or soup).get_text()
                blocks = []
                for line in text.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    image = re.fullmatch(r'\[\[IMAGE:(.*?)\]\]', line)
                    link = re.fullmatch(r'\[\[LINK:(.*?)\|(.*?)\]\]', line)
                    if image:
                        if image[1]:
                            blocks.append({'type': 'image', 'src': image[1], 'alt': ''})
                    elif link:
                        blocks.append({'type': 'link', 'href': unquote(link[1]), 'text': unquote(link[2])})
                    else:
                        blocks.append({'type': 'text', 'text': line})
                chapters.append({'id': f'chapter-{i + 1}', 'title': chapter_title, 'href': item['path'], 'blocks': blocks})
            return title, author, cover or next(iter(images.values()), ''), chapters

    def ensure_pages(self, doc_id):
        """Prepare pages once, keeping the numbers of pages already saved.

        Only one request prepares pages at a time. Repair missing chapter or
        furigana details without splitting the book again, because bookmarks
        depend on existing page boundaries. New text pages hold about 850
        characters; image/PDF pages are separate. Page numbers start at zero.
        """
        with self.lock:
            metadata = self.store.document(doc_id)
            if not metadata:
                raise LookupError('Document not found.')
            if 'chapterMetadata' not in metadata or 'authorRubyReadings' not in metadata:
                body = self.store.document(doc_id, body=True)
                chapters = body.get('chapters', [])
                text = body.get('text', '') + '\n' + '\n'.join(blocks_text(c.get('blocks', [])) for c in chapters)
                metadata['chapterMetadata'] = [{k: c.get(k, '') for k in ['id', 'title', 'href']} for c in chapters]
                metadata['authorRubyReadings'] = {unquote(m[1]): unquote(m[2]) for m in RUBY.finditer(text)}
                # Enrich metadata only; existing page indices and sync timestamps stay intact.
                self.store.write('UPDATE documents SET metadata_json=? WHERE id=?', (encode(metadata), doc_id))
            if self.store.one('SELECT id FROM document_pages WHERE document_id=? LIMIT 1', (doc_id,)):
                return
            doc = self.store.document(doc_id, body=True)
            if not doc:
                raise LookupError('Document not found.')
            chapters = doc.get('chapters') or [{'id': 'chapter-1', 'title': doc['title'], 'blocks': [{'type': 'text', 'text': doc['text']}]}]
            pages = []
            for i, chapter in enumerate(chapters):
                chapter_id = chapter.get('id', f'chapter-{i + 1}')
                blocks = chapter.get('blocks') or [{'type': 'text', 'text': chapter.get('text', '')}]
                current, size, first = [], 0, True

                def flush():
                    nonlocal current, size, first
                    if current:
                        pages.append((chapter_id, chapter.get('title', ''), {'blocks': current, 'first': first, 'href': chapter.get('href', '')}))
                        current, size, first = [], 0, False

                for block in blocks:
                    if block.get('type') in {'image','pdf-page','pdf'}:
                        flush()
                        current = [block]
                        flush()
                        continue
                    for line in sentences(block.get('text', '')):
                        if marker_text(line).strip() == chapter.get('title', '').strip() and first and not current:
                            continue
                        length = len(marker_text(line))
                        if size + length > 850:
                            flush()
                        current.append({**block, 'text': line})
                        size += length
                flush()
            with self.store.transaction() as db:
                for index, (chapter_id, title, payload) in enumerate(pages):
                    text = blocks_text(payload['blocks'])
                    db.execute('INSERT OR REPLACE INTO document_pages VALUES (?,?,?,?,?,?,?,?,?)',
                               (f'{doc_id}:py:{index}', doc_id, index, chapter_id, title, text, encode(payload),
                                hashlib.sha256(text.encode()).hexdigest(), now()))

    def page_rows(self, doc_id):
        self.ensure_pages(doc_id)
        return self.store.rows('SELECT page_index,chapter_id,chapter_title FROM document_pages WHERE document_id=? ORDER BY page_index', (doc_id,))

    def window(self, doc_id, start=0, limit=8):
        """Render a small set of pages with the latest known words and settings.

        start counts from zero; limit is restricted to 1..24. Keep older page
        boundaries and protect names with author readings across the book.
        Show a large chapter heading only on its first page containing text.
        Return pages/start/total. Rendering may save new word tokens in SQLite.
        """
        self.ensure_pages(doc_id)
        document = self.store.document(doc_id)
        rows = self.store.rows('SELECT * FROM document_pages WHERE document_id=? ORDER BY page_index LIMIT ? OFFSET ?', (doc_id, min(24, max(1, limit)), max(0, start)))
        result = []
        for row in rows:
            payload = decode(row['html'], None)
            if not isinstance(payload, dict) or 'blocks' not in payload:
                # Keep existing page boundaries: bookmarks and progress refer to these indices.
                previous = self.store.one('SELECT chapter_id FROM document_pages WHERE document_id=? AND page_index<? ORDER BY page_index DESC LIMIT 1', (doc_id, row['page_index']))
                payload = {'blocks': [{'type': 'text', 'text': row['text']}],
                           'first': not previous or previous['chapter_id'] != row['chapter_id']}
            protected = set(document.get('authorRubyReadings', {})) | {unquote(m[1]) for m in RUBY.finditer(row['text'])}
            rendered = []
            for block in payload['blocks']:
                if block.get('type') == 'image':
                    rendered.append(f'<figure class="book-image"><img src="{html.escape(block.get("src", ""), quote=True)}" alt="{html.escape(block.get("alt", ""), quote=True)}"></figure>')
                elif block.get('type') in {'pdf-page','pdf'}:
                    src, page = html.escape(block.get('pdfSrc', ''), quote=True), int(block.get('pageNumber', 1))
                    rendered.append(f'<section class="pdf-page-block pdf-page-render" data-pdf-src="{src}" data-pdf-page="{page}"><div class="pdf-canvas-wrap"><canvas class="pdf-canvas"></canvas><div class="pdf-text-layer" aria-hidden="true"></div><div class="pdf-link-layer"></div></div><div class="pdf-extracted-text">{html.escape(block.get("text", ""))}</div></section>')
                elif block.get('type') == 'link':
                    href = block.get('href', '')
                    if re.match(r'^(javascript|data|vbscript):', href, re.I):
                        href = '#'
                    rendered.append(f'<p class="book-line"><a class="reader-internal-link" data-epub-href="{html.escape(href, quote=True)}" href="{html.escape(href, quote=True)}">{html.escape(block.get("text", ""))}</a></p>')
                else:
                    rendered.append('<p class="book-line">' + self.nlp.render(block.get('text', ''), protected) + '</p>')
            title = html.escape(row['chapter_title'])
            image_only = all(b.get('type') in {'image', 'pdf-page','pdf'} for b in payload['blocks'])
            heading = f'<div class="reader-chapter-heading"><h2>{title}</h2></div>' if payload['first'] and not image_only else ''
            content = f'<section class="reader-page-frame"><div class="reader-page-chapter-title">{title}</div><div class="reader-page-content">{heading}{"".join(rendered)}</div></section>'
            result.append({'index': row['page_index'], 'chapterId': row['chapter_id'], 'html': content})
        return {'pages': result, 'start': start, 'total': len(self.page_rows(doc_id))}

    def response(self, doc_id, page=None):
        """Build the book response, rendering only eight pages near the reader.

        Use the saved position unless page is supplied (counting from zero).
        Include a placeholder for every other page, marked unloaded. Keep the
        old candidate-list fields empty; no mining or analytics runs here.
        """
        doc = self.store.document(doc_id)
        if not doc:
            raise LookupError('Document not found.')
        rows = self.page_rows(doc_id)
        doc = self.store.document(doc_id)
        progress = self.store.progress(doc_id)
        current = int(page if page is not None else progress.get('page', 0))
        start = max(0, min(current - 4, len(rows) - 8))
        window = {p['index']: p for p in self.window(doc_id, start)['pages']}
        rows = self.page_rows(doc_id)
        chapters = doc.get('chapterMetadata') or list({r['chapter_id']: {'id': r['chapter_id'], 'title': r['chapter_title']} for r in rows}.values())
        return {**doc, 'html': '', 'chapters': chapters, 'progress': progress, 'candidates': [], 'readabilitySuggestions': [],
                'pages': [window.get(r['page_index'], {'chapterId': r['chapter_id'], 'html': '', 'unloaded': True}) for r in rows]}

    def trash(self, doc_id, restore=False):
        """Move a book into or out of Trash as one database change.

        Record deletions for device sync; remove that record on restore. Keep
        progress, though SQLite may remove generated pages when the active book
        row is deleted. Keep search rows until permanent deletion, but searches
        exclude Trash books. Update the books change counter in either direction.
        """
        source, target = ('trash_documents', 'documents') if restore else ('documents', 'trash_documents')
        body_source, body_target = ('trash_document_bodies', 'document_bodies') if restore else ('document_bodies', 'trash_document_bodies')
        with self.store.transaction() as db:
            if not self.store.one(f'SELECT id FROM {source} WHERE id=?', (doc_id,)):
                raise LookupError('Document not found.')
            db.execute(f'INSERT OR REPLACE INTO {target} SELECT * FROM {source} WHERE id=?', (doc_id,))
            db.execute(f'UPDATE {target} SET order_index=(SELECT COALESCE(MAX(order_index),0)+1 FROM {target}),updated_at=? WHERE id=?', (now(), doc_id))
            db.execute(f'INSERT OR REPLACE INTO {body_target} SELECT * FROM {body_source} WHERE document_id=?', (doc_id,))
            db.execute(f'DELETE FROM {body_source} WHERE document_id=?', (doc_id,))
            db.execute(f'DELETE FROM {source} WHERE id=?', (doc_id,))
            if restore:
                db.execute('DELETE FROM document_tombstones WHERE document_id=?', (doc_id,))
            else:
                db.execute('INSERT OR REPLACE INTO document_tombstones(document_id,deleted_at) VALUES (?,?)', (doc_id, now()))
            self.store.bump('documents', db)
        return self.store.document(doc_id, trash=not restore)

    def delete_permanently(self, doc_id=None):
        """Delete one Trash book, or empty Trash, and return the number removed.

        Remove its pages, progress, and search rows in the same database change.
        Keep deletion records for sync so another device cannot restore the book
        by mistake. Media files and exported Anki notes stay where they are.
        """
        with self.store.transaction() as db:
            if doc_id is not None:
                if not db.execute('SELECT 1 FROM trash_documents WHERE id=?', (doc_id,)).fetchone():
                    raise LookupError('Document not found in Trash.')
                ids = [doc_id]
            else:
                ids = [row['id'] for row in db.execute('SELECT id FROM trash_documents')]
            for deleted_id in ids:
                db.execute('DELETE FROM python_search_fts WHERE chunk_id IN (SELECT id FROM python_search_chunks WHERE document_id=?)', (deleted_id,))
                for table in ['python_search_chunks', 'python_index_documents', 'document_pages', 'trash_document_bodies', 'reading_progress']:
                    db.execute(f'DELETE FROM {table} WHERE document_id=?', (deleted_id,))
                db.execute('DELETE FROM trash_documents WHERE id=?', (deleted_id,))
            self.store.bump('documents', db)
        return len(ids)
