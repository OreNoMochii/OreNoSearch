"""
Migrate the metaview_scraper database from this host to the SSD machine,
replacing tables that exist on both and leaving remote-only tables alone.

Why this is not a volume copy
-----------------------------
The obvious approach — rsync the PGDATA directory or `docker volume` copy — is
wrong here and would destroy data. A physical copy replaces the entire remote
cluster byte for byte, which means every table that exists only on the SSD
disappears. `candidate_role_embeddings` is exactly that: declared in
create_tables_v2.sql, absent from this host, and wanted for the reranker.

So this is a logical migration at table granularity. Three outcomes, decided
by comparing both catalogues:

    REPLACE   in both        -> local version wins, remote copy is replaced
    CREATE    local only     -> created on the remote
    KEEP      remote only    -> never touched, never dumped, never dropped

KEEP is the whole reason this script exists. It is printed explicitly in
--plan so the protected set is visible before anything runs.

How a table is replaced without a window of broken state
--------------------------------------------------------
pg_restore --clean --if-exists --single-transaction. The DROP, CREATE, COPY
and index builds all run inside one transaction, so a failure at any point —
including the network dropping mid-stream — rolls back and leaves the remote
table exactly as it was.

An earlier version renamed the table aside as a backup instead. That does not
work: ALTER TABLE ... RENAME moves the table and leaves its indexes, primary
key and sequences under their original names, so the restore collided with
"relation candidates_pkey already exists" on most tables. The transaction does
the same job with none of the bookkeeping.

Foreign keys
------------
Four, all pointing at candidate_profiles_parsed:

    candidate_extracted_skills, candidate_career_events,
    candidate_features_v2, candidates_data_science_use_v2

A rename carries its constraints along, so the backup copies would keep
referencing the parent and block the drop. The FKs are therefore captured
(pg_get_constraintdef), dropped before any swap, and recreated at the end.
If the run aborts midway they are recorded in the state file so --resume can
still restore them.

Safety properties
-----------------
  * --plan is the default. Nothing is transferred or dropped without --run.
  * Every destructive statement targets a name built from the run id, so two
    concurrent runs cannot collide.
  * Resumable: completed tables are recorded and skipped on --resume.
  * Verifies row counts per table afterwards and reports mismatches non-zero.
  * No passwords. SSH must already work with key auth; the script never
    prompts for or handles a credential.

Usage
-----
    python scripts/migrate_db_to_ssd.py --plan  --ssh-user USER
    python scripts/migrate_db_to_ssd.py --run   --ssh-user USER
    python scripts/migrate_db_to_ssd.py --resume --ssh-user USER
    python scripts/migrate_db_to_ssd.py --verify --ssh-user USER
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REMOTE_HOST_DEFAULT = "192.168.0.133"

# Local side: Postgres runs in a container on this host.
LOCAL_CONTAINER = "metaview_db"
DB_NAME = "metaview_scraper"
DB_USER = "scraper_user"

STATE_PATH = Path(__file__).resolve().parent / ".migrate_db_to_ssd.state.json"


class Ctx:
    def __init__(self, args):
        self.host = args.host
        self.ssh_user = args.ssh_user
        self.remote_container = args.remote_container
        # Docker Desktop on macOS puts its CLI on PATH from the login profile,
        # which a non-interactive `ssh host cmd` never sources. Bare "docker"
        # over SSH fails with "command not found"; the absolute path does not.
        self.remote_docker = args.remote_docker
        self.run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        self.dry = not (args.run or args.resume)


# ── shell helpers ───────────────────────────────────────────────────────────

def sh(cmd: list[str], check=True, capture=True) -> str:
    r = subprocess.run(cmd, capture_output=capture, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"command failed ({r.returncode}): {' '.join(cmd[:6])}…\n{r.stderr[:800]}")
    return (r.stdout or "").strip()


def local_psql(sql: str) -> str:
    return sh(["docker", "exec", LOCAL_CONTAINER, "psql", "-U", DB_USER,
               "-d", DB_NAME, "-tAc", sql])


def ssh_base(c: Ctx) -> list[str]:
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            f"{c.ssh_user}@{c.host}"]


def remote_psql(c: Ctx, sql: str) -> str:
    inner = (f"{c.remote_docker} exec -i {shlex.quote(c.remote_container)} "
             f"psql -U {DB_USER} -d {DB_NAME} -tAc {shlex.quote(sql)}")
    return sh(ssh_base(c) + [inner])


# ── inventory ───────────────────────────────────────────────────────────────

TABLES_SQL = """
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname NOT LIKE '%%__migbak_%%'
ORDER BY 1
"""

SIZES_SQL = """
SELECT c.relname, pg_total_relation_size(c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
"""

FK_SQL = """
SELECT conname, conrelid::regclass::text, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace
"""


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n}"


def inventory(c: Ctx) -> dict:
    local = [t for t in local_psql(TABLES_SQL).splitlines() if t]
    sizes = {}
    for line in local_psql(SIZES_SQL).splitlines():
        if "|" in line:
            k, v = line.split("|", 1)
            sizes[k] = int(v)

    try:
        remote = [t for t in remote_psql(c, TABLES_SQL).splitlines() if t]
    except RuntimeError as e:
        print("cannot reach the remote database.\n"
              f"  {str(e)[:300]}\n\n"
              "SSH must work with key auth before this can run:\n"
              f"  ssh-copy-id {c.ssh_user}@{c.host}\n"
              "This script never handles passwords.")
        sys.exit(2)

    ls, rs = set(local), set(remote)
    return {
        "replace": sorted(ls & rs),
        "create": sorted(ls - rs),
        "keep": sorted(rs - ls),
        "sizes": sizes,
    }


def print_plan(inv: dict) -> None:
    total = sum(inv["sizes"].get(t, 0) for t in inv["replace"] + inv["create"])
    print(f"\nREPLACE — on both, local version wins  ({len(inv['replace'])})")
    for t in inv["replace"]:
        print(f"    {t:<36} {human(inv['sizes'].get(t, 0)):>10}")
    print(f"\nCREATE — local only, new on remote  ({len(inv['create'])})")
    for t in inv["create"]:
        print(f"    {t:<36} {human(inv['sizes'].get(t, 0)):>10}")
    print(f"\nKEEP — remote only, NOT TOUCHED  ({len(inv['keep'])})")
    for t in inv["keep"]:
        print(f"    {t}")
    if not inv["keep"]:
        print("    (none — nothing exists only on the remote)")
    print(f"\non-disk total to transfer: {human(total)} "
          "(pg_dump -Fc compresses this substantially over the wire)")


# ── state ───────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"done": [], "fks": [], "run_id": None}


def save_state(s: dict) -> None:
    STATE_PATH.write_text(json.dumps(s, indent=2))


# ── transfer ────────────────────────────────────────────────────────────────

def drop_fks(c: Ctx, state: dict) -> None:
    rows = [l for l in remote_psql(c, FK_SQL).splitlines() if l.strip()]
    fks = []
    for line in rows:
        name, tbl, ddl = line.split("|", 2)
        fks.append({"name": name, "table": tbl, "ddl": ddl})
    if fks:
        state["fks"] = fks
        save_state(state)
        print(f"  dropping {len(fks)} foreign keys (recreated at the end)")
        for fk in fks:
            remote_psql(c, f'ALTER TABLE {fk["table"]} DROP CONSTRAINT IF EXISTS "{fk["name"]}"')


def restore_fks(c: Ctx, state: dict) -> None:
    """
    Check-then-add, not blind-add.

    A child table's own dump (pg_dump -t) includes that table's outbound FK
    definitions regardless of whether the referenced table was also in scope.
    So if the child transferred successfully earlier in the same run, its FK
    is already back — correctly, straight from the same authoritative DDL
    this function would otherwise try to add again. Blindly adding produced
    three "already exists" failures the first time this ran, on exactly the
    three children that had transferred cleanly; only the fourth, whose
    transfer had failed and rolled back, still needed it added here.

    Existence is checked directly against pg_constraint rather than trying to
    infer it from which tables happened to succeed — cheaper to ask than to
    reconstruct.
    """
    fks = state.get("fks") or []
    if not fks:
        return
    print(f"\nreconciling {len(fks)} foreign keys")
    ok = skipped = 0
    for fk in fks:
        exists = remote_psql(
            c, f"SELECT 1 FROM pg_constraint WHERE conname = '{fk['name']}'"
        ) == "1"
        if exists:
            skipped += 1
            continue
        try:
            remote_psql(c, f'ALTER TABLE {fk["table"]} ADD CONSTRAINT "{fk["name"]}" {fk["ddl"]}')
            ok += 1
        except RuntimeError as e:
            print(f"  FAILED {fk['name']}: {str(e)[:200]}")
    print(f"  {ok} added, {skipped} already present, "
          f"{len(fks) - ok - skipped} failed  (of {len(fks)})")


def transfer_table(c: Ctx, table: str, size: int) -> bool:
    """
    Stream one table across, atomically.

    The first version of this renamed the remote table aside as a backup,
    restored, then dropped the backup. That was wrong: ALTER TABLE ... RENAME
    renames the table and nothing else. Its indexes, primary key and owned
    sequences keep their original names, so pg_restore immediately collided
    with them —

        ERROR: relation "candidates_pkey" already exists

    — on ten of the first eighteen tables. Renaming every dependent object
    too would work and would be a lot of moving parts to get right.

    pg_restore --single-transaction already gives exactly the property the
    backup was trying to buy: the DROP from --clean, the CREATE, the COPY and
    the index builds all happen inside one transaction. If the network drops
    or the restore fails at any point, the whole thing rolls back and the
    remote keeps its original table untouched. No rename, no backup, no
    window.

    --if-exists so a CREATE-only table (absent on the remote) does not fail
    on a DROP of something that was never there.
    """
    dump = ["docker", "exec", LOCAL_CONTAINER, "pg_dump", "-U", DB_USER, "-d", DB_NAME,
            "-Fc", "--no-owner", "--no-acl", "-t", f"public.{table}"]
    restore_inner = (f"{c.remote_docker} exec -i {shlex.quote(c.remote_container)} "
                     f"pg_restore -U {DB_USER} -d {DB_NAME} --no-owner --no-acl "
                     f"--clean --if-exists --single-transaction")

    t0 = time.time()
    p1 = subprocess.Popen(dump, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p2 = subprocess.Popen(ssh_base(c) + [restore_inner], stdin=p1.stdout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p1.stdout.close()
    _, err2 = p2.communicate()
    p1.wait()
    dt = time.time() - t0

    if p1.returncode != 0 or p2.returncode != 0:
        msg = (err2 or b"").decode()[:400]
        print(f"    FAILED after {dt:.0f}s: {msg}")
        print("    remote table unchanged (transaction rolled back)")
        return False

    rate = (size / dt / 1024 / 1024) if dt > 0 else 0
    print(f"    ok in {dt:.0f}s ({rate:.0f} MB/s on-disk equivalent)")
    return True


EXT_SQL = "SELECT extname FROM pg_extension"

FUNC_SQL = """
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend d
       ON d.objid = p.oid AND d.deptype = 'e'   -- owned by an extension
WHERE n.nspname = 'public' AND d.objid IS NULL
"""


def preflight(c: Ctx) -> list[str]:
    """
    Check the schema-level prerequisites a per-table dump does NOT carry.

    `pg_dump -t table` emits the table, its indexes, its constraints and its
    triggers — but not the extensions those indexes need, and not the
    functions those triggers call. Both are cluster/schema scoped, so a
    single-table dump has no way to include them.

    This was learned twice, expensively. First a GIN index needed
    `gin_trgm_ops` and the restore died on a missing pg_trgm. Then a trigger
    referenced `trg_set_total_experience_months()` and died again — 64 minutes
    into a 12.6 GB transfer, both times, because the index build that trips it
    runs last. Checking up front costs one query per side.

    Extension-owned functions are excluded via pg_depend; otherwise installing
    pg_trgm makes 30 of its internal functions look like local definitions
    that need copying.
    """
    problems: list[str] = []

    local_ext = set(local_psql(EXT_SQL).split())
    remote_ext = set(remote_psql(c, EXT_SQL).split())
    if missing := local_ext - remote_ext:
        problems.append(
            f"extensions missing on remote: {', '.join(sorted(missing))}\n"
            f"    fix: CREATE EXTENSION IF NOT EXISTS <name>;"
        )

    local_fn = set(local_psql(FUNC_SQL).split())
    remote_fn = set(remote_psql(c, FUNC_SQL).split())
    if missing := local_fn - remote_fn:
        problems.append(
            f"functions missing on remote: {', '.join(sorted(missing))}\n"
            f"    fix: copy them with pg_get_functiondef() before transferring"
        )

    return problems


def parent_tables_of(state: dict) -> set[str]:
    """
    Tables referenced by a captured FK — restoring these needs the FK dropped
    again immediately beforehand, no matter what already ran.

    conrelid in the captured row is the CHILD; the parent only appears inside
    the constraint's own DDL ("FOREIGN KEY (...) REFERENCES parent(...)"), so
    it is pulled out of that text rather than tracked separately.
    """
    import re
    names = set()
    for fk in state.get("fks", []):
        m = re.search(r"REFERENCES\s+([\w.\"]+)", fk["ddl"])
        if m:
            names.add(m.group(1).strip('"').split(".")[-1])
    return names


def run(c: Ctx, resume: bool) -> int:
    inv = inventory(c)
    print_plan(inv)

    # Before moving 50 GB, not after.
    problems = preflight(c)
    if problems:
        print("\nPREFLIGHT FAILED — schema prerequisites are missing on the remote.")
        print("A per-table dump cannot carry these, and the restore will fail on")
        print("the last index of the largest table, an hour in.\n")
        for p in problems:
            print(f"  - {p}")
        print("\nResolve these, then re-run.")
        return 2
    print("\npreflight ok — extensions and functions match")

    state = load_state() if resume else {"done": [], "fks": [], "run_id": c.run_id}
    if resume and state.get("run_id"):
        c.run_id = state["run_id"]
        print(f"\nresuming run {c.run_id}: {len(state['done'])} tables already done")
    else:
        state["run_id"] = c.run_id
        save_state(state)

    todo = [t for t in inv["replace"] + inv["create"] if t not in state["done"]]
    # Largest last: a failure surfaces on a small table in seconds rather than
    # after half an hour of moving candidates_upgraded.
    todo.sort(key=lambda t: inv["sizes"].get(t, 0))

    print(f"\ntransferring {len(todo)} tables\n")
    if not state.get("fks"):
        drop_fks(c, state)

    parents = parent_tables_of(state)
    failed = []
    for i, t in enumerate(todo, 1):
        size = inv["sizes"].get(t, 0)
        print(f"  [{i}/{len(todo)}] {t}  ({human(size)})")
        if t in parents and state.get("fks"):
            # A child table restored earlier in this same run re-included its
            # own outbound FK (pg_dump -t dumps a table's own constraints,
            # FKs included, even when the referenced table is out of scope).
            # That silently reinstates the exact dependency drop_fks removed,
            # and blocks this parent's --clean from dropping its PK. Drop it
            # again, right here, unconditionally: DROP CONSTRAINT IF EXISTS
            # is a no-op when nothing reinstated it and a fix when something
            # did.
            for fk in state["fks"]:
                remote_psql(c, f'ALTER TABLE {fk["table"]} DROP CONSTRAINT IF EXISTS "{fk["name"]}"')
        if transfer_table(c, t, size):
            state["done"].append(t)
            save_state(state)
        else:
            failed.append(t)

    restore_fks(c, state)

    print(f"\ndone: {len(state['done'])} transferred, {len(failed)} failed")
    if failed:
        print("  failed: " + ", ".join(failed))
        print("  rerun with --resume to retry only those")
        return 1
    print(f"  KEEP set untouched: {', '.join(inv['keep']) or '(none)'}")
    return 0


def verify(c: Ctx) -> int:
    inv = inventory(c)
    print("\nrow-count comparison (local vs remote)\n")
    bad = 0
    for t in inv["replace"] + inv["create"]:
        try:
            l = int(local_psql(f'SELECT count(*) FROM public."{t}"'))
            r = int(remote_psql(c, f'SELECT count(*) FROM public."{t}"'))
        except (RuntimeError, ValueError) as e:
            print(f"  {t:<36} ERROR {str(e)[:80]}")
            bad += 1
            continue
        flag = "" if l == r else "   <-- MISMATCH"
        if l != r:
            bad += 1
        print(f"  {t:<36} {l:>12,} {r:>12,}{flag}")
    print(f"\n{'all match' if bad == 0 else f'{bad} problems'}")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=REMOTE_HOST_DEFAULT)
    ap.add_argument("--ssh-user", required=True)
    ap.add_argument("--remote-container", default=LOCAL_CONTAINER,
                    help="Postgres container name on the SSD machine")
    ap.add_argument("--remote-docker", default="/usr/local/bin/docker",
                    help="absolute path to docker on the remote (PATH is not "
                         "sourced for non-interactive ssh)")
    ap.add_argument("--run-id", default=None)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--plan", action="store_true", help="show the plan, transfer nothing (default)")
    g.add_argument("--run", action="store_true")
    g.add_argument("--resume", action="store_true")
    g.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    c = Ctx(args)
    if args.verify:
        return verify(c)
    if args.run or args.resume:
        return run(c, resume=args.resume)
    print_plan(inventory(c))
    print("\nthis was --plan; nothing was transferred. add --run to execute.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
