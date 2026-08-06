-- 007_agentic_screening.sql
--
-- Storage for the agentic screening pipeline and its eval harness.
--
-- Three tables, all new:
--
--   jd_rubrics       compiled, human-approvable screening criteria per JD
--   screening_audit  per-candidate, per-stage record of how a verdict was
--                    reached — the substrate the eval harness scores against
--   eval_labels      ground truth: what a human says the answer should be
--
-- WHY THESE EXIST
--
-- The previous agent pasted the raw JD into the system prompt on every call, so
-- each candidate was judged against a freshly re-derived — and slightly
-- different — reading of the requirements. jd_rubrics compiles that reading
-- once, lets a human approve it, and reuses it for every candidate in the
-- campaign, which is what makes verdicts comparable to each other at all.
--
-- screening_audit exists because `screening_results` records only the verdict
-- and a prose reason. That is not enough to answer "why did this candidate
-- pass?" or "did this prompt change help?". Scoring a pipeline needs the
-- intermediate state: which knockouts fired, which quotes verified, what the
-- adjudicator and challenger each said.
--
-- SAFETY: purely additive. CREATE TABLE / CREATE INDEX only. Nothing is
-- dropped, altered or rewritten, and no existing table is touched.
--
-- EXECUTION
--     docker exec -i metaview_db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
--       < packages/scraper/migrations/007_agentic_screening.sql

-- ── 1. Compiled JD rubrics ──────────────────────────────────────────────────
-- Keyed by a hash of the JD text, so an unchanged JD reuses its rubric across
-- campaigns and re-runs. `approved_at` gates whether a human has signed off:
-- the pipeline can be configured to refuse to run on an unapproved rubric,
-- which is the point of the human-in-the-loop step.
CREATE TABLE IF NOT EXISTS jd_rubrics (
    jd_hash        TEXT PRIMARY KEY,
    job_name       TEXT,
    company_name   TEXT,
    -- Full compiled rubric: knockouts, competencies, seniority band,
    -- anti-signals. Shape is owned by packages/api/src/screening/schemas.ts.
    rubric         JSONB       NOT NULL,
    -- Model and prompt revision that produced it, so a rubric can be traced
    -- back to the code that generated it.
    compiled_by    TEXT,
    prompt_version TEXT,
    approved_at    TIMESTAMPTZ,
    approved_by    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jd_rubrics_job
    ON jd_rubrics (company_name, job_name);

-- ── 2. Per-candidate audit trail ────────────────────────────────────────────
-- One row per candidate per pipeline run. `run_id` groups a batch so two
-- configurations can be compared over the same candidates.
CREATE TABLE IF NOT EXISTS screening_audit (
    id              BIGSERIAL PRIMARY KEY,
    run_id          TEXT        NOT NULL,
    profile_url     TEXT        NOT NULL,
    jd_hash         TEXT        NOT NULL,
    company_name    TEXT,
    job_name        TEXT,

    -- Terminal decision: PASS | REJECT | UNCERTAIN.
    -- UNCERTAIN is a first-class outcome, not a failure — forcing a binary
    -- call on a thin profile is precisely what produces false positives.
    decision        TEXT        NOT NULL,
    -- Which stage ended it: gates | prefilter | adjudicator | challenger | decision
    decided_at_stage TEXT       NOT NULL,
    confidence      NUMERIC(4,3),

    -- Stage outputs, each nullable because a candidate rejected at stage 1
    -- never reaches stage 4.
    gate_result       JSONB,
    prefilter_score   NUMERIC(8,4),
    evidence          JSONB,
    adjudication      JSONB,
    challenge         JSONB,

    -- Grounding counters, denormalised for cheap aggregate reporting: these
    -- answer "how often is this model inventing quotes?" without unpacking the
    -- evidence JSON.
    quotes_verified   INTEGER NOT NULL DEFAULT 0,
    quotes_unverified INTEGER NOT NULL DEFAULT 0,

    -- Cost accounting, so a precision gain can be weighed against its price.
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    duration_ms       INTEGER,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One verdict per candidate per run; a retry should overwrite, not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_screening_audit_run_profile
    ON screening_audit (run_id, profile_url);
CREATE INDEX IF NOT EXISTS idx_screening_audit_jd
    ON screening_audit (jd_hash, decision);
CREATE INDEX IF NOT EXISTS idx_screening_audit_profile
    ON screening_audit (profile_url);

-- ── 3. Ground truth ─────────────────────────────────────────────────────────
-- `label` is what a human says the answer should be for this candidate against
-- this JD. `source` records how the label was obtained, because they are not
-- equally trustworthy:
--
--   human_review   a person explicitly adjudicated this pair — strongest
--   contacted      the recruiter contacted them after a PASS — weak positive
--   not_contacted  passed screening but was never contacted — weak negative
--   legacy_verdict the old agent's own verdict — NOT ground truth; only useful
--                  as a baseline to measure agreement against
--
-- Weak labels are for bootstrapping and should be promoted to human_review
-- before being trusted for a release gate.
CREATE TABLE IF NOT EXISTS eval_labels (
    id            BIGSERIAL PRIMARY KEY,
    profile_url   TEXT        NOT NULL,
    jd_hash       TEXT        NOT NULL,
    company_name  TEXT,
    job_name      TEXT,
    label         TEXT        NOT NULL CHECK (label IN ('FIT', 'NOT_FIT')),
    source        TEXT        NOT NULL,
    -- 0..1. Weak sources should carry a lower weight than a human review.
    confidence    NUMERIC(4,3) NOT NULL DEFAULT 1.0,
    notes         TEXT,
    labelled_by   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_labels_pair
    ON eval_labels (profile_url, jd_hash);
CREATE INDEX IF NOT EXISTS idx_eval_labels_source
    ON eval_labels (source, label);

ANALYZE jd_rubrics;
ANALYZE screening_audit;
ANALYZE eval_labels;
