-- 004_materialise_experience_months.sql
--
-- Materialises calculate_total_experience_months(experience) into a real
-- column so the experience filter becomes an indexed integer comparison
-- instead of a per-row plpgsql call.
--
-- WHY NOT A GENERATED COLUMN
--
-- The obvious form is:
--
--   ALTER TABLE candidates_upgraded
--     ADD COLUMN total_experience_months INTEGER
--     GENERATED ALWAYS AS (calculate_total_experience_months(experience)) STORED;
--
-- That is what migration 002 did, and it is why 002 is marked DO NOT RUN.
-- A STORED generated column forces a full table rewrite under an
-- ACCESS EXCLUSIVE lock: on 5,661,466 rows / 4 GB of heap the table is
-- completely unreadable and unwritable for the duration, and it needs free
-- disk equal to the table size.
--
-- This migration reaches the same end state without ever taking a long lock:
--
--   1. ADD COLUMN with no default and no NOT NULL. Since PostgreSQL 11 this
--      is a catalog-only change. Measured on the live table: 0.095 seconds.
--   2. Backfill in keyset batches, each its own transaction, so no lock is
--      held for more than a few seconds and the table stays fully available.
--   3. A trigger keeps the column correct for new and updated rows.
--   4. Build the index CONCURRENTLY.
--
-- ORDER MATTERS. Do not point queries at the column until step 2 reports
-- zero remaining NULLs: an unfilled row fails `total_experience_months >= n`
-- and would silently disappear from results.

-- ── 1. Add the column (catalog-only, instant) ───────────────────────────────
-- lock_timeout prevents this from queueing behind a long-running transaction
-- and blocking every subsequent query on the table.
SET lock_timeout = '5s';
ALTER TABLE candidates_upgraded
    ADD COLUMN IF NOT EXISTS total_experience_months INTEGER;
RESET lock_timeout;

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
-- Run OUTSIDE this file, in batches. A single UPDATE over 5.6M rows would hold
-- one enormous transaction and bloat the heap badly.
--
--   cursor=''
--   loop:
--     WITH batch AS (
--       SELECT profile_url FROM candidates_upgraded
--       WHERE profile_url > :cursor ORDER BY profile_url LIMIT 200000
--     ), upd AS (
--       UPDATE candidates_upgraded c
--       SET total_experience_months = calculate_total_experience_months(c.experience)
--       FROM batch b
--       WHERE c.profile_url = b.profile_url AND c.total_experience_months IS NULL
--       RETURNING 1
--     )
--     SELECT (SELECT count(*) FROM upd), (SELECT max(profile_url) FROM batch);
--     -- stop when the cursor stops advancing
--
-- Keyset pagination on the primary key, not `WHERE ... IS NULL LIMIT n`. The
-- latter rescans an ever-larger prefix of already-filled rows and degrades
-- quadratically — measured at 100k rows per 90s and slowing.
--
-- Verify before proceeding:
--   SELECT count(*) FROM candidates_upgraded WHERE total_experience_months IS NULL;
--   -- must be 0

-- ── 3. Keep it correct ──────────────────────────────────────────────────────
-- The column is plain, not generated, so it needs maintaining. The trigger
-- fires only when `experience` is actually part of an UPDATE, and the
-- IS DISTINCT FROM guard skips no-op writes.
CREATE OR REPLACE FUNCTION trg_set_total_experience_months()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.experience IS DISTINCT FROM OLD.experience THEN
        NEW.total_experience_months :=
            calculate_total_experience_months(NEW.experience);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_total_experience_months ON candidates_upgraded;
CREATE TRIGGER set_total_experience_months
    BEFORE INSERT OR UPDATE OF experience ON candidates_upgraded
    FOR EACH ROW EXECUTE FUNCTION trg_set_total_experience_months();

-- ── 4. Index ────────────────────────────────────────────────────────────────
-- CONCURRENTLY cannot run inside a transaction block; execute in autocommit.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cu_total_exp_months_col
    ON candidates_upgraded (total_experience_months);

-- ── 5. Reclaim backfill bloat ───────────────────────────────────────────────
-- Every updated row wrote a new version. VACUUM returns that space to the
-- table for reuse. Plain VACUUM, not VACUUM FULL — the latter takes an
-- ACCESS EXCLUSIVE lock and rewrites the table, which is the very thing this
-- migration exists to avoid.
VACUUM (ANALYZE) candidates_upgraded;

-- ── 6. Then, and only then ──────────────────────────────────────────────────
-- Switch runIlikeSearch to filter on total_experience_months, and drop the
-- now-redundant expression index:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_cu_total_exp_months;
