"""Generate local card media and transfer referenced files to Anki."""

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from ..config import ROOT


def run(args, env=None):
    return subprocess.run(args, check=True, capture_output=True, text=True, encoding='utf-8', timeout=180,
                          env={**os.environ, **(env or {})}, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0).stdout


class MediaService:
    def __init__(self, store):
        self.store = store
        self.directory = store.data_dir / 'media' / 'anki-media'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.voices_cache = None

    def voices(self):
        if self.voices_cache is None:
            self.voices_cache = []
            if os.name == 'nt':
                try:
                    output = run(['powershell.exe', '-NoProfile', '-Command',
                                  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; @($s.GetInstalledVoices() | ForEach-Object { @{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name} }) | ConvertTo-Json -Compress'])
                    value = json.loads(output.lstrip('\ufeff'))
                    self.voices_cache = value if isinstance(value, list) else [value]
                except (OSError, subprocess.SubprocessError, ValueError):
                    pass
        return self.voices_cache

    def status(self):
        settings = self.store.setting('media')
        audio = settings['audio']
        voice = audio.get('voiceName') or next((v['name'] for v in self.voices() if v['culture'].startswith('ja')), '')
        return {'audio': {'configured': bool(audio.get('enabled') and (voice or audio.get('voiceModelId'))),
                          'enabled': audio.get('enabled', False), 'label': voice or 'Local voice model'},
                'image': {'configured': settings['image'].get('enabled', False), 'label': 'Local mnemonic'}}

    def providers(self):
        settings = self.store.setting('media')
        return {'settings': settings, 'voiceModels': settings.get('voiceModels', []), 'voices': self.voices(), 'status': self.status()}

    def audio(self, text):
        settings = self.store.setting('media')
        audio = settings['audio']
        if not audio.get('enabled'):
            return ''
        key = hashlib.sha256((text + json.dumps(audio, sort_keys=True)).encode()).hexdigest()[:24]
        file = self.directory / f'{key}.wav'
        if not file.exists():
            model = next((m for m in settings.get('voiceModels', []) if m['id'] == audio.get('voiceModelId')), None)
            if model:
                model_id = model['url'].removeprefix('https://huggingface.co/').rstrip('/')
                default_python = ROOT / '.venv-liquidai' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
                python = os.getenv('LIQUIDAI_PYTHON_PATH') or os.getenv('LOCAL_TTS_PYTHON_PATH') or (str(default_python) if default_python.is_file() else sys.executable)
                run([python, str(ROOT / 'src/backend/runtimes/liquidai_tts.py'), '--model', model_id, '--text', text, '--out', str(file)])
            elif os.name == 'nt':
                voice = audio.get('voiceName') or next((v['name'] for v in self.voices() if v['culture'].startswith('ja')), '')
                if not voice:
                    raise ValueError('No Japanese system voice is installed.')
                run(['powershell.exe', '-NoProfile', '-Command',
                     'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; try {$s.SelectVoice($env:YOMI_VOICE); $s.Rate=[int]$env:YOMI_RATE; $s.SetOutputToWaveFile($env:YOMI_OUT); $s.Speak($env:YOMI_TEXT)} finally {$s.Dispose()}'],
                    {'YOMI_VOICE': voice, 'YOMI_RATE': str(min(10, max(-10, int(audio.get('rate', 0))))), 'YOMI_OUT': str(file), 'YOMI_TEXT': text})
            else:
                raise ValueError('Configure a local voice model to generate audio on this platform.')
        return f'[sound:{file.name}]'

    def image(self, expression, reading='', meaning=''):
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
