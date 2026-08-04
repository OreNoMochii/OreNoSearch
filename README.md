# Metaview Scraper & Outreach Engine

A modular enterprise system for candidate sourcing, talent attrition risk assessment, and automated outreach.

## Architecture

- **/backend**: Node.js Express API and AI agent services (Outreach, Screening).
- **/frontend**: React-based Boolean search and campaign management UI.
- **/machine_learning**: Python-based talent attrition risk scoring (LightGBM & CoxPH models).
- **/machine_learning/retrieval_service**: Python FastAPI microservice for the 4-stage Advanced Retrieval Pipeline.
- **/src**: Legacy scraper and utility scripts (being modularized).

## Getting Started

### Prerequisites
- Node.js (v18+)
- Python 3.9+
- Docker & Docker Compose

### Infrastructure (Docker)
```bash
# Start all containers (PostgreSQL, pgvector, Meilisearch, pgAdmin)
docker-compose up -d
```

| Container | Port | Purpose |
|-----------|------|---------|
| `metaview_db` | 5433 | Golden PostgreSQL database (candidates, outreach history) |
| `metaview_vectordb` | 5434 | pgvector database for semantic embeddings |
| `meilisearch` | 7705 | Lexical search engine |
| `pgadmin4_container` | 5050 | Database admin UI |

### Backend Setup
```bash
cd backend
npm install
npm run api-server
```

### Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

### Root Commands
- `npm run launch-browser`: Launch Google Chrome with remote debugging on port 9222 (macOS). *You must log in to Metaview and have sourcing tab(s) open in this browser before scraping.*
- `npm run scrape`: Run the LinkedIn/Metaview extraction engine.
- `npm run sync-meili`: Synchronize PostgreSQL data to Meilisearch.
- `npm run backfill-roles`: Update candidate role histories.

---

## 🚀 Advanced Retrieval Pipeline

A 4-stage production-grade candidate matching pipeline that replaces the standard single-pass LLM screening with hybrid semantic search + cross-encoder reranking.

```
JD Text
  │
  ▼ Stage 1: LLM Query Expansion
  │  → Extracts skills, synonyms, adjacent roles, Japanese equivalents
  │
  ▼ Stage 2: Hybrid Retrieval (top-N)
  │  → Meilisearch lexical + pgvector dense ANN, fused with RRF
  │
  ▼ Stage 3: Cross-Encoder Reranking (top-K)
  │  → BAAI/bge-reranker-v2-m3 scores each [JD, candidate] pair
  │
  ▼ Stage 4: LLM Audit
  │  → Structured PASS/FAIL verdict with fit score + evidence quotes
  │
  ▼ Shortlist → Attrition Scoring → Email
```

### First-Time Setup

#### 1. Install Python dependencies
```bash
cd machine_learning/retrieval_service
pip3 install -r requirements.txt
```

#### 2. Initialize the vector database
```bash
# Make sure the pgvector container is running
docker-compose up -d pgvector_search

# Run the schema setup
docker exec metaview_vectordb psql -U vector_user -d metaview_vectors \
  -f /dev/stdin < machine_learning/retrieval_service/setup_pgvector.sql
```

#### 3. Ingest embeddings (one-time, ~2-4 hours for 50K profiles)
```bash
cd machine_learning/retrieval_service
python3 ingest_embeddings.py --batch-size 64 --resume
```

This reads candidate text from the golden DB (READ-ONLY) and generates BAAI/bge-m3 embeddings into the vector DB. Safe to interrupt and resume — it skips already-embedded profiles.

#### 4. Start the retrieval service
```bash
cd machine_learning/retrieval_service
python3 -m uvicorn main:app --host 0.0.0.0 --port 8765
```

### Checking Embedding Progress

**Option A — API status endpoint:**
```bash
curl -s http://localhost:8765/status | python3 -m json.tool
```
Returns:
```json
{
    "embedding_model_loaded": true,
    "reranker_model_loaded": true,
    "llm_model": "meta/llama-3.3-70b-instruct",
    "vector_db_rows": 12345
}
```
When `vector_db_rows` reaches ~50,000, ingestion is complete.

**Option B — Direct database query:**
```bash
docker exec metaview_vectordb psql -U vector_user -d metaview_vectors \
  -c "SELECT COUNT(*) FROM candidate_embeddings;"
```

**Option C — Check if the ingestion process is still running:**
```bash
ps aux | grep ingest_embeddings | grep -v grep
```
If no output, the process has finished.

### Using the Pipeline

#### Via the Frontend UI
1. Open the outreach form in the frontend (`http://localhost:5173`)
2. Toggle **🚀 Advanced Pipeline** ON
3. Adjust the sliders:
   - **top-N** (50–500): How many candidates to retrieve from hybrid search
   - **top-K** (10–100): How many to send through cross-encoder + LLM audit
4. Submit the outreach — the backend will route through the pipeline automatically

#### Via the API directly
```bash
curl -X POST http://localhost:8765/search \
  -H "Content-Type: application/json" \
  -d '{
    "jd": "Your full job description text here...",
    "top_n": 200,
    "top_k": 30
  }'
```

Response includes `candidates` (PASS only, with fit scores and evidence) and `meta` (timing, stage counts).

#### Health check
```bash
curl http://localhost:8765/health
# → {"status":"ok","service":"metaview-retrieval"}
```

### Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PIPELINE_LLM_MODEL` | `meta/llama-3.3-70b-instruct` | LLM for query expansion + candidate audit |
| `NVIDIA_API_KEY` | *(required)* | API key for NVIDIA NIM inference |
| `VECTOR_DB_HOST` | `localhost` | pgvector container host |
| `VECTOR_DB_PORT` | `5434` | pgvector container port |
| `MEILI_URL` | `http://localhost:7705` | Meilisearch URL |
| `MEILI_KEY` | *(from .env)* | Meilisearch master key |

### Performance Notes

- **Cold start** (first request): ~60-120s — models load into RAM from HF cache
- **Warm requests**: ~15-30s — models already in memory
- The pipeline works with partial embeddings — quality improves as more are ingested
- `top_n=200, top_k=30` is a good default for balancing speed and recall

---

## Key Features
- **Advanced Retrieval Pipeline**: 4-stage hybrid semantic search with cross-encoder reranking.
- **Behavioral Benchmarking**: Company-level median tenure analysis to identify "restless" talent.
- **AI Screening**: Multi-stage LLM verification of candidates against job descriptions.
- **High-Precision Outreach**: Automated reporting and email sequencing for top-tier matches.

## License
ISC
