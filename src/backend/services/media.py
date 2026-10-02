"""Generate mnemonic images and transfer existing card media to Anki."""

import base64
import hashlib
import re
from pathlib import Path




class MediaService:
    def __init__(self, store):
        self.store = store
        self.directory = store.data_dir / 'media' / 'anki-media'
        self.directory.mkdir(parents=True, exist_ok=True)

    def status(self):
        settings = self.store.setting('media')
        return {'audio': {'configured': False, 'enabled': False, 'label': 'Audio generation removed'},
                'image': {'configured': settings['image'].get('enabled', False), 'label': 'Local mnemonic'}}

    def providers(self):
        settings = self.store.setting('media')
        settings = {**settings, 'audio': {'enabled': False}, 'voiceModels': []}
        return {'settings': settings, 'voiceModels': [], 'voices': [], 'status': self.status()}

    def image(self, expression, reading='', meaning=''):
        """Return Anki image HTML for a cached local text-based mnemonic.

        Disabled image generation returns an empty string. Enabled generation
        uses Pillow and a content-derived filename, not a remote image model.
        """
        from PIL import Image, ImageDraw, ImageFont
        if not self.store.setting('media')['image'].get('enabled'):
            return ''
        name = hashlib.sha256((expression + reading + meaning).encode()).hexdigest()[:24] + '.png'
        file = self.directory / name
        if not file.exists():
            image = Image.new('RGB', (640, 320), '#18191c')
            draw = ImageDraw.Draw(image)
            font_path = next((p for p in [Path('C:/Windows/Fonts/meiryo.ttc'), Path('/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc'), Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')] if p.exists()), None)
            font = ImageFont.truetype(str(font_path), 48) if font_path else ImageFont.load_default(size=48)
            draw.text((30, 55), expression[:11], font=font, fill='#ff713d')
            small = ImageFont.truetype(str(font_path), 24) if font_path else ImageFont.load_default(size=24)
            draw.text((30, 140), reading[:23], font=small, fill='white')
            draw.text((30, 220), meaning[:40], font=small, fill='white')
            image.save(file)
        return f'<img src="{name}">'

    def store_files(self, fields, connect):
        """Upload locally available basename-only image/audio references to Anki.

        Scan reviewed field markup, deduplicate names, and ignore paths/URLs or
        files absent from the Anki media directory. Existing sound references
        are supported even though this app no longer generates speech.
        """
        names = set()
        for value in fields.values():
            names.update(re.findall(r'\[sound:([^\]]+)\]', value))
            names.update(re.findall(r'<img[^>]+src=["\']([^"\']+)', value))
        stored = []
        for name in names:
            if Path(name).name != name or '/' in name or '\\' in name:
                continue
            file = self.directory / name
            if file.is_file():
                connect('storeMediaFile', {'filename': name, 'data': base64.b64encode(file.read_bytes()).decode()})
                stored.append(name)
        return stored
