-- 005_company_intel_index.sql
--
-- Functional index for the company-intel lookup.
--
-- getCompanyIntelBatch (packages/api/src/repositories/postgres_repo.ts) filters
-- with:
--
--     WHERE lower(name) = ANY($1)
--
-- A btree on `name` cannot serve that predicate — the comparison is against
-- lower(name), not name — so the lookup sequentially scans companies_analyzed
-- on every campaign that has the Company Intel toggle on, which is the default.
--
-- The expression here must match the query's expression exactly or the planner
-- will not use it. lower() is IMMUTABLE, which is what makes it index-eligible.
--
-- SAFETY: additive and idempotent. Nothing is dropped, rewritten or modified;
-- no row data changes.
--
-- EXECUTION
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
--   file must be executed in autocommit — do NOT pass --single-transaction / -1.
--
--     docker exec -i metaview_db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
--       < packages/scraper/migrations/005_company_intel_index.sql
--
--   If a CONCURRENTLY build is interrupted it leaves an INVALID index behind.
--   Find them with:
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   and DROP INDEX CONCURRENTLY those before re-running.
--
-- VERIFY afterwards:
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT name, company_type FROM companies_analyzed
--   WHERE lower(name) = ANY(ARRAY['rakuten','mercari']);
--   -- expect an Index Scan on idx_companies_analyzed_lower_name,
--   -- not a Seq Scan on companies_analyzed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_analyzed_lower_name
    ON companies_analyzed (lower(name));

-- Read-only: collects statistics, modifies no row data.
ANALYZE companies_analyzed;
