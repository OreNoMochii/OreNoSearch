-- 003_search_indexes_only.sql
--
-- Supersedes 002_search_performance.sql. Do not run 002.
--
-- WHY THIS REPLACES 002
--
-- 002 added a STORED generated column (total_experience_months) to
-- candidates_upgraded. Inspection of the live database showed that to be both
-- unnecessary and dangerous:
--
--   * candidates_upgraded holds 5,661,466 rows / 9.4 GB. ADD COLUMN ... STORED
--     rewrites the entire table under an ACCESS EXCLUSIVE lock — the table is
--     unreadable for the duration.
--   * The table ALREADY has a generated column, experience_months, with a btree
--     index. But it is NOT equivalent: it uses substring(), which returns only
--     the FIRST match, so it measures the first-listed role's duration.
--     calculate_total_experience_months() loops regexp_matches(...,'g') and
--     SUMS every role. On a 500-row sample the two agreed on 84 rows (17%).
--     Repointing the query at experience_months would silently redefine
--     minExp/maxExp from "total career experience" to "first role duration".
--
-- This migration therefore adds ONLY indexes and one extension. It does not
-- ALTER, DROP or rewrite any table, and it changes no row data.
--
-- EXECUTION
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
--   file must be executed in autocommit — do NOT pass --single-transaction / -1.
--
--     docker exec -i metaview_db psql -U "$DB_USER" -d "$DB_NAME" \
--       < packages/scraper/migrations/003_search_indexes_only.sql
--
--   CONCURRENTLY keeps the table readable and writable throughout. Expect
--   roughly 5-10 minutes for the expression index (the function costs ~24 us
--   per row and CONCURRENTLY scans twice) and 1-3 minutes per trigram index.
--
--   If a CONCURRENTLY build is interrupted it leaves an INVALID index behind.
--   Find them with:
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   and DROP INDEX CONCURRENTLY those before re-running. Re-running this file
--   is otherwise safe: every statement is IF NOT EXISTS.

-- ── 0. Fix calculate_total_experience_months (B31) ─────────────────────────
--
-- The original pattern was '(?i)(\d+)\s*yr[s]?' / '(?i)(\d+)\s*mo[s]?'. Two
-- defects, both confirmed against live data:
--
--   1. No word boundary. 'mo' matched the start of any word — Mon, Monday,
--      Monash, MoneyLion — so a phone number, ISBN or URL followed by such a
--      word was parsed as a duration:
--        '03 - 8921252525 Mon - Wed'      -> 8,921,252,525 months
--        '978-3659116025 Monash University' -> 3,659,116,025 months
--   2. Unbounded digit count with an ::int cast. Values above 2^31-1 raise
--      'value out of range for type integer', so the function THREW on 30 rows
--      — meaning any search touching one returned a 500.
--
-- Measured over a 200,000-row sample: 8,634 rows (4.32%) computed a different
-- value, with a maximum of 3,637,917,172,947,581 months. Extrapolated to the
-- full 5.66M-row table that is roughly 245,000 candidates whose experience
-- filter value was wrong.
--
-- The fix bounds the digits to 3 (no one has 1000+ years or months) and
-- requires a word boundary (\y) after the unit. Arithmetic uses bigint
-- internally and clamps, so no input can raise an overflow again.
--
-- This is CREATE OR REPLACE FUNCTION: it alters no table and rewrites no rows.
-- Verified that zero generated columns depend on this function, so replacing
-- it cannot trigger a table rewrite.
CREATE OR REPLACE FUNCTION calculate_total_experience_months(exp TEXT)
RETURNS INTEGER AS $$
DECLARE
    rec     RECORD;
    total_m BIGINT := 0;
BEGIN
    IF exp IS NULL OR exp = '' THEN
        RETURN 0;
    END IF;

    FOR rec IN
        SELECT (regexp_matches(exp, '(?i)(\d{1,3})\s*yrs?\y', 'g'))[1]::bigint AS yrs
    LOOP
        total_m := total_m + (rec.yrs * 12);
    END LOOP;

    FOR rec IN
        SELECT (regexp_matches(exp, '(?i)(\d{1,3})\s*mos?\y', 'g'))[1]::bigint AS mos
    LOOP
        total_m := total_m + rec.mos;
    END LOOP;

    -- Clamp defensively: a CV listing hundreds of roles should not be able to
    -- produce a value the caller cannot represent.
    RETURN LEAST(total_m, 2147483647)::INTEGER;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── 1. Experience filter ────────────────────────────────────────────────────
-- runIlikeSearch filters on calculate_total_experience_months(experience).
-- Without this index that expression is evaluated per row, forcing a
-- sequential scan over 5.6M rows on every experience-filtered search.
--
-- The expression here must match the query's expression exactly, or the
-- planner will not use the index. The function is already declared IMMUTABLE,
-- which is what makes it index-eligible.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_total_exp_months
    ON candidates_upgraded (calculate_total_experience_months(experience));

-- ── 2. Trigram indexes for the leading-wildcard ILIKE predicates ────────────
-- location / current_company / latest_role are all filtered with ILIKE '%x%',
-- which no btree index can serve.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_location_trgm
    ON candidates_upgraded USING GIN (location gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_company_trgm
    ON candidates_upgraded USING GIN (current_company gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_latest_role_trgm
    ON candidates_upgraded USING GIN (latest_role gin_trgm_ops);

-- ── 3. Full-text index ──────────────────────────────────────────────────────
-- Already present as idx_candidates_upgraded_expr_vector and verified to match
-- the query expression, so nothing to create. Left documented so a rebuilt
-- environment knows it is required.

-- ── 4. Planner statistics ───────────────────────────────────────────────────
-- Read-only: collects statistics, modifies no row data.
ANALYZE candidates_upgraded;
