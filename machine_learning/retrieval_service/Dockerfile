# syntax=docker/dockerfile:1.7
FROM python:3.11-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# ---- dependencies ---------------------------------------------------------
FROM base AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libpq-dev \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --prefix=/install -r requirements.txt

# ---- runtime --------------------------------------------------------------
FROM base AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home appuser

COPY --from=deps /install /usr/local
WORKDIR /app
COPY --chown=appuser:appuser . .

ENV HF_HOME=/home/appuser/.cache/huggingface
USER appuser

# Pre-download the embedding model at build time. Without this the first
# production request pays the 60-120s cold start documented in the README.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')" \
    || echo "Model pre-warm skipped (no network at build time)"

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health').status==200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Single worker: the embedding and reranker models are multi-GB resident and
# each uvicorn worker would load its own copy.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
