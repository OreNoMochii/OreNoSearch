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
from psycopg2.extras import execute_values
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


_UPSERT_SQL = """
    INSERT INTO candidate_embeddings
        (profile_url, name, headline, summary_text, text_blob, embedding)
    VALUES %s
    ON CONFLICT (profile_url) DO UPDATE SET
        name         = EXCLUDED.name,
        headline     = EXCLUDED.headline,
        summary_text = EXCLUDED.summary_text,
        text_blob    = EXCLUDED.text_blob,
        embedding    = EXCLUDED.embedding,
        updated_at   = NOW()
"""


def flush_batch(vec_cur, vec_conn, batch: list) -> int:
    """
    Embed one batch and upsert it in a single statement.

    The blob is built ONCE and reused for both the embedding input and the
    stored column; the previous code called build_text_blob a second time per
    row while assembling the INSERT, doubling that work. The upsert was also one
    execute() per row — now one execute_values round trip per batch.
    """
    blobs = [build_text_blob(dict(r)) for r in batch]

    try:
        embeddings = embed_batch(blobs, batch_size=len(blobs))
    except Exception as e:
        print(f"\n  ⚠️  Embedding error on a batch of {len(batch)}: {e}")
        return 0

    rows = [
        (
            r["profile_url"],
            (r.get("name") or "")[:500],
            (r.get("headline") or "")[:500],
            (r.get("summary") or "")[:2000],
            blob[:3000],
            "[" + ",".join(str(v) for v in emb) + "]",
        )
        for r, blob, emb in zip(batch, blobs, embeddings)
    ]

    execute_values(
        vec_cur,
        _UPSERT_SQL,
        rows,
        template="(%s, %s, %s, %s, %s, %s::vector)",
        page_size=len(rows),
    )
    vec_conn.commit()
    return len(rows)


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

    # ── Stream from golden DB (READ-ONLY) ──────────────────────────────────
    #
    # A NAMED cursor is a server-side cursor: rows arrive `itersize` at a time
    # instead of all at once. The previous code called fetchall() on an
    # unbounded SELECT, materialising every profile — summary, experience,
    # skills and education for millions of rows — as Python dicts before a
    # single embedding was computed. That is gigabytes of resident memory and
    # the reason this script could not complete on the full table.
    print(f"\n[3/4] Streaming candidates from golden DB (table: {args.table})...")
    golden_cur = golden_conn.cursor(
        name="ingest_stream",
        cursor_factory=psycopg2.extras.RealDictCursor,
    )
    golden_cur.itersize = max(args.batch_size, 1000)
    golden_cur.execute(
        f"SELECT profile_url, name, headline, current_company, location, "
        f"summary, experience, skills, education FROM {args.table} "
        f"WHERE profile_url IS NOT NULL AND name IS NOT NULL"
    )

    # ── Batch embed + upsert ────────────────────────────────────────────────
    print(f"\n[4/4] Embedding in batches of {args.batch_size}...")
    vec_cur = vec_conn.cursor()

    total_inserted = 0
    scanned = 0
    batch: list = []
    progress = tqdm(desc="Embedding", unit="profile")

    try:
        for row in golden_cur:
            scanned += 1
            if row["profile_url"] in already_done:
                continue

            batch.append(row)
            if len(batch) < args.batch_size:
                continue

            total_inserted += flush_batch(vec_cur, vec_conn, batch)
            progress.update(len(batch))
            batch = []

        if batch:
            total_inserted += flush_batch(vec_cur, vec_conn, batch)
            progress.update(len(batch))
    finally:
        progress.close()
        golden_cur.close()
        golden_conn.close()
        vec_cur.close()
        vec_conn.close()

    print(f"\n✅ Done! Scanned {scanned} profiles, embedded and upserted {total_inserted}.")
    print(f"   Vector DB is ready for semantic search at port {VECTOR_DB['port']}.")


if __name__ == "__main__":
    main()
