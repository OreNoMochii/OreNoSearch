# Handoff — state and next steps

Written at commit `161f53b`. Update or delete this file as items are closed.

## Current state

| Check                     | Result                                           |
| ------------------------- | ------------------------------------------------ |
| Branch                    | `main`, 0 uncommitted files                      |
| scraper / api typecheck   | clean                                            |
| web build                 | clean                                            |
| api tests                 | 84 passing, no infrastructure required           |
| api lint                  | 0 errors, 1 warning                              |
| web lint                  | 0 errors, 0 warnings                             |
| API images                | `packages/api` and `packages/web` both build     |
| `docker-compose.prod.yml` | validates, 7 services                            |
| `metaview_db`             | 17 tables, 5,661,466 rows — unchanged throughout |

Migration `003_search_indexes_only.sql` **has been applied**. It created
`idx_cu_total_exp_months` plus trigram indexes on `location`,
`current_company` and `latest_role`, installed `pg_trgm`, and replaced
`calculate_total_experience_months`. No table was altered. `002` is marked
`SUPERSEDED — DO NOT RUN` (it adds a `STORED` generated column, which rewrites
a 9.4 GB table under an `ACCESS EXCLUSIVE` lock).

## What needs doing, highest value first

### 1. ~~Correct the README~~ — DONE

This is first because it is the document a new deployer trusts, and three of
its claims are false:

| Claim                                                              | Reality                                  |
| ------------------------------------------------------------------ | ---------------------------------------- |
| "responsive CSS Grid layout without inline styles"                 | 103 inline styles in `App.tsx`           |
| "injected dependencies rather than global singletons"              | 4 module-level singletons remain         |
| references `machine_learning/retrieval_service/setup_pgvector.sql` | that path moved to `services/retrieval/` |

`DEPLOYMENT.md` is accurate; the README predates several restructures.

### 2. ~~Trigram index~~ — RESOLVED

Measured rather than assumed. The indexes work correctly; the earlier reading
was wrong because it tested only one non-selective predicate.

| Predicate                            | Rows matched    | Planner choice                                               |
| ------------------------------------ | --------------- | ------------------------------------------------------------ |
| `location ILIKE '%Tokyo%'`           | 584,802 (10.3%) | seq scan — **correct**, index cannot win at that selectivity |
| `current_company ILIKE '%Rakuten%'`  | 6,993 (0.12%)   | Bitmap Index Scan                                            |
| `latest_role ILIKE '%Neurosurgeon%'` | 85              | Bitmap Index Scan                                            |

On a selective predicate the index gives **2,866 ms -> 10 ms (285x)**.

`idx_cu_company_trgm` was dropped after measurement: the application only uses
`current_company NOT ILIKE`, a negated match that can never use an index. Its
2 recorded scans were manual verification queries. Reclaimed 266 MB plus write
amplification. Migration 003 documents why it is not recreated.

Retained and confirmed used: `idx_cu_location_trgm` (20 scans),
`idx_cu_total_exp_months` (7), `idx_cu_latest_role_trgm` (1, serves the
`currentRoleKeywords` filter).

### 3. Finish the UI consolidation — PARTIAL

`LocationPicker` extracted (236 lines, 19 inline styles). Remaining:

- **84 inline styles** in `App.tsx` (was 218, then 103)
- `App.tsx` is 1,308 lines (was 1,652)
- Still inline: the boolean query builder (~36 styles), the actions/results
  region (~25), and the outreach modal body (~38)
- `Field`, `controls` and `InfoTooltip` remain used only by `OutreachForm`

**How to verify safely.** There is no visual regression test, so use a browser:

```bash
mv certs /tmp/certs_stash          # devCerts -> undefined, serves plain HTTP
cd packages/web && npm run build && npx vite preview --port 4173 --host 127.0.0.1
# capture, refactor, capture again, compare
mv /tmp/certs_stash certs          # restore
```

`vite preview` skips the dev-only basic-auth and IP-allowlist middleware, so a
browser can reach it. **Capture screenshots twice** — the panel uses a
framer-motion fade-in, and a single early capture looks like a blank page.

### 4. ~~Extend test coverage~~ — DONE

**119 tests total**: 84 api unit, 20 web unit, 15 api integration.

The integration suite runs against real Postgres and Redis and skips itself
unless `RUN_INTEGRATION=1`, so CI without infrastructure stays green. It is
read-only — it never enqueues a campaign, sends email or writes candidate data.

```bash
npm run test:integration --workspace @metaview/api
```

Still uncovered: the retrieval service, which is the ML pipeline and excluded
from testing by instruction. `ruff` is not installed locally, so the Python
lint gate has only ever run in CI.

### 5. Deferred by decision

- **Database migration to another server** — deliberately out of scope. See the
  Database section of `DEPLOYMENT.md`.
- **ML pipeline work** — Advanced Pipeline, Company Intel, Hybrid engine and
  the tree threshold are work in progress and excluded from testing by
  instruction.
- **Credential rotation** — declined; the repo was private with a single user.
  The old history is gone but `.env`, `token.json` and `client_secret.json`
  values were valid at the time of the wipe.

## Landmines — read before changing these

**`initDb()` is gated behind `ALLOW_SCHEMA_INIT=1`** in both
`packages/api/src/repositories/postgres_repo.ts` and
`packages/scraper/database.ts`. It issues `CREATE TABLE` / `ALTER TABLE` /
`CREATE OR REPLACE FUNCTION` against the golden database and is called from
three scraper entrypoints. Do not remove the guard.

**The SQL in `initDb()` must stay byte-identical to migration 003.** It builds
`idx_cu_total_exp_months` on that exact function expression; drift silently
invalidates the index. Note the doubled backslashes: the SQL lives in a JS
template literal where `\d` and `\s` are not valid escapes, so JavaScript drops
the backslash and Postgres would receive `(?i)(d+)s*yr` — matching literal `d`
characters instead of digits.

**`experience_months` is not the same as `calculate_total_experience_months`.**
The column uses `substring()`, which captures only the first match, so it
measures the first-listed role's duration. The function sums every role. They
agreed on 17% of a 500-row sample. Do not swap one for the other.

**The search `total` is capped at 10,000** and returns `totalIsCapped`. Never
use it as a fetch limit — that bug silently truncated campaigns to 1,000
candidates.

**`api` may run >1 replica only because the queue is durable in Redis and batch
ids come from an atomic `INCR`.** `retrieval` must stay at 1 replica: each
loads its own multi-GB copy of the embedding and reranker models.

## Defect log

B1–B24 closed in earlier sessions. Found and closed most recently:

| ID  | Severity | Defect                                                                                                               |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| B25 | CRIT     | ioredis had no `error` listener — an unreachable Redis killed the process                                            |
| B26 | HIGH     | BullMQ worker/queue never closed; SIGTERM killed jobs mid-write                                                      |
| B27 | HIGH     | In-memory `batchId` collided with the durable queue after restart                                                    |
| B28 | MED      | Location cache never invalidated                                                                                     |
| B29 | HIGH     | `usePipeline` never mapped to `engine: 'pipeline'` — toggle was a no-op                                              |
| B30 | HIGH     | Company intel dropped entirely; `getCompanyIntelBatch` had zero call sites                                           |
| B31 | HIGH     | `calculate_total_experience_months` parsed phone numbers and ISBNs as durations; wrong on 4.32% of rows, threw on 30 |
| B32 | HIGH     | Search total capped at 1,000 and used as the outreach fetch limit                                                    |
| B33 | HIGH     | `tree_llm` mapped to a bare LLM adapter — the tree pre-filter never ran                                              |
| B34 | HIGH     | Tree adapter returned `PASS` for every candidate; the 0.5 threshold was gone                                         |
| B35 | MED      | Tree scorer called with `companyName: 'Internal'`, disabling same-company exclusion                                  |
| B36 | MED      | `vite.config.ts` read dev TLS certs at config load, breaking `vite build`                                            |

B29, B30, B33, B34 and B35 are ML-pipeline related and were fixed, but that
area is WIP — treat those fixes as unverified against real workloads.
