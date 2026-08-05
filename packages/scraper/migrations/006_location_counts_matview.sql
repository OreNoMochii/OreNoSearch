-- 006_location_counts_matview.sql
--
-- Makes GET /api/locations fast on a cold cache.
--
-- THE PROBLEM
--
-- getAvailableLocations ran this shape against candidates_upgraded:
--
--     WITH normalized AS (
--       SELECT CASE WHEN location ILIKE '%tokyo%' THEN 'Tokyo' ... END
--                AS display_location,
--              count(*) AS cnt
--       FROM candidates_upgraded
--       WHERE location IS NOT NULL AND location != ''
--       GROUP BY location
--     )
--     SELECT display_location, SUM(cnt)::int
--     FROM normalized
--     WHERE display_location IS NOT NULL AND display_location != ''
--     GROUP BY display_location HAVING SUM(cnt) >= 100;
--
-- Measured on the live table: 23,600 ms, warm cache, every time.
--
-- The GROUP BY was supposed to mean the 21-branch CASE ran once per DISTINCT
-- location — 19,003 of them — not once per row. It did not. EXPLAIN ANALYZE
-- shows the planner inlining the CTE and pushing the outer
--
--     WHERE display_location IS NOT NULL AND display_location <> ''
--
-- down into the scan, where `display_location` is the CASE expression. The
-- filter therefore appears TWICE in the Parallel Seq Scan's Filter clause, so
-- the whole 21-branch CASE was evaluated twice for each of 5,661,466 rows:
--
--     Parallel Seq Scan on candidates_upgraded
--       (actual time=120.002..23199.902 rows=1887131 loops=3)
--       Filter: (... CASE ... END IS NOT NULL) AND (... CASE ... END <> '')
--
-- That scan is the entire 23 seconds. Buffers were 99% hit on the warm run, so
-- it was never an I/O problem — it was ~238 million ILIKE evaluations.
--
-- THE FIX
--
-- Materialise the part that actually needs to touch all 5.6M rows — the
-- per-location count — and leave the region mapping in application code, where
-- the business rules belong and can be changed without a schema migration.
--
-- The matview is 19,003 rows. The application query also wraps its CTE in
-- `AS MATERIALIZED`, which fences the pushdown so the CASE is evaluated once
-- per row instead of twice. Measured on the live table:
--
--     original query                       23,600 ms
--     + MATERIALIZED fence, no matview      2,436 ms   (~10x)
--     + this matview                          170 ms   (~140x)
--
-- Both improvements are worth having independently, which is why the
-- application keeps a fallback path: with this migration unapplied it still
-- runs the fenced query against a live aggregate at ~2.4s, rather than failing.
--
-- Output is byte-identical throughout: all three forms return the same 884 rows.
--
-- SAFETY: purely additive. CREATE MATERIALIZED VIEW and CREATE INDEX only.
-- Nothing is dropped, altered, rewritten or deleted, and candidates_upgraded is
-- read but never modified.
--
-- EXECUTION
--
--     docker exec -i metaview_db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
--       < packages/scraper/migrations/006_location_counts_matview.sql
--
-- Build takes a few seconds. The application falls back to the old inline
-- aggregate when this matview is absent, so deploying the code before running
-- this migration is safe — just slow.

-- ── 1. The materialised aggregate ───────────────────────────────────────────
-- WITH DATA so it is queryable immediately; an unpopulated matview raises
-- "materialized view has not been populated" on read.
CREATE MATERIALIZED VIEW IF NOT EXISTS candidate_location_counts AS
    SELECT location, count(*)::bigint AS cnt
    FROM   candidates_upgraded
    WHERE  location IS NOT NULL AND location <> ''
    GROUP  BY location
WITH DATA;

-- ── 2. Unique index ─────────────────────────────────────────────────────────
-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY. Without it every refresh
-- takes an ACCESS EXCLUSIVE lock and /api/locations blocks for its duration.
-- `location` is the GROUP BY key, so it is unique by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clc_location
    ON candidate_location_counts (location);

ANALYZE candidate_location_counts;

-- ── 3. Keeping it current ───────────────────────────────────────────────────
-- The matview is a snapshot: regions added by a scrape do not appear until it
-- is refreshed. CONCURRENTLY keeps it readable throughout, at the cost of
-- taking roughly as long as the original aggregate — which is fine, because it
-- is no longer on the request path.
--
--     REFRESH MATERIALIZED VIEW CONCURRENTLY candidate_location_counts;
--
-- The application exposes this as refreshLocationCounts() and calls it after a
-- scrape or a Meilisearch sync, alongside invalidateLocationCache(). Schedule
-- it as well if scrapes are infrequent:
--
--     0 4 * * *  docker exec metaview_db psql -U "$DB_USER" -d "$DB_NAME" \
--                  -c 'REFRESH MATERIALIZED VIEW CONCURRENTLY candidate_location_counts;'
--
-- Staleness check — how far the snapshot has drifted from the live table:
--
--     SELECT (SELECT sum(cnt) FROM candidate_location_counts)      AS snapshot,
--            (SELECT count(*)  FROM candidates_upgraded
--             WHERE location IS NOT NULL AND location <> '')       AS live;

-- ── 4. Verify ───────────────────────────────────────────────────────────────
--   EXPLAIN (ANALYZE, BUFFERS) <the application query>;
--   -- expect a Seq Scan on candidate_location_counts (19k rows), and NO
--   -- reference to candidates_upgraded anywhere in the plan.
