"""
Recover calendar dates for every role in the corpus.

Why this exists
---------------
`candidate_career_events` has `start_approx` and `end_approx` columns declared
in create_tables_v2.sql. Nothing has ever written them: build_features_v2.py's
INSERT omits both, and parse_profiles_v2.py explicitly sets them to None and
moves on. Every downstream model therefore sees durations with no position on
a calendar.

That single gap is what makes the current flight-risk work unsound. Without
dates you cannot:

  - build a point-in-time feature set (what was true *before* the outcome),
  - form a risk set at a given calendar month,
  - separate a person effect from a 2020-hiring-freeze effect,
  - or express the target as "moves within the next 12 months" at all.

The dates were in the scrape the whole time. parse_profiles_v2.py captures the
duration line into `duration_line` and then reads only the parenthesised
duration out of it, discarding the endpoints:

    Apr 2016 → Mar 2020 (3 yrs 11 mos)
    ^^^^^^^^^^^^^^^^^^^^ dropped        ^^^^^^^^^^^^ kept

This module re-reads the raw `experience` text and recovers them.

Output
------
A new table, `candidate_role_dates`. Nothing existing is modified or dropped:
`candidate_career_events` is left exactly as it is, and the two tables are
joined by a view rather than merged, so a bad parse here can never corrupt
what is already there.

Both durations are stored side by side:

  duration_months_stated   parsed out of "(3 yrs 11 mos)"
  duration_months_derived  computed from the two endpoints

They come from independent parts of the same line, so disagreement means the
parse is wrong. `--verify` reports the agreement rate; it is the correctness
evidence for this step, and it should be run before anything consumes the
output.

Usage
-----
    python -m machine_learning.src.extract_career_dates --create
    python -m machine_learning.src.extract_career_dates --limit 20000
    python -m machine_learning.src.extract_career_dates --verify
"""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from datetime import date

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
# Parsing
# ─────────────────────────────────────────────────────────────────────────────

MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

# Verified against the corpus: a census of the token before "→" over 40k
# profiles returns exactly these twelve three-letter abbreviations and nothing
# else. No "Sept", no localised or kanji dates. If that ever stops holding,
# `unparsed_date_line` in --verify is what will show it.
DATE_LINE = re.compile(
    r"^(?P<sm>[A-Z][a-z]{2})\s+(?P<sy>\d{4})"
    r"\s*→\s*"
    r"(?:(?P<em>[A-Z][a-z]{2})\s+(?P<ey>\d{4})|(?P<now>Now|Present))"
    r"(?:\s*\((?P<dur>[^)]*)\))?"
)

DUR_YEARS = re.compile(r"(\d+)\s*yr")
DUR_MONTHS = re.compile(r"(\d+)\s*mo")


def parse_stated_duration(text: str | None) -> float | None:
    """Months out of a "(3 yrs 11 mos)" fragment."""
    if not text:
        return None
    y = DUR_YEARS.search(text)
    m = DUR_MONTHS.search(text)
    if not y and not m:
        return None
    return (int(y.group(1)) * 12 if y else 0) + (int(m.group(1)) if m else 0)


def months_between(start: date, end: date) -> int:
    """
    Whole months from `start` to `end`.

    No +1. Verified against the corpus' own arithmetic: "Aug 2016 → Feb 2021"
    is stated as 4 yrs 6 mos = 54, and (2021-2016)*12 + (2-8) = 54.
    """
    return (end.year - start.year) * 12 + (end.month - start.month)


@dataclass
class Role:
    role_index: int
    company: str | None
    role_title: str
    start_date: date | None
    end_date: date | None
    is_current: bool
    duration_months_stated: float | None
    duration_months_derived: float | None


def parse_experience(text: str, observed_at: date | None) -> list[Role]:
    """
    Split one profile's `experience` blob into dated roles.

    The scrape's layout is strict enough to walk directly:

        Company Name
        ↳ Role Title
        MMM YYYY → (MMM YYYY | Now) (N yrs N mos)
        optional free-text description, any number of lines

    So the company is always the line immediately above a "↳", and the date
    line — when there is one — is always immediately below it. Description
    text can never be mistaken for a company, because it is only ever
    encountered after the date line has been consumed.

    Roles with no parseable date line are still emitted, with null dates. They
    are a real part of the corpus (~39% of profiles have no dates at all) and
    silently dropping them would bias the panel toward people whose profiles
    happen to be well maintained.
    """
    lines = [ln.strip() for ln in text.split("\n")]
    roles: list[Role] = []
    i = 0
    idx = 0

    while i < len(lines):
        line = lines[i]
        if not line.startswith("↳"):
            i += 1
            continue

        role_title = line.lstrip("↳").strip()
        company = lines[i - 1] if i > 0 and lines[i - 1] else None

        start = end = None
        is_current = False
        stated = derived = None

        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        m = DATE_LINE.match(nxt)
        if m:
            i += 1  # consume the date line
            sm, sy = MONTHS.get(m.group("sm")), int(m.group("sy"))
            if sm:
                start = date(sy, sm, 1)
            if m.group("now"):
                is_current = True
                end = None
                # "Now" is only meaningful relative to when the page was read.
                if start and observed_at:
                    derived = months_between(start, observed_at)
            else:
                em, ey = MONTHS.get(m.group("em")), int(m.group("ey"))
                if em:
                    end = date(ey, em, 1)
                if start and end:
                    derived = months_between(start, end)
            stated = parse_stated_duration(m.group("dur"))

        roles.append(
            Role(
                role_index=idx,
                company=company,
                role_title=role_title,
                start_date=start,
                end_date=end,
                is_current=is_current,
                duration_months_stated=stated,
                duration_months_derived=derived,
            )
        )
        idx += 1
        i += 1

    return roles


# ─────────────────────────────────────────────────────────────────────────────
# Storage
# ─────────────────────────────────────────────────────────────────────────────

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS candidate_role_dates (
    profile_url             TEXT    NOT NULL,
    role_index              INTEGER NOT NULL,
    company                 TEXT,
    role_title              TEXT,
    start_date              DATE,
    end_date                DATE,
    is_current              BOOLEAN NOT NULL DEFAULT FALSE,
    duration_months_stated  REAL,
    duration_months_derived REAL,
    -- When "Now" was true. Every current-role duration is relative to this,
    -- and it is the observation time for point-in-time feature construction.
    observed_at             TIMESTAMP,
    extracted_at            TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (profile_url, role_index)
);
CREATE INDEX IF NOT EXISTS idx_crd_profile   ON candidate_role_dates(profile_url);
CREATE INDEX IF NOT EXISTS idx_crd_start     ON candidate_role_dates(start_date);
CREATE INDEX IF NOT EXISTS idx_crd_current   ON candidate_role_dates(is_current) WHERE is_current;
"""

INSERT_SQL = """
INSERT INTO candidate_role_dates
    (profile_url, role_index, company, role_title, start_date, end_date,
     is_current, duration_months_stated, duration_months_derived, observed_at)
VALUES %s
ON CONFLICT (profile_url, role_index) DO NOTHING
"""


def create_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(CREATE_SQL)
    conn.commit()
    print("candidate_role_dates ready (created if absent; never dropped).")


def extract(
    conn, limit: int | None, batch_size: int, resume: bool, time_machine_only: bool = False
) -> None:
    """
    Stream profiles, parse, insert.

    A named (server-side) cursor keeps the 6M-row source off the client heap.
    ON CONFLICT DO NOTHING makes reruns idempotent without deleting anything,
    so this can be stopped and restarted freely.
    """
    where = "experience IS NOT NULL AND experience <> ''"
    if time_machine_only:
        # The 12,826 profiles with a prior snapshot are the only observed
        # transitions in the corpus, so they are the ground-truth set every
        # honest model is evaluated against. A full pass over 6M profiles
        # reaches them in physical table order, which is to say eventually;
        # this pulls them forward.
        #
        # Run this INSTEAD of a full pass, never alongside one. ON CONFLICT
        # keeps the rows correct but does not stop two writers with
        # interleaving key ranges from deadlocking on the primary-key index,
        # which they do within seconds. --resume makes stopping the full pass
        # and restarting it afterwards free.
        where += """
          AND EXISTS (
            SELECT 1 FROM candidates_upgraded_time_machine t
            WHERE t.profile_url = candidates_upgraded.profile_url
          )"""
    if resume:
        # Skip profiles already extracted. Cheap enough via NOT EXISTS on the
        # PK index, and it makes an interrupted run resumable.
        where += """
          AND NOT EXISTS (
            SELECT 1 FROM candidate_role_dates d
            WHERE d.profile_url = candidates_upgraded.profile_url
          )"""

    sql = f"SELECT profile_url, experience, scraped_at FROM candidates_upgraded WHERE {where}"
    if limit:
        sql += f" LIMIT {limit}"

    read = conn.cursor(name="crd_stream", cursor_factory=psycopg2.extras.DictCursor)
    read.itersize = 5000
    read.execute(sql)

    # Writes go over their own connection. A server-side cursor is scoped to
    # its transaction, so committing a batch on the reading connection would
    # invalidate the cursor mid-stream ("named cursor isn't valid anymore").
    # WITH HOLD would also fix it, but it materialises the whole result set on
    # the server at commit — not something to ask of a 6M-row scan.
    write_conn = psycopg2.connect(**db_config())
    write = write_conn.cursor()
    buf: list[tuple] = []
    profiles = roles_out = dated = 0

    for row in read:
        observed = row["scraped_at"].date() if row["scraped_at"] else None
        try:
            parsed = parse_experience(row["experience"], observed)
        except Exception as exc:  # a single malformed profile must not stop the run
            print(f"  parse failed for {row['profile_url']}: {exc}")
            continue

        profiles += 1
        for r in parsed:
            roles_out += 1
            if r.start_date:
                dated += 1
            buf.append(
                (
                    row["profile_url"], r.role_index, r.company, r.role_title,
                    r.start_date, r.end_date, r.is_current,
                    r.duration_months_stated, r.duration_months_derived, row["scraped_at"],
                )
            )

        if len(buf) >= batch_size:
            psycopg2.extras.execute_values(write, INSERT_SQL, buf, page_size=1000)
            write_conn.commit()
            buf.clear()
            print(f"  {profiles:,} profiles | {roles_out:,} roles | {dated:,} dated", end="\r")

    if buf:
        psycopg2.extras.execute_values(write, INSERT_SQL, buf, page_size=1000)
        write_conn.commit()

    read.close()
    write.close()
    write_conn.close()
    pct = (100.0 * dated / roles_out) if roles_out else 0.0
    print(f"\nDone. {profiles:,} profiles, {roles_out:,} roles, {dated:,} dated ({pct:.1f}%).")


# ─────────────────────────────────────────────────────────────────────────────
# Verification
# ─────────────────────────────────────────────────────────────────────────────

VERIFY_SQL = """
WITH d AS (
    SELECT duration_months_stated  AS s,
           duration_months_derived AS r,
           is_current, start_date, end_date
    FROM candidate_role_dates
)
SELECT
    count(*)                                                        AS roles,
    count(*) FILTER (WHERE start_date IS NOT NULL)                  AS with_start,
    count(*) FILTER (WHERE is_current)                              AS current_roles,
    count(*) FILTER (WHERE s IS NOT NULL AND r IS NOT NULL)         AS comparable,
    count(*) FILTER (WHERE s IS NOT NULL AND r IS NOT NULL
                       AND abs(s - r) <= 1)                         AS agree_1mo,
    count(*) FILTER (WHERE s IS NOT NULL AND r IS NOT NULL
                       AND abs(s - r) > 3)                          AS disagree_3mo,
    count(*) FILTER (WHERE start_date > CURRENT_DATE)               AS future_start,
    count(*) FILTER (WHERE end_date < start_date)                   AS end_before_start
FROM d
"""


def verify(conn) -> int:
    """
    Cross-check the two independently parsed durations.

    Returns a process exit code so this can gate a pipeline: non-zero if the
    parse does not reproduce the corpus' own arithmetic.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(VERIFY_SQL)
        r = cur.fetchone()

    if not r or not r["roles"]:
        print("candidate_role_dates is empty — run the extractor first.")
        return 1

    comparable = r["comparable"] or 0
    agree = (100.0 * r["agree_1mo"] / comparable) if comparable else 0.0

    print(f"roles extracted     {r['roles']:,}")
    print(f"  with start date   {r['with_start']:,} ({100.0*r['with_start']/r['roles']:.1f}%)")
    print(f"  current roles     {r['current_roles']:,}")
    print(f"comparable pairs    {comparable:,}")
    print(f"  agree (±1 mo)     {r['agree_1mo']:,} ({agree:.2f}%)")
    print(f"  disagree (>3 mo)  {r['disagree_3mo']:,}")
    # Impossible dates are a property of the source, not of this parser.
    # LinkedIn accepts an end before a start (and then displays "1 mo"), so a
    # profile can genuinely say "Jun 2015 → Jan 2015". At the full-corpus run
    # there were 2 such rows in 23.2M, both of that shape.
    #
    # So the gate is a rate, not a zero. A handful of self-contradicting
    # profiles is the corpus being the corpus; a systematic parser fault would
    # show up as a percentage. The rows are left exactly as scraped — the table
    # should reflect the source — and the panel builder drops them with its
    # `duration_months >= 0` filter.
    impossible = (r["future_start"] or 0) + (r["end_before_start"] or 0)
    impossible_rate = 100.0 * impossible / r["roles"]
    print(f"impossible dates    {impossible:,} ({impossible_rate:.6f}%) "
          f"[future_start={r['future_start']:,} end_before_start={r['end_before_start']:,}]")

    ok = agree >= 99.9 and impossible_rate <= 0.01
    if ok:
        print("\nPASS — dates reproduce the corpus' own durations.")
    else:
        print("\nFAIL — parse disagrees with the stated durations; do not build on this.")
        if agree < 99.9:
            print(f"  agreement {agree:.2f}% is below 99.9% — the parser is wrong, not the data.")
        if impossible_rate > 0.01:
            print(f"  {impossible_rate:.4f}% impossible dates exceeds 0.01% — too many to be source typos.")
    return 0 if ok else 1


# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--create", action="store_true", help="create the table and exit")
    ap.add_argument("--verify", action="store_true", help="check the parse and exit")
    ap.add_argument("--limit", type=int, default=None, help="cap profiles read")
    ap.add_argument("--batch-size", type=int, default=20000, help="rows per insert")
    ap.add_argument("--no-resume", action="store_true", help="re-read already-extracted profiles")
    ap.add_argument(
        "--time-machine-only",
        action="store_true",
        help="restrict to profiles with a prior snapshot (the ground-truth set)",
    )
    args = ap.parse_args()

    conn = psycopg2.connect(**db_config())
    try:
        if args.verify:
            return verify(conn)
        create_table(conn)
        if args.create:
            return 0
        extract(
            conn,
            args.limit,
            args.batch_size,
            resume=not args.no_resume,
            time_machine_only=args.time_machine_only,
        )
        return verify(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
