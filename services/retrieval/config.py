"""
config.py — Central configuration for the retrieval microservice.
Loads from the project root .env file.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Walk up from retrieval_service/ to project root to find .env
_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(dotenv_path=_ROOT / ".env", override=False)

# ── Golden DB (READ-ONLY source — never written to) ────────────────────────
GOLDEN_DB = dict(
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", "5433")),
    database=os.getenv("DB_NAME", "metaview_scraper"),
    user=os.getenv("DB_USER", "scraper_user"),
    password=os.getenv("DB_PASSWORD", "scraper_password"),
)

# ── Vector DB (separate pgvector container, port 5434) ─────────────────────
VECTOR_DB = dict(
    host=os.getenv("VECTOR_DB_HOST", "localhost"),
    port=int(os.getenv("VECTOR_DB_PORT", "5434")),
    database=os.getenv("VECTOR_DB_NAME", "metaview_vectors"),
    user=os.getenv("VECTOR_DB_USER", "vector_user"),
    password=os.getenv("VECTOR_DB_PASSWORD", "vector_password"),
)

# ── Meilisearch ─────────────────────────────────────────────────────────────
MEILI_URL = os.getenv("MEILI_URL", "http://localhost:7705")
MEILI_KEY = os.getenv("MEILI_KEY", "")
MEILI_INDEX = os.getenv("MEILI_INDEX", "candidates")

# ── LLM ─────────────────────────────────────────────────────────────────────
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")

# LLM for Stage 1 (JD expansion) + Stage 4 (candidate audit)
# llama-3.3-70b is the reliable fast default; can override with PIPELINE_LLM_MODEL env var
LLM_API_BASE = "https://integrate.api.nvidia.com/v1"
LLM_API_KEY = NVIDIA_API_KEY or OPENAI_API_KEY
LLM_MODEL = os.getenv("PIPELINE_LLM_MODEL", "meta/llama-3.3-70b-instruct")

# ── Embedding & Reranker models (local HuggingFace, cached) ─────────────────
EMBEDDING_MODEL = "BAAI/bge-m3"           # 1024-dim, bilingual JA/EN
RERANKER_MODEL  = "BAAI/bge-reranker-v2-m3"

# ── Service defaults ─────────────────────────────────────────────────────────
DEFAULT_TOP_N = 200   # candidates from hybrid retrieval
DEFAULT_TOP_K = 30    # candidates after reranking (fed to LLM)
LLM_CONCURRENCY = 5   # parallel LLM audit calls

# ── RRF constant ────────────────────────────────────────────────────────────
RRF_K = 60
