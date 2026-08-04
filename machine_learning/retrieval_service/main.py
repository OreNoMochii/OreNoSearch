"""
main.py — FastAPI retrieval microservice (port 8765).

Exposes:
  POST /search   — Full 4-stage pipeline
  GET  /health   — Health check
  GET  /status   — Model load status
"""
import time
from contextlib import asynccontextmanager
from typing import Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import DEFAULT_TOP_N, DEFAULT_TOP_K
from stage1_query_expansion import expand_jd
from stage2_hybrid_retrieval import hybrid_retrieve
from stage3_reranker import rerank
from stage4_llm_audit import llm_audit


# ── Lazy model loading — no eager warm-up on startup ───────────────────────
# Models (BAAI/bge-m3 + BAAI/bge-reranker-v2-m3) are downloaded from
# HuggingFace on first request and cached in ~/.cache/huggingface.
# Run `npm run ingest-embeddings` first to trigger the download at a
# controlled time before serving live traffic.
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[Startup] Retrieval service ready (models load lazily on first request).")
    yield
    # Shutdown: nothing to clean up


app = FastAPI(
    title="Metaview Retrieval Service",
    description="4-stage talent retrieval pipeline: Query Expansion → Hybrid Retrieval → Reranking → LLM Audit",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://localhost:8080"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ────────────────────────────────────────────────
class SearchRequest(BaseModel):
    jd: str = Field(..., description="Full job description text", min_length=20)
    top_n: int = Field(DEFAULT_TOP_N, ge=50, le=1000, description="Candidates from hybrid search (Stage 2)")
    top_k: int = Field(DEFAULT_TOP_K, ge=10, le=500, description="Candidates after reranking, sent to LLM (Stage 3)")
    model: Optional[str] = Field(None, description="Optional target LLM model to override default")
    company_name: Optional[str] = Field(None, description="Hiring company name to filter out existing employees")
    min_years: Optional[int] = Field(None, description="Optional minimum years of experience override")
    max_years: Optional[int] = Field(None, description="Optional maximum years of experience override")


class CandidateResult(BaseModel):
    profile_url: str
    name: str
    headline: Optional[str] = ""
    current_company: Optional[str] = ""
    location: Optional[str] = ""
    email: Optional[str] = ""
    rrf_score: Optional[float] = None
    reranker_score: Optional[float] = None
    audit_fit_score: Optional[int] = None
    audit_seniority: Optional[str] = None
    audit_evidence: Optional[List[str]] = None
    source: Optional[str] = None


class SearchResponse(BaseModel):
    candidates: list[CandidateResult]
    meta: dict


# ── Routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "metaview-retrieval"}


@app.get("/status")
async def status():
    import embedder, stage3_reranker
    from config import LLM_MODEL
    # Check vector DB count
    vec_count = 0
    try:
        import psycopg2
        from config import VECTOR_DB
        conn = psycopg2.connect(**VECTOR_DB)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM candidate_embeddings")
        vec_count = cur.fetchone()[0]
        cur.close()
        conn.close()
    except Exception:
        pass
    return {
        "embedding_model_loaded": embedder._model is not None,
        "reranker_model_loaded":  stage3_reranker._reranker is not None,
        "llm_model": LLM_MODEL,
        "vector_db_rows": vec_count,
    }


@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    t0 = time.perf_counter()

    print(f"\n{'='*60}")
    print(f"[Pipeline] New search request | top_n={req.top_n} | top_k={req.top_k} | model={req.model or 'DEFAULT'}")
    print(f"[Pipeline] JD preview: {req.jd[:120]}...")

    # ── Stage 1: Query Expansion ─────────────────────────────────────────────
    t1 = time.perf_counter()
    print(f"[Stage 1] Expanding JD ontology...")
    try:
        expansion = await expand_jd(req.jd, model=req.model)
        print(f"  → {len(expansion.get('search_keywords', []))} keywords extracted")
        print(f"  → skills: {expansion.get('required_skills', [])[:5]}")
    except Exception as exc:
        print(f"  ⚠️  Stage 1 failed: {exc} — using fallback keywords")
        from stage1_query_expansion import _fallback_expansion
        expansion = _fallback_expansion(req.jd)
    print(f"  Duration: {time.perf_counter()-t1:.1f}s")

    # Override expansion min/max years of experience if supplied by the user
    if req.min_years is not None:
        expansion["min_years_experience"] = req.min_years
    if req.max_years is not None:
        expansion["max_years_experience"] = req.max_years

    # ── Stage 2: Hybrid Retrieval ─────────────────────────────────────────────
    t2 = time.perf_counter()
    print(f"[Stage 2] Hybrid retrieval (top-{req.top_n})...")
    candidates = await hybrid_retrieve(expansion, req.jd, req.top_n)
    print(f"  → Retrieved {len(candidates)} candidates after RRF fusion")
    print(f"  Duration: {time.perf_counter()-t2:.1f}s")

    if not candidates:
        return SearchResponse(candidates=[], meta={"error": "No candidates found in retrieval stage"})

    # ── Stage 3: Reranking ────────────────────────────────────────────────────
    t3 = time.perf_counter()
    print(f"[Stage 3] Cross-encoder reranking → top-{req.top_k}...")
    shortlist = await rerank(req.jd, candidates, req.top_k, expansion=expansion, company_name=req.company_name)
    print(f"  → Shortlisted {len(shortlist)} candidates")
    print(f"  Duration: {time.perf_counter()-t3:.1f}s")

    # ── Stage 4: LLM Audit ────────────────────────────────────────────────────
    t4 = time.perf_counter()
    print(f"[Stage 4] LLM audit of {len(shortlist)} candidates using model={req.model or 'DEFAULT'}...")
    
    # Inject custom experience constraints to Stage 4 LLM Audit if specified
    jd_for_audit = req.jd
    if req.min_years is not None or req.max_years is not None:
        limits = []
        if req.min_years is not None:
            limits.append(f"Required minimum experience: {req.min_years} years.")
        if req.max_years is not None:
            limits.append(f"Required maximum experience: {req.max_years} years.")
        jd_for_audit = f"[CUSTOM EXPERIENCE CONSTRAINTS]\n" + "\n".join(limits) + "\n\n" + req.jd

    audited = await llm_audit(jd_for_audit, shortlist, model=req.model)
    print(f"  → {len(audited)} candidates passed")
    print(f"  Duration: {time.perf_counter()-t4:.1f}s")

    total_time = time.perf_counter() - t0
    print(f"\n[Pipeline] ✅ Complete in {total_time:.1f}s | {len(audited)} candidates passed")
    print(f"{'='*60}\n")

    return SearchResponse(
        candidates=[CandidateResult(**{
            k: c.get(k) for k in CandidateResult.model_fields
        }) for c in audited],
        meta={
            "total_retrieved": len(candidates),
            "after_rerank":    len(shortlist),
            "passed_audit":    len(audited),
            "top_n":           req.top_n,
            "top_k":           req.top_k,
            "model":           req.model or LLM_MODEL,
            "duration_seconds": round(total_time, 1),
            "expansion_keywords": expansion.get("search_keywords", [])[:10],
        }
    )
