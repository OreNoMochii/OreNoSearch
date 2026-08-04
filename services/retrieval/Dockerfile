# syntax=docker/dockerfile:1.7
FROM python:3.11-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

FROM base AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --prefix=/install -r requirements.txt

FROM base AS runtime
RUN useradd --system --uid 10001 --create-home appuser
COPY --from=deps /install /usr/local
WORKDIR /app
COPY --chown=appuser:appuser . .

# Pre-warm the HF cache at build time so the documented 60-120s cold start
# (README "Performance Notes") does not hit the first production request.
ENV HF_HOME=/home/appuser/.cache/huggingface
USER appuser
RUN python -c "from sentence_transformers import SentenceTransformer as S; S('BAAI/bge-m3')"

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health').status==200 else 1)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
