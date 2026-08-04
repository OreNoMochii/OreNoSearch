"""
stage2_hybrid_retrieval.py — Hybrid Meilisearch + pgvector retrieval with RRF fusion.

Takes the expanded JD ontology (from Stage 1) and returns top-N candidates
by fusing:
  - Lexical results from Meilisearch (existing indices: 'candidates' + 'profiles')
  - Dense vector results from pgvector (HNSW cosine ANN search)

Uses Reciprocal Rank Fusion (RRF) to merge the two ranked lists without
any score normalization heuristics.

Stage 2 now enriches pgvector-sourced candidates by fetching their full
profile data from the golden DB, so the cross-encoder in Stage 3 has
complete information for every candidate regardless of source.
"""
import asyncio
from typing import Optional
import psycopg2
import psycopg2.extras
from meilisearch import Client as MeiliClient
from embedder import embed_text
from db import vector_cursor, golden_cursor
from config import (
    MEILI_URL, MEILI_KEY, MEILI_INDEX, RRF_K
)


# ── Meilisearch client ───────────────────────────────────────────────────────
_meili: Optional[MeiliClient] = None

def _get_meili() -> MeiliClient:
    global _meili
    if _meili is None:
        _meili = MeiliClient(MEILI_URL, api_key=MEILI_KEY or None)
    return _meili


# Connections come from the pools in db.py — see B9 in that module's docstring.

# ── Meilisearch retrieval ───────────────────────────────────────────────────
def _fetch_meili(query_terms: list[str], limit: int) -> list[dict]:
    """
    Query the 'candidates' Meilisearch index using the expanded ontology terms,
    returning ranked hits with candidate fields.
    """
    client = _get_meili()
    # Simple space-delimited query — Meilisearch handles relevance scoring
    query_str = " ".join(query_terms[:20])

    seen = set()
    hits = []

    for index_name in [MEILI_INDEX]:
        try:
            index = client.index(index_name)
            res = index.search(query_str, {"limit": limit * 2})
            for h in res.get("hits", []):
                url = h.get("profile_url") or h.get("id", "")
                if url and url not in seen:
                    seen.add(url)
                    hits.append({
                        "profile_url": url,
                        "name":    h.get("name") or h.get("full_name") or "Unknown",
                        "headline": h.get("headline") or h.get("current_role") or "",
                        "location": h.get("location") or "",
                        "current_company": h.get("current_company") or h.get("company") or "",
                        "summary":  h.get("summary") or "",
                        "experience": h.get("experience") or "",
                        "education": h.get("education") or "",
                        "skills":   h.get("skills") or "",
                        "email":    h.get("email") or "",
                        "source":   index_name,
                    })
        except Exception as exc:
            print(f"  [Meili:{index_name}] Warning: {exc}")

    return hits


# ── pgvector retrieval ──────────────────────────────────────────────────────
def _fetch_vector(jd_text: str, limit: int) -> list[dict]:
    """
    Embed the JD and perform ANN cosine search in the vector DB.
    Returns candidates ordered by similarity (closest first).
    Falls back gracefully if the vector DB is not yet populated.
    """
    try:
        embedding = embed_text(jd_text)
        vec_str = "[" + ",".join(str(v) for v in embedding) + "]"

        with vector_cursor() as cur:
            cur.execute(
                """
                SELECT profile_url, name, headline, summary_text, text_blob,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM   candidate_embeddings
                ORDER  BY embedding <=> %s::vector
                LIMIT  %s
                """,
                (vec_str, vec_str, limit * 2),
            )
            rows = cur.fetchall()

        return [
            {
                "profile_url":      r["profile_url"],
                "name":             r["name"] or "Unknown",
                "headline":         r["headline"] or "",
                "summary":          r["summary_text"] or "",
                "experience":       "",
                "education":        "",
                "skills":           "",
                "current_company":  "",
                "location":         "",
                "email":            "",
                "source":           "pgvector",
            }
            for r in rows
        ]
    except Exception as exc:
        print(f"  [pgvector] Warning: {exc} — vector leg skipped for this query.")
        return []


# ── Enrich pgvector-only candidates from Golden DB ──────────────────────────
def _enrich_from_golden(candidates: list[dict]) -> list[dict]:
    """
    For candidates that came from pgvector (missing experience/skills),
    fetch full profile data from the golden DB to give Stage 3 complete
    information for accurate cross-encoder scoring.
    """
    urls_to_enrich = [
        c["profile_url"] for c in candidates
        if c.get("source") == "pgvector" and not c.get("experience")
    ]

    if not urls_to_enrich:
        return candidates

    golden_data: dict[str, dict] = {}
    try:
        with golden_cursor() as cur:
            # Use ANY to batch-fetch all at once
            cur.execute(
                """SELECT profile_url, name, headline, current_company, location,
                          summary, experience, skills, education, email
                   FROM candidates
                   WHERE profile_url = ANY(%s)""",
                (urls_to_enrich,)
            )
            for row in cur.fetchall():
                golden_data[row["profile_url"]] = dict(row)
        print(f"  [Stage2] Enriched {len(golden_data)}/{len(urls_to_enrich)} pgvector candidates from golden DB")
    except Exception as exc:
        print(f"  [Stage2] Golden DB enrichment failed: {exc}")
        return candidates

    enriched = []
    for c in candidates:
        url = c["profile_url"]
        if url in golden_data:
            g = golden_data[url]
            enriched.append({
                **c,
                "name":             g.get("name") or c.get("name", "Unknown"),
                "headline":         g.get("headline") or c.get("headline", ""),
                "current_company":  g.get("current_company") or c.get("current_company", ""),
                "location":         g.get("location") or c.get("location", ""),
                "summary":          g.get("summary") or c.get("summary", ""),
                "experience":       g.get("experience") or c.get("experience", ""),
                "skills":           g.get("skills") or c.get("skills", ""),
                "education":        g.get("education") or c.get("education", ""),
                "email":            g.get("email") or c.get("email", ""),
            })
        else:
            enriched.append(c)
    return enriched


# ── Reciprocal Rank Fusion ──────────────────────────────────────────────────
def _rrf_fuse(
    meili_hits: list[dict],
    vector_hits: list[dict],
    top_n: int,
) -> list[dict]:
    """
    Merge two ranked lists with RRF: score(d) = Σ 1 / (k + rank_i(d)).
    k=60 is the standard constant that reduces the influence of outlier ranks.
    """
    scores: dict[str, float] = {}
    candidates: dict[str, dict] = {}

    for rank, cand in enumerate(meili_hits, start=1):
        url = cand["profile_url"]
        scores[url] = scores.get(url, 0.0) + 1.0 / (RRF_K + rank)
        candidates[url] = cand  # keep richer Meilisearch data

    for rank, cand in enumerate(vector_hits, start=1):
        url = cand["profile_url"]
        scores[url] = scores.get(url, 0.0) + 1.0 / (RRF_K + rank)
        if url not in candidates:
            candidates[url] = cand  # add if not already seen

    sorted_urls = sorted(scores, key=lambda u: scores[u], reverse=True)[:top_n]
    return [
        {**candidates[url], "rrf_score": round(scores[url], 6)}
        for url in sorted_urls
    ]


# ── Public API ──────────────────────────────────────────────────────────────
async def hybrid_retrieve(
    expansion: dict,
    jd_text: str,
    top_n: int,
) -> list[dict]:
    """
    Stage 2 entry point.
    expansion: dict from Stage 1 (has search_keywords, role_synonyms, etc.)
    jd_text:   original JD text for embedding
    top_n:     number of candidates to return after RRF fusion
    """
    query_terms = list(dict.fromkeys(
        expansion.get("search_keywords", []) +
        expansion.get("required_skills", []) +
        expansion.get("role_synonyms", []) +
        expansion.get("adjacent_roles", []) +
        expansion.get("japanese_equivalents", [])
    ))

    # Run Meilisearch and pgvector in a thread pool (both are sync)
    loop = asyncio.get_running_loop()
    meili_task   = loop.run_in_executor(None, _fetch_meili,  query_terms, top_n)
    vector_task  = loop.run_in_executor(None, _fetch_vector, jd_text,     top_n)

    meili_hits, vector_hits = await asyncio.gather(meili_task, vector_task)

    print(
        f"  [Stage2] Meilisearch: {len(meili_hits)} | "
        f"pgvector: {len(vector_hits)} | "
        f"fusing → top-{top_n}"
    )

    fused = _rrf_fuse(meili_hits, vector_hits, top_n)

    # Enrich pgvector candidates with full profile data from golden DB
    fused = _enrich_from_golden(fused)

    return fused
