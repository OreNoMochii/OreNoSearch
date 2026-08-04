# Handoff — state and next steps

Written at commit `9c9ca0b`. Update or delete this file as items are closed.

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

### 1. Correct the README — it currently misleads

This is first because it is the document a new deployer trusts, and three of
its claims are false:

| Claim                                                              | Reality                                  |
| ------------------------------------------------------------------ | ---------------------------------------- |
| "responsive CSS Grid layout without inline styles"                 | 103 inline styles in `App.tsx`           |
| "injected dependencies rather than global singletons"              | 4 module-level singletons remain         |
| references `machine_learning/retrieval_service/setup_pgvector.sql` | that path moved to `services/retrieval/` |

`DEPLOYMENT.md` is accurate; the README predates several restructures.

### 2. Trigram index is built but the planner ignores it

`location ILIKE '%Tokyo%'` still chooses a parallel sequential scan despite
`idx_cu_location_trgm` existing. Verify with:

```sql
EXPLAIN (ANALYZE) SELECT count(*) FROM candidates_upgraded WHERE location ILIKE '%Tokyo%';
```

Likely causes to check in order: the predicate matches too large a fraction of
5.6M rows for an index path to win; `gin_trgm_ops` needs `pg_trgm.similarity_threshold`
tuning; or `random_page_cost` is defaulted for spinning disks. If the planner
is right that a seq scan is cheaper at this selectivity, drop the three trigram
indexes — they cost 667 MB combined and buy nothing.

Related, measured honestly: `idx_cu_total_exp_months` **is** used (Bitmap Index
Scan) but only improved a broad-range query from 209s to 154s (26%). The
`Recheck Cond` re-evaluates the function per heap row. It will help selective
ranges far more than broad ones.

### 3. Finish the UI consolidation (§4 remainder)

Every WCAG-blocking defect is closed. What remains is stylistic:

- **103 inline styles** in `App.tsx` (down from 218). These are layout
  scaffolding in the search panel and results list.
- **`Field.tsx`, `controls.tsx`, `InfoTooltip.tsx` are built, styled and
  unused** — only `OutreachForm` routes through them. The search panel's inputs
  still use bare markup.
- `App.tsx` is 1,535 lines. Extracting `LocationPicker`,
  `BooleanQueryBuilder`, `SearchFilters` and `ResultsList` is the path to ~200.

Do this with the app running and visually compared — there is no visual
regression test, so a blind refactor risks silent layout breakage.

### 4. Extend test coverage

84 tests cover pure logic only. Not covered:

- **Integration**: no test starts the API against a real Postgres/Redis. The
  highest-value addition is a smoke test hitting `/api/search` and
  `/api/locations` against a throwaway container.
- **Frontend**: zero tests. `searchClient.ts`'s `combineSets` boolean logic is
  pure and worth testing.
- **Python**: 2 test files exist in `machine_learning/`; the retrieval service
  has none. `ruff` is not installed locally, so the lint gate has only ever run
  in CI.

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
