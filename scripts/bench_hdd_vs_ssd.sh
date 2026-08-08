#!/usr/bin/env bash
#
# Compare query latency between the HDD database on this host and the SSD
# database on the other machine.
#
# Method
# ------
# Two numbers per query, because they answer different questions:
#
#   server_ms   Postgres's own execution time, from EXPLAIN ANALYZE. Excludes
#               network and client overhead entirely, so it isolates the thing
#               being tested — spinning disk versus SSD.
#   wall_ms     round-trip as a client experiences it. For the remote this
#               includes LAN latency, which is what the API will actually pay.
#
# An earlier version of this script ran `docker run --rm postgres:15 psql` once
# per query. Container startup is 200-500ms — larger than several of the
# queries being measured — so it would have reported the SSD as slower than the
# HDD purely from harness overhead. Everything now runs inside ONE psql session
# per side, so that cost is paid once and not attributed to any query.
#
# Caching also matters: Postgres holds hot pages in shared buffers and the OS
# caches more, so a repeated query is answered from memory and measures
# nothing about the disk. Each query runs REPEAT times; first and best are both
# reported. First is closer to a user hitting a cold filter, best is the warm
# ceiling.

set -uo pipefail

REPEAT=${REPEAT:-3}
REMOTE_HOST=192.168.0.133
OUT=/tmp/bench_$$

# name|sql — the paths the app actually uses, not synthetic scans.
QUERIES=(
"count_candidates|SELECT count(*) FROM candidates_upgraded"
"trigram_search|SELECT count(*) FROM candidates_upgraded WHERE latest_role ILIKE '%sales manager%'"
"location_filter|SELECT count(*) FROM candidates_upgraded WHERE location ILIKE '%Tokyo%'"
"join_profiles|SELECT count(*) FROM candidates_upgraded u JOIN candidate_profiles_parsed p USING (profile_url)"
"spell_aggregate|SELECT market, count(*), round(avg(duration_months)::numeric,1) FROM flight_risk_spells WHERE market='Japan' GROUP BY market"
"role_dates_scan|SELECT count(*) FROM candidate_role_dates WHERE start_date >= DATE '2020-01-01'"
)

build_sql() {
  echo "\\timing on"
  for entry in "${QUERIES[@]}"; do
    local name="${entry%%|*}" sql="${entry#*|}"
    for i in $(seq 1 "$REPEAT"); do
      echo "\\echo MARK ${name} run${i}"
      echo "EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON) ${sql};"
    done
  done
}

build_sql > "$OUT.sql"

# Reachability first. Without this, psql against a sleeping host blocks on the
# TCP connect for minutes with no output — the first run of this script spent
# over ten minutes mostly waiting on a Mac mini that had gone to sleep, and
# reported an empty table rather than saying so.
REMOTE_UP=0
if ping -c 1 -W 2000 "$REMOTE_HOST" >/dev/null 2>&1; then
  REMOTE_UP=1
else
  echo "WARNING ${REMOTE_HOST} is unreachable — running the HDD baseline only."
  echo "        Wake it and re-run to get the comparison."
fi

echo "running ${#QUERIES[@]} queries x ${REPEAT} against $([ $REMOTE_UP = 1 ] && echo 'both databases' || echo 'the HDD only')…"

docker exec -i metaview_db psql -U scraper_user -d metaview_scraper < "$OUT.sql" > "$OUT.hdd" 2>&1

if [ "$REMOTE_UP" = 1 ]; then
  docker run --rm -i -e PGPASSWORD=scraper_password postgres:15 \
    psql -h "$REMOTE_HOST" -p 5433 -U scraper_user \
    -d metaview_scraper -v ON_ERROR_STOP=0 < "$OUT.sql" > "$OUT.ssd" 2>&1
else
  : > "$OUT.ssd"
fi

# Pull "Execution Time: N ms" (server-side) and "Time: N ms" (wall) per mark.
parse() {  # $1 = file, $2 = which  (exec|wall)
  python3 - "$1" "$2" <<'PY'
import re, sys, collections
path, which = sys.argv[1], sys.argv[2]
cur = None
vals = collections.defaultdict(list)
for line in open(path, errors='replace'):
    m = re.match(r'MARK (\S+) run\d+', line.strip())
    if m:
        cur = m.group(1); continue
    if cur is None: continue
    if which == 'exec':
        m = re.search(r'Execution Time: ([\d.]+) ms', line)
    else:
        m = re.match(r'Time: ([\d.]+) ms', line.strip())
    if m:
        vals[cur].append(float(m.group(1)))
for k, v in vals.items():
    print(f"{k}\t{v[0]:.1f}\t{min(v):.1f}")
PY
}

parse "$OUT.hdd" exec > "$OUT.hdd_exec"
parse "$OUT.ssd" exec > "$OUT.ssd_exec"
parse "$OUT.hdd" wall > "$OUT.hdd_wall"
parse "$OUT.ssd" wall > "$OUT.ssd_wall"

python3 - "$OUT" <<'PY'
import sys
base = sys.argv[1]
def load(p):
    d = {}
    try:
        for line in open(p):
            k, first, best = line.split('\t')
            d[k] = (float(first), float(best))
    except FileNotFoundError:
        pass
    return d

he, se = load(base+'.hdd_exec'), load(base+'.ssd_exec')
hw, sw = load(base+'.hdd_wall'), load(base+'.ssd_wall')

print()
print(f"{'query':<18}{'HDD server':>12}{'SSD server':>12}{'speedup':>10}"
      f"{'HDD wall':>11}{'SSD wall':>11}")
print('-'*74)
tot_h = tot_s = 0.0
for k in he:
    if k not in se:
        # Remote unavailable: still show the HDD baseline rather than nothing.
        h = he[k][1]; tot_h += h
        hwv = f"{hw.get(k,(0,0))[1]:.0f}ms" if k in hw else "-"
        print(f"{k:<18}{h:>10.1f}ms{'-':>12}{'-':>10}{hwv:>11}{'-':>11}")
        continue
    h, s = he[k][1], se[k][1]          # best-of server time
    tot_h += h; tot_s += s
    sp = f"{h/s:.2f}x" if s > 0 else "-"
    hwv = f"{hw.get(k,(0,0))[1]:.0f}ms" if k in hw else "-"
    swv = f"{sw.get(k,(0,0))[1]:.0f}ms" if k in sw else "-"
    print(f"{k:<18}{h:>10.1f}ms{s:>10.1f}ms{sp:>10}{hwv:>11}{swv:>11}")
print('-'*74)
if tot_s > 0:
    print(f"{'TOTAL':<18}{tot_h:>10.1f}ms{tot_s:>10.1f}ms{tot_h/tot_s:>9.2f}x")
print()
print("server = Postgres execution time, the disk comparison proper.")
print("wall   = client round-trip; SSD includes LAN latency the API will pay.")
PY

if [ -s "$OUT.hdd_exec" ]; then
  rm -f "$OUT".*
else
  echo "NOTE parsed no timings; raw psql output kept at ${OUT}.hdd / ${OUT}.ssd"
fi
