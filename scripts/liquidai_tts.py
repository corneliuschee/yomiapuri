import argparse
import os
import sys

import soundfile as sf
import torch
from liquid_audio import ChatState, LFM2AudioModel, LFM2AudioProcessor


def main():
    parser = argparse.ArgumentParser(description="Generate Japanese TTS with LiquidAI LFM2.5 Audio.")
    parser.add_argument("--model", default="LiquidAI/LFM2.5-Audio-1.5B-JP")
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=64)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    processor = LFM2AudioProcessor.from_pretrained(args.model, device=device).eval()
    model = LFM2AudioModel.from_pretrained(args.model, device=device, dtype=dtype).eval()

    chat = ChatState(processor)
    chat.new_turn("system")
    chat.add_text("Perform TTS in japanese.")
    chat.end_turn()

    chat.new_turn("user")
    chat.add_text(args.text)
    chat.end_turn()

    chat.new_turn("assistant")
    audio_out = []
    with torch.inference_mode():
        for token in model.generate_sequential(
            **chat,
            max_new_tokens=args.max_new_tokens,
            audio_temperature=args.temperature,
            audio_top_k=args.top_k,
        ):
            if token.numel() > 1:
                audio_out.append(token)

    if len(audio_out) < 2:
        raise RuntimeError("LiquidAI did not return enough audio tokens for TTS output.")

    audio_codes = torch.stack(audio_out[:-1], 1).unsqueeze(0)
    waveform = processor.decode(audio_codes)
    sf.write(args.out, waveform.detach().cpu()[0], 24_000)
    print(args.out)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
