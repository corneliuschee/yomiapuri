"""Create word/reading images for cards and copy local card media into Anki."""

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
        """Draw a word, reading, and meaning as an image and return its HTML tag.

        Return an empty string when images are disabled. Use Pillow, not an AI
        image model. Reuse an existing file when the text has not changed.
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
        """Copy local images/audio named in the reviewed card fields into Anki.

        Copy each filename once. Ignore paths, URLs, and files missing from the
        app's Anki media folder. Existing sound files still work even though
        the app no longer generates speech.
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
