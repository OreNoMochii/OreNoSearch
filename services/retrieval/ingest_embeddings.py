"""
ingest_embeddings.py — One-time embedding ingestion from golden DB to vector DB.

Reads candidate text from the golden metaview_db (READ-ONLY, port 5433).
Generates BAAI/bge-m3 embeddings and upserts into metaview_vectordb (port 5434).

Features:
  - Resume support: skips profile_urls already in candidate_embeddings
  - Batch processing (batch_size=64 by default)
  - Progress bar via tqdm
  - Never writes to the golden DB

Usage:
  python3 ingest_embeddings.py [--batch-size 64] [--resume]

First run: ~2-4 hours for 50,000 profiles on CPU.
Subsequent runs (resume): only processes new/updated profiles.
"""
import argparse
import sys
import os
from pathlib import Path

# Add retrieval_service to path
sys.path.insert(0, str(Path(__file__).parent))

import psycopg2
import psycopg2.extras
from tqdm import tqdm
from config import GOLDEN_DB, VECTOR_DB
from embedder import embed_batch


def build_text_blob(row: dict) -> str:
    """Build a unified text blob for embedding from candidate fields."""
    parts = [
        (row.get("name") or ""),
        (row.get("headline") or row.get("current_role") or ""),
        (row.get("current_company") or row.get("company") or ""),
        (row.get("location") or ""),
        (row.get("summary") or "")[:800],
        (row.get("experience") or "")[:1000],
        (row.get("skills") or "")[:300],
        (row.get("education") or "")[:200],
    ]
    return " | ".join(p for p in parts if p and str(p).strip() != "N/A")


def get_already_ingested(vec_conn) -> set:
    """Return set of profile_urls already in the vector DB."""
    cur = vec_conn.cursor()
    cur.execute("SELECT profile_url FROM candidate_embeddings")
    urls = {row[0] for row in cur.fetchall()}
    cur.close()
    return urls


def main():
    parser = argparse.ArgumentParser(description="Ingest candidate embeddings into pgvector DB.")
    parser.add_argument("--batch-size", type=int, default=64, help="Embedding batch size (default: 64)")
    parser.add_argument("--resume", action="store_true", default=True,
                        help="Skip already-ingested profiles (default: True)")
    parser.add_argument("--no-resume", dest="resume", action="store_false",
                        help="Re-embed everything from scratch")
    parser.add_argument("--table", type=str, default="candidates",
                        help="Source table in golden DB (default: candidates)")
    args = parser.parse_args()

    print("=" * 65)
    print("  Metaview — Candidate Embedding Ingestion")
    print(f"  Source:  metaview_db (port {GOLDEN_DB['port']}) [READ-ONLY]")
    print(f"  Target:  metaview_vectordb (port {VECTOR_DB['port']})")
    print(f"  Model:   BAAI/bge-m3")
    print(f"  Resume:  {args.resume}")
    print("=" * 65)

    # ── Connect to both DBs ─────────────────────────────────────────────────
    print("\n[1/4] Connecting to databases...")
    try:
        golden_conn = psycopg2.connect(**GOLDEN_DB)
        golden_conn.set_session(readonly=True)  # enforce read-only on golden DB
        print("  ✓ Golden DB connected (read-only enforced)")
    except Exception as e:
        print(f"  ✗ Cannot connect to golden DB: {e}")
        sys.exit(1)

    try:
        vec_conn = psycopg2.connect(**VECTOR_DB)
        print("  ✓ Vector DB connected")
    except Exception as e:
        print(f"  ✗ Cannot connect to vector DB: {e}")
        print("    Make sure pgvector_search Docker container is running:")
        print("    docker-compose up -d pgvector_search")
        print("    Then run setup SQL: psql -h localhost -p 5434 -U vector_user -d metaview_vectors -f setup_pgvector.sql")
        sys.exit(1)

    # ── Load already-ingested URLs ──────────────────────────────────────────
    already_done = set()
    if args.resume:
        print("\n[2/4] Checking already-ingested profiles...")
        already_done = get_already_ingested(vec_conn)
        print(f"  → {len(already_done)} profiles already in vector DB (will skip)")

    # ── Fetch from golden DB (READ-ONLY) ───────────────────────────────────
    print(f"\n[3/4] Loading candidates from golden DB (table: {args.table})...")
    golden_cur = golden_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    golden_cur.execute(
        f"SELECT profile_url, name, headline, current_company, location, "
        f"summary, experience, skills, education FROM {args.table} "
        f"WHERE profile_url IS NOT NULL AND name IS NOT NULL"
    )
    all_rows = golden_cur.fetchall()
    golden_cur.close()
    golden_conn.close()
    print(f"  → {len(all_rows)} total profiles fetched")

    # Filter to only unprocessed
    rows_to_process = [r for r in all_rows if r["profile_url"] not in already_done]
    print(f"  → {len(rows_to_process)} profiles to embed")

    if not rows_to_process:
        print("\n✓ Nothing to do — all profiles are already embedded!")
        vec_conn.close()
        return

    # ── Batch embed + upsert ────────────────────────────────────────────────
    print(f"\n[4/4] Embedding in batches of {args.batch_size}...")
    vec_cur = vec_conn.cursor()

    total_inserted = 0
    for i in tqdm(range(0, len(rows_to_process), args.batch_size),
                  desc="Embedding batches", unit="batch"):
        batch = rows_to_process[i : i + args.batch_size]
        texts = [build_text_blob(dict(r)) for r in batch]

        try:
            embeddings = embed_batch(texts, batch_size=len(texts))
        except Exception as e:
            print(f"\n  ⚠️  Embedding error on batch {i//args.batch_size}: {e}")
            continue

        for row, emb in zip(batch, embeddings):
            url   = row["profile_url"]
            name  = (row.get("name") or "")[:500]
            head  = (row.get("headline", "") or "")[:500]
            summ  = (row.get("summary", "") or "")[:2000]
            blob  = build_text_blob(dict(row))[:3000]
            vec_str = "[" + ",".join(str(v) for v in emb) + "]"

            vec_cur.execute(
                """
                INSERT INTO candidate_embeddings
                    (profile_url, name, headline, summary_text, text_blob, embedding)
                VALUES (%s, %s, %s, %s, %s, %s::vector)
                ON CONFLICT (profile_url) DO UPDATE SET
                    name         = EXCLUDED.name,
                    headline     = EXCLUDED.headline,
                    summary_text = EXCLUDED.summary_text,
                    text_blob    = EXCLUDED.text_blob,
                    embedding    = EXCLUDED.embedding,
                    updated_at   = NOW()
                """,
                (url, name, head, summ, blob, vec_str),
            )
            total_inserted += 1

        vec_conn.commit()

    vec_cur.close()
    vec_conn.close()

    print(f"\n✅ Done! Embedded and upserted {total_inserted} profiles.")
    print(f"   Vector DB is ready for semantic search at port {VECTOR_DB['port']}.")


if __name__ == "__main__":
    main()
