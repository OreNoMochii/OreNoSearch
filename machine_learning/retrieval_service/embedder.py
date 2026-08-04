"""
embedder.py — Singleton wrapper around BAAI/bge-m3.
Loaded ONCE at service startup and held in memory.
Supports both single-text and batch embedding.
"""
import threading
import numpy as np
from typing import Union

_lock = threading.Lock()
_model = None


def _get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer
                print(f"[Embedder] Loading BAAI/bge-m3 … (first run downloads ~570 MB)")
                _model = SentenceTransformer("BAAI/bge-m3")
                print(f"[Embedder] Model loaded ✓")
    return _model


def embed_text(text: str) -> list[float]:
    """Embed a single string → 1024-dim float list."""
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True)
    return vec.tolist()


def embed_batch(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    """Embed a list of strings in batches → list of 1024-dim float lists."""
    model = _get_model()
    vecs = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    return vecs.tolist()
