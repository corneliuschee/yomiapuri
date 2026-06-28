import json
import os
import sys
import warnings


def main():
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    warnings.filterwarnings("ignore", message=".*cache_dir.*deprecated.*")
    warnings.filterwarnings("ignore", message=".*symlinks by default.*")
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    texts = payload.get("texts") or []
    model_name = payload.get("model") or ""
    cache_dir = payload.get("cacheDir") or None
    batch_size = int(payload.get("batchSize") or 64)
    if not model_name:
        raise RuntimeError("No embedding model configured.")
    if not isinstance(texts, list):
        raise RuntimeError("texts must be a list.")

    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise RuntimeError("Install sentence-transformers to use local multilingual embeddings.") from exc

    device = "cpu"
    try:
        import torch
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
    except Exception:
        device = "cpu"

    model = SentenceTransformer(
        model_name,
        cache_folder=cache_dir,
        local_files_only=True,
        trust_remote_code=True,
        device=device,
    )
    normalized_texts = [str(text or "") for text in texts]
    all_embeddings = []
    for start in range(0, len(normalized_texts), batch_size):
        batch_embeddings = model.encode(
            normalized_texts[start:start + batch_size],
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        all_embeddings.extend(batch_embeddings.tolist())
    print(json.dumps({"embeddings": all_embeddings, "device": device}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
