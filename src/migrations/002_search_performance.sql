-- 002_search_performance.sql
--
-- Query-plan work for candidates_upgraded (B14).
--
-- SAFETY: every statement is additive and idempotent. Nothing is dropped,
-- truncated or rewritten, and no row data is modified. All indexes use
-- CONCURRENTLY so writers are never blocked.
--
-- CONCURRENTLY cannot run inside a transaction block, so execute this file
-- with autocommit — e.g.
--     psql "$DATABASE_URL" -f src/migrations/002_search_performance.sql
-- and NOT wrapped in BEGIN/COMMIT.
--
-- Before this migration, a search filtering on experience evaluated
-- calculate_total_experience_months(experience) for every row, and a location
-- filter used a leading-wildcard ILIKE that no btree index can serve. Both
-- forced sequential scans over the full table on every request.

-- ── 1. Persist the experience calculation ───────────────────────────────────
-- calculate_total_experience_months is already declared IMMUTABLE, which makes
-- it legal in a generated column. This converts a per-row function call in
-- WHERE into an indexed integer comparison.
--
-- NOTE: adding a STORED generated column rewrites the table. On a large
-- candidates_upgraded this needs a maintenance window and free disk roughly
-- equal to the table size. Run it when the app is idle.
ALTER TABLE candidates_upgraded
    ADD COLUMN IF NOT EXISTS total_experience_months INTEGER
    GENERATED ALWAYS AS (calculate_total_experience_months(experience)) STORED;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_total_exp
    ON candidates_upgraded (total_experience_months);

-- ── 2. Trigram indexes for the ILIKE '%…%' predicates ───────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_location_trgm
    ON candidates_upgraded USING GIN (location gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_company_trgm
    ON candidates_upgraded USING GIN (current_company gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_latest_role_trgm
    ON candidates_upgraded USING GIN (latest_role gin_trgm_ops);

-- ── 3. Full-text expression index ───────────────────────────────────────────
-- This index previously existed only in an untracked ad-hoc script
-- (migrate_expression_index.js), so a rebuilt environment silently lost it and
-- every keyword search degraded to a sequential scan. The expression must match
-- the one in postgres_repo.runIlikeSearch character for character or the
-- planner will not use it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_expr_vector
    ON candidates_upgraded USING GIN (
        to_tsvector('english',
            regexp_replace(
                coalesce(name, '')            || ' ' ||
                coalesce(headline, '')        || ' ' ||
                coalesce(latest_role, '')     || ' ' ||
                coalesce(current_company, '') || ' ' ||
                coalesce(experience, '')      || ' ' ||
                coalesce(summary, ''),
                'c\+\+', 'cpp_lang', 'ig'
            )
        )
    );

-- ── 4. Refresh planner statistics ───────────────────────────────────────────
ANALYZE candidates_upgraded;
