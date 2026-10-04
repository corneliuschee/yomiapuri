"""Start/stop the local llama.cpp model and send chat answers to the reader."""

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pykakasi import kakasi

from ..storage.sqlite import encode

PROMPTS = {
    'translate': 'You are an expert Japanese-to-English literary localizer. Translate only the provided Japanese text into fluent, natural English. Preserve tone and use provided author readings for names. Output only the translation, without preamble or notes.',
    'explain': 'You are a Japanese language tutor. Explain grammar and vocabulary concisely in English. Resolve references to the previous or second sentence against the immediately preceding user message, not unrelated page text.',
    'ask': 'You are the Japanese reading assistant inside YomiApuri. Use only the supplied text and conversation. Library retrieval is not enabled. Never claim to have searched books. Say when context is insufficient.',
    'recap': 'Summarize only supplied already-read text without speculation or spoilers. If none is supplied, respond exactly: No historical reading context available for this document yet.'}


class AIService:
    def __init__(self, store):
        self.store = store
        self.process = None
        self.loaded_model = ''
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()
        self.active = False
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=5))
        self.idle_task = None

    async def close(self):
        if self.idle_task:
            self.idle_task.cancel()
            try:
                await self.idle_task
            except asyncio.CancelledError:
                pass
        await self.stop()
        await self.client.aclose()

    async def stop(self):
        """Stop a model started by this app, but not while it is answering.

        Wait ten seconds for a normal shutdown before forcing it to stop.
        Never stop model servers that were started outside this app.
        """
        if self.active:
            raise ValueError('Wait for the current response before stopping the assistant.')
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.to_thread(self.process.wait, 10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                await asyncio.to_thread(self.process.wait)
        self.process, self.loaded_model = None, ''
        return self.status()

    def status(self):
        running = self.process is not None and self.process.poll() is None
        return {'running': running, 'count': int(running), 'busy': self.active,
                'modelId': self.loaded_model, 'idleTimeoutSeconds': int(os.getenv('LLAMA_IDLE_TIMEOUT_SECONDS', '600'))}

    async def idle_watch(self):
        while True:
            await asyncio.sleep(15)
            seconds = int(os.getenv('LLAMA_IDLE_TIMEOUT_SECONDS', '600'))
            if seconds > 0 and not self.active and time.monotonic() - self.last_used >= seconds:
                async with self.lock:
                    if not self.active:
                        await self.stop()

    async def ready(self, endpoint):
        try:
            url = urlsplit(endpoint)
            result = await self.client.get(f'{url.scheme}://{url.netloc}/health', timeout=2)
            return result.status_code == 200
        except httpx.HTTPError:
            return False

    async def ensure(self, model_id):
        """Find a working chat server, starting the selected local model if needed.

        The caller must hold the assistant lock. Reuse a working server or switch
        the model this app started. Check file paths and wait up to 120 seconds
        for startup. Auto-start is allowed only for a local address. Model logs
        go to data/llama.
        """
        settings = self.store.setting('ai')
        model = next((m for m in settings['models'] if m['id'] == model_id), None)
        if not model:
            raise ValueError('Unknown local AI model.')
        endpoint = model.get('localEndpoint') or os.getenv('SUGOI_Q3_ENDPOINT' if 'q3' in model_id else 'SUGOI_Q4_ENDPOINT') or os.getenv('LOCAL_TRANSLATION_LLAMA_ENDPOINT') or 'http://127.0.0.1:8094/v1/chat/completions'
        if self.loaded_model and self.loaded_model != model_id:
            await self.stop()
        if await self.ready(endpoint):
            return endpoint
        model_path = model.get('localPath') or os.getenv('SUGOI_Q3_MODEL_PATH' if 'q3' in model_id else 'SUGOI_Q4_MODEL_PATH', '')
        server_path = os.getenv('LLAMA_SERVER_PATH', '')
        if not model_path or not Path(model_path).is_file() or not server_path or not Path(server_path).is_file():
            raise ValueError('Configure LLAMA_SERVER_PATH and SUGOI_Q4_MODEL_PATH (or SUGOI_Q3_MODEL_PATH) to use the local assistant.')
        if urlsplit(endpoint).hostname not in {'127.0.0.1', 'localhost'}:
            raise ValueError('Automatic llama-server startup requires a loopback endpoint.')
        args = [server_path, '--model', model_path, '--host', '127.0.0.1', '--port', str(urlsplit(endpoint).port or 8094),
                '--ctx-size', os.getenv('LOCAL_TRANSLATION_CONTEXT_SIZE', '1536'), '--parallel', '1', '--no-webui',
                '--flash-attn', 'on', '--n-gpu-layers', os.getenv('LLAMA_GPU_LAYERS', '24' if os.name == 'nt' else '16')]
        if os.getenv('LLAMA_NO_WARMUP', 'true').lower() in {'true', '1'}:
            args.append('--no-warmup')
        logs = self.store.data_dir / 'llama'
        logs.mkdir(exist_ok=True)
        with (logs / 'python-server.log').open('ab') as log:
            self.process = subprocess.Popen(args, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.loaded_model = model_id
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise ValueError('llama-server exited while loading. Check data/llama/python-server.log.')
            if await self.ready(endpoint):
                return endpoint
            await asyncio.sleep(.5)
        await self.stop()
        raise ValueError('Local model startup timed out.')

    async def events(self, body):
        """Send response details, answer pieces, and a final result to the reader.

        Only one answer runs at a time. Choose a task from the question and add
        romanized author-provided names. Send at most six earlier messages plus
        this question. This does not search books or fetch page text. Model
        failures produce a final unavailable result; always clear the busy flag.
        """
        question = str(body.get('question', '')).strip()[:2500]
        intent = 'translate' if re.search(r'translat', question, re.I) else 'recap' if re.search(r'recap|summari', question, re.I) else 'explain' if re.search(r'grammar|explain|meaning', question, re.I) else 'ask'
        result = {'intent': intent, 'task': intent, 'question': question, 'answer': '', 'terms': [], 'citations': [],
                  'includeCitations': False, 'status': {'source': 'current-message', 'retrieval': 'disabled', 'citations': False}}
        yield 'meta', result
        try:
            if not question:
                raise ValueError('Type a message before sending.')
            if not self.store.setting('ai')['translation'].get('enabled', True):
                raise ValueError('The AI assistant is disabled.')
            async with self.lock:
                model_id = body.get('modelId') or self.store.setting('ai')['translation']['modelId']
                endpoint = await self.ensure(model_id)
                self.active = True
                try:
                    prompt = self.store.setting('ai').get('assistant', {}).get('prompts', {}).get(intent) or PROMPTS[intent]
                    doc = self.store.document(body.get('documentId')) or {}
                    readings = doc.get('authorRubyReadings', {})
                    if readings:
                        converter = kakasi()
                        names = [f'{name}: {reading} ({"".join(p["hepburn"] for p in converter.convert(reading)).title()})' for name, reading in readings.items()]
                        prompt += '\nAuthor-provided name readings (use these spellings, not default kanji readings):\n' + '\n'.join(names[:100])
                    history = [{'role': m['role'], 'content': str(m.get('content', ''))[:2500]} for m in body.get('history', [])[-6:] if m.get('role') in {'user', 'assistant'}]
                    messages = [{'role': 'system', 'content': prompt}, *history, {'role': 'user', 'content': question}]
                    async with self.client.stream('POST', endpoint, json={'messages': messages, 'stream': True, 'max_tokens': 768, 'temperature': .1 if intent == 'translate' else .25}) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith('data:') or line[5:].strip() == '[DONE]':
                                continue
                            payload = json.loads(line[5:])
                            delta = (payload.get('choices') or [{}])[0].get('delta', {}).get('content', '')
                            if delta:
                                result['answer'] += delta
                                yield 'delta', {'delta': delta}
                    result['ai'] = {'available': True, 'model': model_id}
                finally:
                    self.active = False
                    self.last_used = time.monotonic()
        except (ValueError, httpx.HTTPError, OSError) as error:
            result['ai'] = {'available': False, 'reason': str(error), 'model': None}
            if not result['answer']:
                result['answer'] = 'The local assistant is unavailable. ' + str(error)
        if intent == 'translate':
            result['translation'] = {**result['ai'], 'translatedText': result['answer'] if result['ai']['available'] else ''}
        yield 'done', result

    async def stream(self, body):
        async for event, data in self.events(body):
            yield f'event: {event}\ndata: {encode(data)}\n\n'
