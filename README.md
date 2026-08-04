# Metaview Scraper & Outreach Engine

A modular enterprise system for candidate sourcing, talent attrition risk assessment, and automated outreach. This repository has undergone a comprehensive 5-phase production overhaul to enforce **SOLID architecture**, **strict security**, **UI performance**, and **CI/CD production readiness**.

## System Architecture

The repository is structured as a monorepo featuring domain-driven, loosely coupled services:

- **`/packages/api`**: Node.js Express Backend. 
  - *Architecture:* Hexagonal (Ports & Adapters).
  - *Core Services:* Orchestrates campaigns using injected dependencies (`LLMClient`, `GoogleMailService`, `GoogleSheetsService`) rather than global singletons.
- **`/packages/web`**: React Frontend.
  - *Architecture:* Vite 8 / Rolldown based SPA. 
  - *Core Features:* Memoized `<CandidateCard>` mapping, native accessible `<dialog>` Modals, and responsive CSS Grid layout without inline styles.
- **`/services/retrieval`**: Python FastAPI microservice.
  - *Core Features:* 4-Stage Advanced Retrieval Pipeline (Lexical + Dense Vector Search + Cross-Encoder Reranking + LLM verification).
- **`/machine_learning`**: Python-based talent attrition risk scoring models (LightGBM & CoxPH).

---

## 🛠️ Local Development

### Prerequisites
- Node.js (v22+)
- Python 3.11+
- Docker & Docker Compose

### 1. Infrastructure (Database & Search Engines)
Start the foundational databases (PostgreSQL, pgvector, and Meilisearch) using the local override:
```bash
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d postgres pgvector_search meilisearch pgadmin
```

| Container | Port | Purpose |
|-----------|------|---------|
| `postgres` | 5433 | Golden PostgreSQL database (candidates, outreach history) |
| `pgvector_search` | 5434 | pgvector database for semantic embeddings |
| `meilisearch` | 7705 | Lexical search engine |
| `pgadmin` | 5050 | Database admin UI (Local only) |

### 2. Backend API
```bash
cd packages/api
npm ci
npm run dev  # Uses tsx for rapid hot-reloading
```

### 3. Frontend Web
```bash
cd packages/web
npm ci
npm run dev
```

---

## 🚀 Advanced Retrieval Pipeline

A production-grade candidate matching pipeline providing high-recall semantic search and precision reranking.

```
JD Text
  │
  ▼ Stage 1: LLM Query Expansion (Extracts skills, synonyms, adjacent roles)
  │
  ▼ Stage 2: Hybrid Retrieval (top-N: Meilisearch lexical + pgvector dense ANN, fused with RRF)
  │
  ▼ Stage 3: Cross-Encoder Reranking (top-K: BAAI/bge-reranker-v2-m3)
  │
  ▼ Stage 4: LLM Audit (Structured PASS/FAIL verdict + evidence quotes)
```

### Setup & Ingestion

1. **Install Dependencies:**
```bash
cd services/retrieval
pip install -r requirements.txt
```

2. **Initialize Vector Schema:**
```bash
docker exec metaview_vectordb psql -U vector_user -d metaview_vectors \
  -f /dev/stdin < machine_learning/retrieval_service/setup_pgvector.sql
```

3. **Ingest Embeddings (One-Time):**
```bash
python3 ingest_embeddings.py --batch-size 64 --resume
```

4. **Start Service:**
```bash
python3 -m uvicorn main:app --host 0.0.0.0 --port 8765
```

---

## 🚢 Production Deployment (CI/CD)

The application is fully containerized for production with hardened security profiles and zero-downtime health checks.

### Production Docker Compose
The production stack uses multi-stage builds and drops all privileged capabilities.
```bash
docker-compose -f docker-compose.prod.yml up -d
```
*Note: In production, PostgreSQL does not bind to the host network (only accessible via internal docker networks), and Meilisearch requires the `MEILI_MASTER_KEY_FILE` secret.*

### Continuous Integration (GitHub Actions)
The `.github/workflows/ci.yml` pipeline automatically triggers on `push` and `pull_request` to `main`:
1. **Secret Scanning:** Enforces zero credentials in code using `gitleaks`.
2. **Node Gates:** Runs ESLint, Prettier, TypeScript checks (`tsc --noEmit`), and Vitest (with strict coverage thresholds).
3. **Python Gates:** Enforces static typing via `mypy`, linting via `ruff`, and testing via `pytest`.
4. **Container Builds:** Builds multi-stage Docker images (`deps`, `build`, `runtime`) and runs `trivy` vulnerability scanning.

### Quality Gates (Pre-Commit)
To ensure code quality before pushing, install the pre-commit hooks:
```bash
pip install pre-commit
pre-commit install
```
This enables automatic formatting (`ruff-format`), notebook output stripping (`nbstripout`), and large-file blocking locally.

---

## License
ISC
