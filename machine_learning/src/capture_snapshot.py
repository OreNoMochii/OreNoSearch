"""
Append-only capture of who works where, so that moves can eventually be
*observed* rather than reconstructed.

Why this is the most valuable thing in the flight-risk work
-----------------------------------------------------------
Everything else in this pipeline infers the past from a single scrape. That is
enough to fit a hazard model on completed spells, and `flight_risk_spells`
does exactly that — but a résumé reconstructed today has three problems no
model can fix:

  1. **Survivorship in the history.** People delete short stints, tidy job
     titles and drop early jobs. The tenure distribution you reconstruct is
     the one people are willing to display, which is longer and smoother than
     the one they lived.
  2. **No behavioural signal.** The strongest real predictors of a move —
     profile edits, headline changes, "open to work", responding to a
     recruiter — are events, not states. A single scrape has none of them.
  3. **No honest prospective test.** Backtesting on reconstructed history
     always leaves the suspicion of a subtle look-ahead. Two real snapshots
     settle it in one query.

A snapshot table fixes all three, and only time can build it. Six monthly
captures over the current corpus is on the order of 2M person-months of
genuinely prospective outcomes. Nothing in Phase 2 or 3 produces a gain of
that size. The clock does not start until the first capture runs.

How the append works
--------------------
The primary key is (profile_url, observed_at), where `observed_at` is the
row's own `scraped_at` — when the data was true — not when this script ran.
That distinction matters: `candidates_upgraded.scraped_at` spans months, so
"capture today" does not mean "true today".

The consequence is the useful property: re-running this against a corpus that
has not been re-scraped inserts nothing. A row appears only when the
underlying observation actually changed. `capture_run` records when the
script ran, so a capture that added nothing is still distinguishable from a
capture that never happened.

Usage
-----
    python -m machine_learning.src.capture_snapshot --capture
    python -m machine_learning.src.capture_snapshot --status
    python -m machine_learning.src.capture_snapshot --transitions
"""

from __future__ import annotations

import argparse
import os
import uuid

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


CREATE_SQL = """
CREATE TABLE IF NOT EXISTS candidate_snapshots (
    profile_url      TEXT      NOT NULL,
    -- When the observation was true (the scrape's own timestamp), NOT when
    -- this script ran. Two captures of an unchanged corpus collapse onto the
    -- same key and the second inserts nothing, which is the correct outcome:
    -- no new observation was made.
    observed_at      TIMESTAMP NOT NULL,
    current_company  TEXT,
    latest_role      TEXT,
    headline         TEXT,
    location         TEXT,
    -- Cheap change-detection over the free-text blob. A headline or summary
    -- edit is the closest thing this corpus has to a behavioural signal, and
    -- comparing hashes across captures is far cheaper than diffing text.
    profile_digest   TEXT,
    capture_run      UUID      NOT NULL,
    captured_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_url, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_snap_observed ON candidate_snapshots(observed_at);
CREATE INDEX IF NOT EXISTS idx_snap_run      ON candidate_snapshots(capture_run);
CREATE INDEX IF NOT EXISTS idx_snap_profile  ON candidate_snapshots(profile_url);

CREATE TABLE IF NOT EXISTS candidate_snapshot_runs (
    capture_run   UUID PRIMARY KEY,
    started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMP,
    rows_seen     BIGINT,
    rows_inserted BIGINT,
    note          TEXT
);
"""

# Set-based: one INSERT ... SELECT rather than streaming millions of rows
# through Python only to send them straight back.
CAPTURE_SQL = """
INSERT INTO candidate_snapshots
    (profile_url, observed_at, current_company, latest_role, headline,
     location, profile_digest, capture_run)
SELECT
    cu.profile_url,
    cu.scraped_at,
    cu.current_company,
    cu.latest_role,
    cu.headline,
    cu.location,
    md5(concat_ws('|', cu.headline, cu.current_company, cu.latest_role,
                       cu.summary, cu.experience)),
    %(run)s
FROM candidates_upgraded cu
WHERE cu.scraped_at IS NOT NULL
ON CONFLICT (profile_url, observed_at) DO NOTHING
"""


def capture(conn, note: str | None) -> int:
    run = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(CREATE_SQL)
        conn.commit()

        cur.execute(
            "INSERT INTO candidate_snapshot_runs (capture_run, note) VALUES (%s, %s)",
            (run, note),
        )
        conn.commit()

        print(f"capture run {run}")
        cur.execute("SELECT count(*) FROM candidates_upgraded WHERE scraped_at IS NOT NULL")
        seen = cur.fetchone()[0]
        print(f"  {seen:,} source rows with a scrape timestamp")

        print("  appending…")
        cur.execute(CAPTURE_SQL, {"run": run})
        inserted = cur.rowcount
        cur.execute(
            """UPDATE candidate_snapshot_runs
               SET finished_at = NOW(), rows_seen = %s, rows_inserted = %s
               WHERE capture_run = %s""",
            (seen, inserted, run),
        )
        conn.commit()

    print(f"  {inserted:,} new observations appended")
    if inserted == 0:
        print(
            "\n  Nothing new — the corpus has not been re-scraped since the last\n"
            "  capture. Expected on a repeat run; this is not an error. New rows\n"
            "  appear only when scraped_at advances."
        )
    return 0


STATUS_SQL = """
SELECT
    r.capture_run,
    r.started_at,
    r.rows_seen,
    r.rows_inserted,
    r.note
FROM candidate_snapshot_runs r
ORDER BY r.started_at DESC
LIMIT 20
"""


def status(conn) -> int:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(
            "SELECT to_regclass('public.candidate_snapshots') IS NOT NULL AS ok"
        )
        if not cur.fetchone()["ok"]:
            print("candidate_snapshots does not exist yet — run --capture.")
            return 1

        cur.execute(
            """SELECT count(*) rows, count(DISTINCT profile_url) profiles,
                      count(DISTINCT observed_at::date) distinct_days,
                      min(observed_at) first_obs, max(observed_at) last_obs
               FROM candidate_snapshots"""
        )
        s = cur.fetchone()
        print(f"{s['rows']:,} observations of {s['profiles']:,} profiles")
        print(f"  observed between {s['first_obs']} and {s['last_obs']}")
        print(f"  {s['distinct_days']:,} distinct observation days")

        cur.execute(
            """SELECT count(*) n FROM (
                   SELECT profile_url FROM candidate_snapshots
                   GROUP BY profile_url HAVING count(*) > 1) x"""
        )
        multi = cur.fetchone()["n"]
        print(f"  {multi:,} profiles observed more than once")
        if multi == 0:
            print(
                "\n  No profile has two observations yet, so no move has been\n"
                "  OBSERVED. Until the corpus is re-scraped this table is a\n"
                "  baseline, not yet evidence. That is the expected state after\n"
                "  a first capture."
            )

        print("\nruns:")
        cur.execute(STATUS_SQL)
        for r in cur.fetchall():
            note = f"  {r['note']}" if r["note"] else ""
            print(
                f"  {str(r['started_at'])[:19]}  seen={r['rows_seen'] or 0:>10,}  "
                f"new={r['rows_inserted'] or 0:>10,}{note}"
            )
    return 0


# Consecutive observations of the same profile. This is the query the whole
# table exists to make possible: an employer change between two real
# observations, with both endpoints dated — no reconstruction, no inference
# from list position.
TRANSITIONS_SQL = """
WITH ordered AS (
    SELECT
        profile_url,
        observed_at,
        current_company,
        profile_digest,
        lag(current_company) OVER w AS prev_company,
        lag(profile_digest)  OVER w AS prev_digest,
        lag(observed_at)     OVER w AS prev_observed
    FROM candidate_snapshots
    WINDOW w AS (PARTITION BY profile_url ORDER BY observed_at)
)
SELECT
    count(*) FILTER (WHERE prev_observed IS NOT NULL)                    AS comparable_pairs,
    count(*) FILTER (WHERE prev_company IS DISTINCT FROM current_company
                       AND prev_observed IS NOT NULL)                    AS employer_changes,
    count(*) FILTER (WHERE prev_digest IS DISTINCT FROM profile_digest
                       AND prev_observed IS NOT NULL)                    AS profile_edits,
    round(avg(EXTRACT(EPOCH FROM (observed_at - prev_observed)) / 86400.0)
          FILTER (WHERE prev_observed IS NOT NULL)::numeric, 1)          AS mean_gap_days
FROM ordered
"""


def transitions(conn) -> int:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("SELECT to_regclass('public.candidate_snapshots') IS NOT NULL AS ok")
        if not cur.fetchone()["ok"]:
            print("candidate_snapshots does not exist yet — run --capture.")
            return 1
        cur.execute(TRANSITIONS_SQL)
        t = cur.fetchone()

    pairs = t["comparable_pairs"] or 0
    print(f"comparable observation pairs  {pairs:,}")
    if pairs == 0:
        print(
            "\nNo profile has been observed twice, so there are no observed\n"
            "transitions yet. Re-run --capture after the next scrape.\n"
            "Until then, train on flight_risk_spells and treat its results as\n"
            "reconstructed rather than prospective."
        )
        return 0

    print(f"  employer changes            {t['employer_changes']:,}")
    print(f"  profile edits (any field)   {t['profile_edits']:,}")
    print(f"  mean gap between obs        {t['mean_gap_days']} days")
    print(
        "\nThese are OBSERVED moves: both endpoints are real observations with\n"
        "timestamps. Unlike anything reconstructed from a single scrape, they\n"
        "carry no look-ahead risk and can be used as a held-out prospective test."
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--capture", action="store_true", help="append the current corpus state")
    ap.add_argument("--status", action="store_true", help="what has been captured so far")
    ap.add_argument("--transitions", action="store_true", help="observed moves between captures")
    ap.add_argument("--note", type=str, default=None, help="label for this capture run")
    args = ap.parse_args()

    if not (args.capture or args.status or args.transitions):
        ap.print_help()
        return 2

    conn = psycopg2.connect(**db_config())
    try:
        rc = 0
        if args.capture:
            rc |= capture(conn, args.note)
        if args.status:
            rc |= status(conn)
        if args.transitions:
            rc |= transitions(conn)
        return rc
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
