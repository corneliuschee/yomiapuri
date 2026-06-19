import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
import torch
import torch.nn.functional as F
from liquid_audio import ChatState, LFM2AudioModel, LFM2AudioProcessor


class LiquidAiTts:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self.processor = LFM2AudioProcessor.from_pretrained(model_id, device=self.device).eval()
        self.model = LFM2AudioModel.from_pretrained(model_id, device=self.device, dtype=self.dtype).eval()

    def synthesize(self, text: str, output_path: str, max_new_tokens: int = 512, rate: int = 0):
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        chat = ChatState(self.processor)
        chat.new_turn("system")
        chat.add_text("Perform TTS in japanese.")
        chat.end_turn()

        chat.new_turn("user")
        chat.add_text(text)
        chat.end_turn()

        chat.new_turn("assistant")
        audio_out = []
        with torch.inference_mode():
            for token in self.model.generate_sequential(
                **chat,
                max_new_tokens=max_new_tokens,
                audio_temperature=0.8,
                audio_top_k=64,
            ):
                if token.numel() > 1:
                    audio_out.append(token)

        if len(audio_out) < 2:
            raise RuntimeError("LiquidAI did not return enough audio tokens for TTS output.")

        audio_codes = torch.stack(audio_out[:-1], 1).unsqueeze(0)
        waveform = self.processor.decode(audio_codes)
        waveform = apply_rate(waveform, rate)
        sf.write(output_path, waveform.detach().cpu()[0], 24_000)


def make_handler(engine: LiquidAiTts):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/health":
                self.send_error(404)
                return
            self.send_json({"ok": True, "model": engine.model_id, "device": engine.device, "supports_rate": True})

        def do_POST(self):
            if self.path != "/tts":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                text = str(payload.get("text", "")).strip()
                output_path = str(payload.get("out", "")).strip()
                max_new_tokens = int(payload.get("max_new_tokens", 512))
                rate = int(payload.get("rate", 0))
                if not text or not output_path:
                    self.send_json({"ok": False, "error": "text and out are required"}, status=400)
                    return
                engine.synthesize(text, output_path, max_new_tokens=max_new_tokens, rate=rate)
                self.send_json({"ok": True, "out": output_path})
            except Exception as error:
                self.send_json({"ok": False, "error": str(error)}, status=500)

        def send_json(self, payload, status=200):
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, _format, *_args):
            return

    return Handler


def apply_rate(waveform: torch.Tensor, rate: int) -> torch.Tensor:
    rate = max(-10, min(10, int(rate or 0)))
    if rate == 0:
        return waveform
    speed = 2 ** (rate / 10)
    samples = waveform.shape[-1]
    target_samples = max(1, int(samples / speed))
    return F.interpolate(
        waveform.unsqueeze(1).float(),
        size=target_samples,
        mode="linear",
        align_corners=False,
    ).squeeze(1).to(waveform.dtype)


def main():
    parser = argparse.ArgumentParser(description="Persistent LiquidAI TTS server.")
    parser.add_argument("--model", default="LiquidAI/LFM2.5-Audio-1.5B-JP")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=38941)
    args = parser.parse_args()

    engine = LiquidAiTts(args.model)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    print(f"LiquidAI TTS ready on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise
