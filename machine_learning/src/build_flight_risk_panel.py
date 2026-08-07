"""
Build the point-in-time employer-spell panel that flight-risk models train on.

What changed and why
--------------------
The plan for this step was to learn from `candidates_upgraded_time_machine`,
on the assumption that its 12,826 rows were an earlier scrape and therefore
observed transitions. They are not. Of 12,826 rows, 12,520 (97.6%) have BOTH
`past_company` and `past_role` exactly equal to the role at role_index 1 of
the profile's current experience list. It is a derived "previous employer"
column, not a snapshot. It contains nothing that is not already in
`experience`, and a model trained to predict it would be learning to read the
second line of its own input.

The real ground truth is the career history itself, now that
extract_career_dates.py has put it on a calendar. A completed employer spell
is an observed event with an exact duration; a current spell is right-censored
at the scrape date. That yields ~3.4M dated roles spanning decades, with many
observations per person, which is strictly more information than any two-point
comparison would have given.

What this builds
----------------
`flight_risk_spells` — one row per employer spell:

    spell_start / spell_end   calendar bounds
    duration_months           spell_end - spell_start, or censored at scrape
    event                     1 = observed to leave, 0 = right-censored
    prior_*                   history as of spell_start, and only as of then

Consecutive roles at the same employer are collapsed into one spell. An
internal promotion is not a flight event, and counting it as one is how you
end up with a model that thinks getting promoted means leaving.

The leakage rule
----------------
This is the rule the previous generation of this pipeline broke, in three
places at once:

  - `recency_factor = 1/(1+current_duration)` and
    `hist_flight_risk  = current_duration/hist_avg` were fed to a classifier
    whose label was `current_tenure_months < 10`. Feature and label were the
    same variable.
  - `tenure_ratio`, `record_tenure_ratio` and `seniority_stagnation_months`
    were fed to survival models scored against `duration_months` — which is
    the numerator of the first two and the seed of the third.

So, structurally, here:

    a feature may only read spells that ENDED STRICTLY BEFORE spell_start.

Not "before the scrape", not "excluding the current role" — before the start
of the spell being predicted. The spell's own duration is the outcome and can
never appear on the feature side; elapsed tenure enters a model as the hazard
function's time index, never as a covariate.

`--check-leakage` enforces this empirically: it correlates every feature
against the outcome duration on completed spells and fails on anything above
a threshold. Run it before training. It is the test that would have caught
c_index 0.983.

Usage
-----
    python -m machine_learning.src.build_flight_risk_panel --build
    python -m machine_learning.src.build_flight_risk_panel --check-leakage
    python -m machine_learning.src.build_flight_risk_panel --summary
"""

from __future__ import annotations

import argparse
import os

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(
    dotenv_path=os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
)


def db_config() -> dict:
    return dict(
        dbname=os.getenv("DB_NAME", "metaview_scraper"),
        user=os.getenv("DB_USER", "scraper_user"),
        password=os.getenv("DB_PASSWORD", "scraper_password"),
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5433"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Spell construction
# ─────────────────────────────────────────────────────────────────────────────

# Written to a staging table first and renamed into place, so a failed rebuild
# leaves the previous panel intact. Nothing is ever dropped except staging
# tables this script itself created.
#
# Two statements, not one. The prior-history features are a correlated lookup
# per spell ("all of this person's spells that had already ended"), and against
# an unmaterialised CTE that is a re-scan per row — quadratic in a table with
# millions of spells. Landing the base spells in a real, indexed table first
# turns each lookup into an index probe.
BUILD_BASE_SQL = """
DROP TABLE IF EXISTS flight_risk_spells_base;

CREATE TABLE flight_risk_spells_base AS
WITH roles AS (
    SELECT
        d.profile_url,
        d.company,
        d.role_title,
        d.start_date,
        d.end_date,
        d.is_current,
        d.observed_at::date AS observed_on,
        row_number() OVER w                                   AS seq,
        lag(d.company) OVER w                                 AS prev_company
    FROM candidate_role_dates d
    WHERE d.start_date IS NOT NULL
      AND d.company IS NOT NULL
      AND d.company <> ''
    WINDOW w AS (PARTITION BY d.profile_url ORDER BY d.start_date, d.role_index DESC)
),
-- Gaps-and-islands: a new island starts whenever the employer changes.
-- Roles are already in chronological order, so consecutive rows at the same
-- company are one continuous stay regardless of how many titles it spans.
islands AS (
    SELECT *,
           sum(CASE WHEN company IS DISTINCT FROM prev_company THEN 1 ELSE 0 END)
               OVER (PARTITION BY profile_url ORDER BY seq
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS spell_id
    FROM roles
),
spells AS (
    SELECT
        profile_url,
        spell_id,
        min(company)                        AS company,
        min(start_date)                     AS spell_start,
        -- A spell containing a live role has not ended, whatever end dates
        -- the other roles in it carry.
        CASE WHEN bool_or(is_current) THEN NULL ELSE max(end_date) END AS spell_end,
        bool_or(is_current)                 AS is_current,
        max(observed_on)                    AS observed_on,
        count(*)                            AS n_internal_roles,
        max(role_title)                     AS last_role_title
    FROM islands
    GROUP BY profile_url, spell_id
),
timed AS (
    SELECT
        s.*,
        CASE WHEN s.is_current OR s.spell_end IS NULL
             THEN 0 ELSE 1 END AS event,
        CASE
            WHEN s.is_current OR s.spell_end IS NULL THEN
                -- Right-censored: observed to still be there at the scrape.
                (EXTRACT(YEAR  FROM s.observed_on) - EXTRACT(YEAR  FROM s.spell_start)) * 12
              + (EXTRACT(MONTH FROM s.observed_on) - EXTRACT(MONTH FROM s.spell_start))
            ELSE
                (EXTRACT(YEAR  FROM s.spell_end)   - EXTRACT(YEAR  FROM s.spell_start)) * 12
              + (EXTRACT(MONTH FROM s.spell_end)   - EXTRACT(MONTH FROM s.spell_start))
        END::numeric AS duration_months
    FROM spells s
)
SELECT * FROM timed
WHERE duration_months >= 0
  AND duration_months <= 720;   -- 60 years; beyond that is a parse artefact

-- The probe the feature pass makes per spell: this person's already-finished
-- spells, ordered by when they ended.
CREATE INDEX ON flight_risk_spells_base (profile_url, spell_end);
ANALYZE flight_risk_spells_base;
"""

BUILD_PANEL_SQL = """
DROP TABLE IF EXISTS flight_risk_spells_staging;

CREATE TABLE flight_risk_spells_staging AS
SELECT
    t.profile_url,
    t.spell_id,
    t.company,
    t.last_role_title,
    t.spell_start,
    t.spell_end,
    t.observed_on,
    t.is_current,
    t.event,
    t.duration_months,
    t.n_internal_roles,

    -- Calendar position of the decision point. April matters in Japan:
    -- 新卒一括採用 puts the cohort intake, and much of the mid-career market,
    -- on the fiscal-year boundary.
    EXTRACT(MONTH   FROM t.spell_start)::int AS start_month,
    EXTRACT(YEAR    FROM t.spell_start)::int AS start_year,
    EXTRACT(QUARTER FROM t.spell_start)::int AS start_quarter,

    -- ── Prior history, strictly as of spell_start ────────────────────────
    -- The correlated subqueries below all filter `p.spell_end < t.spell_start`.
    -- That is the leakage rule, expressed structurally: only spells that had
    -- already finished when this one began are visible. `p.spell_end` is
    -- non-null by construction for a completed spell, so current spells are
    -- excluded automatically.
    COALESCE(h.prior_n_employers, 0)          AS prior_n_employers,
    h.prior_avg_tenure,
    h.prior_median_tenure,
    h.prior_max_tenure,
    h.prior_min_tenure,
    h.prior_stddev_tenure,
    COALESCE(h.prior_total_months, 0)         AS prior_total_months,
    COALESCE(h.prior_short_stints, 0)         AS prior_short_stints,
    h.prior_last_tenure,

    -- Months between the end of the previous employer and the start of this
    -- one. Negative means overlap (concurrent roles); large positive means a
    -- career gap. Both are real signals and neither is derivable from this
    -- spell's duration.
    CASE WHEN h.prior_last_end IS NOT NULL THEN
        (EXTRACT(YEAR  FROM t.spell_start) - EXTRACT(YEAR  FROM h.prior_last_end)) * 12
      + (EXTRACT(MONTH FROM t.spell_start) - EXTRACT(MONTH FROM h.prior_last_end))
    END::numeric                              AS gap_before_months,

    -- Career length at the decision point, from prior spells only.
    CASE WHEN h.prior_first_start IS NOT NULL THEN
        (EXTRACT(YEAR  FROM t.spell_start) - EXTRACT(YEAR  FROM h.prior_first_start)) * 12
      + (EXTRACT(MONTH FROM t.spell_start) - EXTRACT(MONTH FROM h.prior_first_start))
    END::numeric                              AS career_months_at_start,

    -- Labour market, from the profile's location. This is a market, not a
    -- nationality: tenure norms are a property of where someone works, and
    -- inferring nationality would be both weaker and legally exposed.
    CASE
        WHEN cu.location ILIKE ANY (ARRAY['%japan%','%tokyo%','%osaka%','%kyoto%',
                                          '%yokohama%','%saitama%','%chiba%',
                                          '%kanagawa%','%nagoya%'])          THEN 'Japan'
        WHEN cu.location ILIKE '%singapore%'                                  THEN 'Singapore'
        WHEN cu.location ILIKE ANY (ARRAY['%vietnam%','%ho chi minh%','%hanoi%',
                                          '%da nang%'])                       THEN 'Vietnam'
        WHEN cu.location ILIKE ANY (ARRAY['%malaysia%','%kuala lumpur%','%selangor%',
                                          '%penang%','%cyberjaya%','%shah alam%',
                                          '%subang%','%petaling%'])            THEN 'Malaysia'
        ELSE 'Other'
    END                                        AS market
FROM flight_risk_spells_base t
LEFT JOIN candidates_upgraded cu ON cu.profile_url = t.profile_url
LEFT JOIN LATERAL (
    SELECT
        count(*)                                        AS prior_n_employers,
        avg(p.duration_months)                          AS prior_avg_tenure,
        percentile_cont(0.5) WITHIN GROUP
            (ORDER BY p.duration_months)                AS prior_median_tenure,
        max(p.duration_months)                          AS prior_max_tenure,
        min(p.duration_months)                          AS prior_min_tenure,
        stddev_pop(p.duration_months)                   AS prior_stddev_tenure,
        sum(p.duration_months)                          AS prior_total_months,
        count(*) FILTER (WHERE p.duration_months < 18)  AS prior_short_stints,
        max(p.spell_end)                                AS prior_last_end,
        min(p.spell_start)                              AS prior_first_start,
        (array_agg(p.duration_months ORDER BY p.spell_end DESC))[1] AS prior_last_tenure
    FROM flight_risk_spells_base p
    WHERE p.profile_url = t.profile_url
      AND p.spell_end IS NOT NULL
      AND p.spell_end < t.spell_start          -- ← the leakage rule
) h ON TRUE;

ALTER TABLE flight_risk_spells_staging
    ADD PRIMARY KEY (profile_url, spell_id);
CREATE INDEX ON flight_risk_spells_staging (market);
CREATE INDEX ON flight_risk_spells_staging (spell_start);
CREATE INDEX ON flight_risk_spells_staging (event);

DROP TABLE IF EXISTS flight_risk_spells_previous;
ALTER TABLE IF EXISTS flight_risk_spells RENAME TO flight_risk_spells_previous;
ALTER TABLE flight_risk_spells_staging RENAME TO flight_risk_spells;
"""


def build(conn) -> None:
    with conn.cursor() as cur:
        print("[1/2] collapsing roles into employer spells…")
        cur.execute(BUILD_BASE_SQL)
        conn.commit()
        cur.execute("SELECT count(*) FROM flight_risk_spells_base")
        print(f"      {cur.fetchone()[0]:,} spells")

        print("[2/2] attaching prior-history features (as-of spell_start)…")
        cur.execute(BUILD_PANEL_SQL)
        conn.commit()
    print("Built. Previous panel, if any, retained as flight_risk_spells_previous.")


# ─────────────────────────────────────────────────────────────────────────────
# Leakage check
# ─────────────────────────────────────────────────────────────────────────────

# Everything a model is allowed to see. Deliberately explicit: a leaked feature
# gets in by being added silently, so the list is the contract.
#
# Everything named prior_* is safe by construction — the SQL that produces it
# can only read spells that ended before spell_start. The rest are
# decision-point context and had to be cleared one at a time.
FEATURES = [
    "prior_n_employers",
    "prior_avg_tenure",
    "prior_median_tenure",
    "prior_max_tenure",
    "prior_min_tenure",
    "prior_stddev_tenure",
    "prior_total_months",
    "prior_short_stints",
    "prior_last_tenure",
    "gap_before_months",
    "career_months_at_start",
    "start_month",
    "start_quarter",
]

# Present in the table, deliberately NOT features. Both are future information
# that the correlation check alone would have waved through — they came in at
# |r| = 0.34 and 0.46, under the 0.75 threshold — so they are excluded by
# argument, not by measurement. A threshold catches restatements of the
# outcome; it does not catch a feature that is merely *shaped* by it.
#
#   n_internal_roles  counted over the whole spell, so it includes promotions
#                     that happen AFTER the point being predicted. Scoring a
#                     live candidate you would know only the titles so far.
#                     The honest version is "internal roles as of month t",
#                     which belongs in the person-period expansion.
#
#   start_year        administrative censoring, not signal. Among completed
#                     spells a 2025 start cannot have lasted five years, so the
#                     correlation with duration is an artefact of how much
#                     observation window was left. A model given this learns
#                     "recent hire ⇒ short tenure" and carries that nonsense
#                     into production. Use it for the time-based split, never
#                     as a covariate.
EXCLUDED_FROM_FEATURES = {
    "n_internal_roles": "counted over the whole spell; includes post-prediction promotions",
    "start_year": "observation-window bias, not signal; use for the time split only",
}

# Above this, treat the feature as contaminated. Genuine predictors of tenure
# correlate with it — that is the point — but a correlation this strong on the
# outcome variable means the feature is a restatement of it, not a predictor.
# For reference, the features this pipeline previously used sat at ~0.9+.
LEAK_THRESHOLD = 0.75


def check_leakage(conn) -> int:
    """
    Correlate each feature with the outcome duration on completed spells.

    This is the check the previous pipeline never had. `tenure_ratio` is
    duration/prior_avg and `recency_factor` is 1/(1+duration); both would land
    near the ceiling here, and both were shipped into production models.

    What it does NOT catch: a feature that is merely shaped by the outcome
    rather than a restatement of it. `n_internal_roles` and `start_year` both
    scored well under the threshold and are both future information — see
    EXCLUDED_FROM_FEATURES. They are reported below the line so the exclusion
    stays visible rather than becoming folklore. A passing number here is
    necessary, not sufficient; every new feature still needs the argument for
    why it is knowable at spell_start.
    """
    audited = FEATURES + sorted(EXCLUDED_FROM_FEATURES)
    cols = ",\n        ".join(
        f"corr({f}::float8, duration_months::float8) AS {f}" for f in audited
    )
    sql = f"""
        SELECT
        {cols}
        FROM flight_risk_spells
        WHERE event = 1
    """
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(sql)
        row = cur.fetchone()

    print("Pearson r against outcome duration (completed spells only)\n")
    worst = 0.0
    failures = []
    for f in FEATURES:
        r = row[f]
        if r is None:
            print(f"  {f:<26}      n/a  (no variance or all null)")
            continue
        flag = ""
        if abs(r) > LEAK_THRESHOLD:
            flag = "  ← LEAK"
            failures.append((f, r))
        worst = max(worst, abs(r))
        print(f"  {f:<26} {r:+7.4f}{flag}")

    print("\n  -- excluded from the model, kept in the table --")
    for f, why in sorted(EXCLUDED_FROM_FEATURES.items()):
        r = row[f]
        shown = f"{r:+7.4f}" if r is not None else "    n/a"
        print(f"  {f:<26} {shown}   {why}")

    print(f"\nthreshold |r| > {LEAK_THRESHOLD} (applies to features only)")
    if failures:
        print("FAIL — these features restate the outcome:")
        for f, r in failures:
            print(f"  {f} (r={r:+.4f})")
        return 1
    print(f"PASS — no feature exceeds the threshold (max |r| = {worst:.4f}).")
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

SUMMARY_SQL = """
SELECT
    market,
    count(*)                                              AS spells,
    count(*) FILTER (WHERE event = 1)                     AS observed_exits,
    round(100.0 * avg(event), 1)                          AS pct_observed,
    round(avg(duration_months) FILTER (WHERE event = 1), 1) AS mean_completed_tenure,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_months)
          FILTER (WHERE event = 1)::numeric, 1)           AS median_completed_tenure,
    round(avg(duration_months) FILTER (WHERE event = 0), 1) AS mean_censored_tenure
FROM flight_risk_spells
GROUP BY market
ORDER BY spells DESC
"""


def summary(conn) -> int:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("SELECT count(*) n, count(DISTINCT profile_url) p FROM flight_risk_spells")
        tot = cur.fetchone()
        print(f"{tot['n']:,} spells across {tot['p']:,} profiles\n")

        cur.execute(SUMMARY_SQL)
        rows = cur.fetchall()

    hdr = f"{'market':<11}{'spells':>10}{'exits':>10}{'%obs':>7}{'mean_t':>9}{'med_t':>8}{'censored_t':>12}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['market']:<11}{r['spells']:>10,}{r['observed_exits']:>10,}"
            f"{r['pct_observed']:>7}{r['mean_completed_tenure'] or 0:>9}"
            f"{r['median_completed_tenure'] or 0:>8}{r['mean_censored_tenure'] or 0:>12}"
        )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--build", action="store_true", help="rebuild the spell panel")
    ap.add_argument("--check-leakage", action="store_true", help="fail if a feature restates the outcome")
    ap.add_argument("--summary", action="store_true", help="describe the panel")
    args = ap.parse_args()

    if not (args.build or args.check_leakage or args.summary):
        ap.print_help()
        return 2

    conn = psycopg2.connect(**db_config())
    try:
        if args.build:
            build(conn)
        rc = 0
        if args.check_leakage:
            rc |= check_leakage(conn)
        if args.summary:
            rc |= summary(conn)
        return rc
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
