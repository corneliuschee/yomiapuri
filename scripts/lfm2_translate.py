import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    text = str(payload.get("text") or "").strip()
    model_info = payload.get("model") or {}
    model_id = hf_model_id(str(model_info.get("url") or "")) or "LiquidAI/LFM2-350M-ENJP-MT"
    target_language = str(payload.get("targetLanguage") or "en").lower()
    if not text:
        print(json.dumps({"translation": ""}), flush=True)
        return

    translation = translate_once(
        model_id=model_id,
        text=text,
        system_prompt=system_prompt_for_target(target_language),
    )
    print(json.dumps({"translation": translation}), flush=True)


def translate_once(model_id: str, text: str, system_prompt: str) -> str:
    # Imports stay inside the request path so simple --check style invocations do not load the model.
    import torch
    from transformers import AutoTokenizer

    from transformers import AutoModelForCausalLM

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        trust_remote_code=True,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    if not torch.cuda.is_available():
        model.to("cpu")
    model.eval()

    chat = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": text},
    ]
    prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
    if not isinstance(prompt, str):
        prompt = str(prompt)
    inputs = tokenizer(prompt, return_tensors="pt")
    device = next(model.parameters()).device
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max(64, min(1024, int(len(text) * 1.6) + 64)),
            do_sample=True,
            temperature=0.5,
            top_p=1.0,
            repetition_penalty=1.05,
            pad_token_id=tokenizer.eos_token_id,
        )

    generated = output_ids[0][inputs["input_ids"].shape[-1]:]
    decoded = tokenizer.decode(generated, skip_special_tokens=True).strip()
    return cleanup_translation(decoded)


def system_prompt_for_target(target_language: str) -> str:
    if target_language.startswith("ja") or target_language in {"jp", "jpn", "japanese"}:
        return "Translate to Japanese."
    return "Translate to English."


def hf_model_id(url: str) -> str:
    marker = "huggingface.co/"
    if marker not in url:
        return ""
    value = url.split(marker, 1)[1].strip("/")
    parts = [part for part in value.split("/") if part]
    return "/".join(parts[:2]) if len(parts) >= 2 else ""


def cleanup_translation(value: str) -> str:
    cleaned = value.strip()
    for marker in ("<|im_end|>", "<|endoftext|>", "<|eot_id|>"):
        if marker in cleaned:
            cleaned = cleaned.split(marker, 1)[0].strip()
    return cleaned


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not echo the input text here; errors should not leak reader content into logs.
        print(json.dumps({"error": str(error)}), file=sys.stderr, flush=True)
        raise
