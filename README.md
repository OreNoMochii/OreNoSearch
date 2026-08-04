# Metaview Scraper & Outreach Engine

Candidate sourcing, attrition-risk scoring and automated outreach over a
~5.6M-row candidate corpus.

For deploying to a server, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.
For current work in progress and known gaps, see **[HANDOFF.md](HANDOFF.md)**.

## Layout

npm workspaces monorepo. The lockfile and hoisted `node_modules` live at the
root, so builds and installs run from there.

| Path                 | What it is                                                      |
| -------------------- | --------------------------------------------------------------- |
| `packages/api`       | Express API and BullMQ worker (`@metaview/api`)                 |
| `packages/web`       | React 19 + Vite SPA (`@metaview/web`)                           |
| `packages/scraper`   | Playwright extraction engine, workers, SQL migrations           |
| `services/retrieval` | FastAPI 4-stage retrieval pipeline                              |
| `machine_learning`   | Attrition-risk models (LightGBM, CoxPH, LSTM) and training code |

### API architecture

Ports-and-adapters. `services/OutreachOrchestrator` depends only on the
interfaces in `domain/ports.ts` — screening strategies, risk scorer, candidate
sink, notifier, history repository, progress reporter. Concrete adapters are
wired in `src/composition.ts`, which is the only module that knows both sides.

Screening engines are separate `ScreeningStrategy` implementations
(`LlmScreeningAdapter`, `TreeScreeningAdapter`, `PipelineScreeningAdapter`,
`HybridScreeningAdapter`) selected by key, rather than branching inside the
orchestrator.

> **Partially applied.** The orchestrator takes constructor injection, but four
> module-level singletons remain (`emailService`, `screeningAgent`,
> `googleSheetsService`, `retrievalPipelineService`) and adapters still reach
> for them directly. Converting those is outstanding work.

### Web architecture

Vite 8 (rolldown) SPA. Accessible primitives live in `src/components`: a native
`<dialog>` modal with focus trap and Escape handling, `ExplainableAction` for
keyboard-reachable action explanations, `Field` + `controls` for labelled form
inputs, and a memoised `CandidateCard`. Design tokens with a light/dark
contract and `prefers-reduced-motion` handling are in `src/styles/tokens.css`.

> **Partially applied.** `App.tsx` is ~1,500 lines and still carries ~103 inline
> style objects, down from 218. `Field`, `controls` and `InfoTooltip` are built
> and styled but currently used only by `OutreachForm`. Extracting the search
> panel into components is outstanding work.

## Local development

### Prerequisites

- Node.js 22+
- Python 3.11+
- Docker with Compose v2

### 1. Infrastructure

```bash
docker compose up -d
```

| Container            | Port | Purpose                                        |
| -------------------- | ---- | ---------------------------------------------- |
| `metaview_db`        | 5433 | Golden database (candidates, outreach history) |
| `metaview_vectordb`  | 5434 | pgvector embeddings                            |
| `meilisearch`        | 7705 | Lexical search                                 |
| `metaview_redis`     | 6379 | Durable campaign queue                         |
| `pgadmin4_container` | 5050 | Admin UI, local only                           |

### 2. Configuration

```bash
cp .env.example .env
```

The API validates its entire environment at startup and **refuses to boot** on
invalid configuration, printing every problem at once. `API_PASS` is rejected
if it matches a known default.

### 3. Install and run

Install once from the repository root — this is a workspace:

```bash
npm ci
npm run api    # API on :3001
npm run web    # SPA on :5173
```

Other root scripts:

| Script                                | Purpose                               |
| ------------------------------------- | ------------------------------------- |
| `npm run scrape`                      | Playwright extraction engine          |
| `npm run sync-meili`                  | Sync Postgres → Meilisearch           |
| `npm run backfill-roles`              | Update candidate role histories       |
| `npm run retrieval-service`           | FastAPI pipeline on :8765             |
| `npm run typecheck` / `lint` / `test` | Across all workspaces                 |
| `npm run migrate`                     | Apply index migration 003 (see below) |

## Testing

```bash
npm run test --workspace @metaview/api          # 84 tests
npm run test:coverage --workspace @metaview/api # with thresholds
```

The suites cover pure logic and process-level behaviour, so they need no
Postgres, Redis, Meilisearch, Google credentials or LLM provider. Each is a
regression test for a specific defect: tsquery operator injection, SMTP header
injection, the rate-limiter race, shell injection in the Python runner, and
request/response schema validation.

> **Scope.** There are no integration tests, no frontend tests, and no tests
> for the retrieval service. The ML pipeline is work in progress and
> deliberately excluded.

## Database

Migrations live in `packages/scraper/migrations/`.

```bash
npm run migrate          # applies 003_search_indexes_only.sql
npm run migrate:status   # lists indexes on candidates_upgraded
```

`003` is **index-only**: it creates indexes with `CONCURRENTLY` (the table
stays readable and writable), installs `pg_trgm`, replaces one function and
runs `ANALYZE`. It contains no `DROP`, `DELETE`, `TRUNCATE` or `ALTER TABLE`.

**Do not run `002`.** It adds a `STORED` generated column, which rewrites the
whole table under an `ACCESS EXCLUSIVE` lock — minutes of downtime on a 9.4 GB
table, and unnecessary.

`initDb()` issues DDL and is gated behind `ALLOW_SCHEMA_INIT=1`, so a scrape
cannot alter the schema as a side effect.

## Retrieval pipeline

```
JD text
  ▼ Stage 1  LLM query expansion (skills, synonyms, adjacent roles)
  ▼ Stage 2  Hybrid retrieval — Meilisearch lexical + pgvector ANN, RRF fused
  ▼ Stage 3  Cross-encoder rerank (BAAI/bge-reranker-v2-m3)
  ▼ Stage 4  LLM audit — PASS/FAIL with evidence quotes
```

Setup:

```bash
cd services/retrieval
pip install -r requirements.txt

docker exec -i metaview_vectordb psql -U vector_user -d metaview_vectors \
  < services/retrieval/setup_pgvector.sql

python3 ingest_embeddings.py --batch-size 64 --resume
python3 -m uvicorn main:app --host 0.0.0.0 --port 8765
```

> **Work in progress.** The Advanced Pipeline, Company Intel, Hybrid engine and
> tree-score threshold have had defects fixed recently but are not verified
> against real workloads.

## Security

- No credentials in the repository. `.env`, `token.json`, `client_secret.json`
  and TLS material are gitignored; `gitleaks` runs in CI and pre-commit.
- The browser holds **no Meilisearch key**. Search is proxied through the
  authenticated `/api/meili/search` against an index allowlist, and the web
  image build fails if a key is ever detected in the bundle.
- Python helpers are invoked with `spawn` and an argv array, never a shell.
- Recipient lists are rejected outright if they contain CR or LF, closing SMTP
  header injection.
- Basic auth uses a constant-time comparison and runs before body parsing.

## CI

`.github/workflows/ci.yml` on push and PR to `main`:

1. `gitleaks` secret scan over full history
2. Node: typecheck, ESLint, Prettier, Vitest with coverage thresholds
3. Python: `ruff`, `ruff format`, `mypy`, `compileall`
4. Container builds with `trivy` scanning, plus a guard asserting no
   Meilisearch key reaches the web bundle

Pre-commit hooks:

```bash
pip install pre-commit && pre-commit install
```

## License

ISC
