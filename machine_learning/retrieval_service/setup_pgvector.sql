-- Setup script for the pgvector search database (metaview_vectordb, port 5434)
-- Run this ONCE after starting the pgvector_search Docker container:
--   psql -h localhost -p 5434 -U vector_user -d metaview_vectors -f setup_pgvector.sql

-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Candidate embeddings table (populated by ingest_embeddings.py)
CREATE TABLE IF NOT EXISTS candidate_embeddings (
    profile_url  TEXT PRIMARY KEY,
    name         TEXT,
    headline     TEXT,
    summary_text TEXT,
    text_blob    TEXT,       -- concatenated searchable text for reranking
    embedding    vector(1024),
    updated_at   TIMESTAMP DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbor search (cosine similarity)
-- m=16, ef_construction=64 is a good balance of speed vs. recall for 50K+ vectors
CREATE INDEX IF NOT EXISTS hnsw_embedding_cosine_idx
    ON candidate_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Standard btree index for profile_url lookups
CREATE INDEX IF NOT EXISTS idx_ce_profile_url ON candidate_embeddings (profile_url);

COMMENT ON TABLE candidate_embeddings IS
    'Read-only copy of candidate text with BAAI/bge-m3 embeddings. '
    'Source data is a one-time copy from the golden metaview_db. '
    'This table is NEVER written to by the main backend pipeline.';
