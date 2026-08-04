# Deployment

Deploying the stack to a fresh server. Database migration is handled separately
and deliberately — see [Database](#database) below.

## What runs

| Service           | Image                           | Exposed                      | Purpose                                |
| ----------------- | ------------------------------- | ---------------------------- | -------------------------------------- |
| `web`             | built from `packages/web`       | **yes**, `${WEB_PORT:-8080}` | nginx serving the SPA, proxying `/api` |
| `api`             | built from `packages/api`       | no                           | Express API + BullMQ worker            |
| `retrieval`       | built from `services/retrieval` | no                           | FastAPI retrieval pipeline             |
| `postgres`        | `postgres:15.8-alpine`          | no                           | golden database                        |
| `pgvector_search` | `pgvector/pgvector:pg15`        | no                           | embeddings                             |
| `meilisearch`     | `getmeili/meilisearch:v1.6`     | no                           | lexical search                         |
| `redis`           | `redis:7-alpine`                | no                           | durable campaign queue                 |

Only `web` publishes a host port. Everything else sits on an `internal`
network with no egress path.

## Prerequisites

- Docker Engine 24+ with Compose v2
- ~16 GB RAM (the retrieval service holds multi-GB models resident)
- Disk sized for your corpus — the reference dataset is 5.6M rows / ~9.4 GB
  before indexes

## 1. Secrets

Compose reads these from files, never from the environment or the image:

```bash
mkdir -p secrets && chmod 700 secrets

printf '%s' 'scraper_user'          > secrets/db_user.txt
printf '%s' "$(openssl rand -hex 32)" > secrets/db_password.txt
printf '%s' 'vector_user'          > secrets/vector_db_user.txt
printf '%s' "$(openssl rand -hex 32)" > secrets/vector_db_password.txt
printf '%s' "$(openssl rand -hex 32)" > secrets/meili_key.txt

chmod 600 secrets/*
```

`secrets/` is gitignored. Use `printf` rather than `echo` — a trailing newline
becomes part of the password.

## 2. Environment

Copy the template and fill it in:

```bash
cp .env.example .env
chmod 600 .env
```

Required in production, enforced at startup by `packages/api/src/config`:

| Variable                                                                   | Notes                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `DB_NAME`, `VECTOR_DB_NAME`                                                | database names                                                        |
| `ALLOWED_ORIGINS`                                                          | comma-separated; **must not contain `localhost`**                     |
| `API_USER`, `API_PASS`                                                     | `API_PASS` must be ≥16 chars and is rejected if it is a known default |
| `OPENAI_API_KEY`                                                           | screening provider                                                    |
| `GOOGLE_APPLICATION_CREDENTIALS`, `GMAIL_ADDRESS`, `GDRIVE_ROOT_FOLDER_ID` | outreach                                                              |
| `NVIDIA_API_KEY`                                                           | optional, only for `nvidia:` models                                   |

The API **refuses to start** on invalid configuration and prints every problem
at once, rather than failing later at first use.

## 3. Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Both Node images build from the **repository root** — this is an npm workspace,
so the lockfile and hoisted `node_modules` live there. Compose handles this;
if building by hand:

```bash
docker build -f packages/api/Dockerfile -t metaview-api .
docker build -f packages/web/Dockerfile -t metaview-web .
```

The web build **fails deliberately** if a Meilisearch key is ever found in the
production bundle, so a leaking image cannot be produced at all.

## 4. Verify

```bash
curl -f http://localhost:8080/healthz                      # nginx
docker compose -f docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>r.text()).then(console.log)"
```

`/readyz` returns `{"status":"ready"}` only once the database pool answers, so
it is the correct probe for a load balancer. `/healthz` is liveness only.

Expected in the API log at boot:

```
server_started · redis_ready · location_cache_warmed
```

`location_cache_warmed` takes ~25s on a 5.6M-row table and runs in the
background. Until it completes the first `/api/locations` call is slow; it does
not delay readiness.

## Database

**Nothing in this stack migrates an existing database.**

The `docker-entrypoint-initdb.d` mount applies only on the _first_
initialisation of an empty volume. Pointing the stack at an existing database
runs no DDL. `initDb()` additionally requires `ALLOW_SCHEMA_INIT=1`, so a
scrape can never alter the schema as a side effect.

To apply index migrations to a live database, do it deliberately:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" \
  < packages/scraper/migrations/003_search_indexes_only.sql
```

`003` is index-only and uses `CREATE INDEX CONCURRENTLY`, so the table stays
readable and writable. **Do not run `002`** — it adds a `STORED` generated
column, which rewrites the table under an `ACCESS EXCLUSIVE` lock; on 5.6M rows
that is minutes of downtime, and it is unnecessary.

If a `CONCURRENTLY` build is interrupted it leaves an INVALID index that the
planner ignores:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then: DROP INDEX CONCURRENTLY <name>;  and re-run
```

## Scaling

`api` runs 2 replicas. That is safe **only** because the queue is durable in
Redis and batch ids come from an atomic `INCR` — with the previous in-memory
queue each replica ran its own concurrency budget and double-sent outreach.

`retrieval` is pinned to 1 replica: each would load its own multi-GB copy of
the embedding and reranker models.

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Rolling: containers receive SIGTERM, stop accepting new work, finish in-flight
jobs, then close the queue, Redis and the database pool in that order. Without
that ordering a deploy could kill a campaign after it had written to Sheets but
before outreach history was recorded, causing the next run to re-send.

## TLS

The stack terminates plain HTTP on `${WEB_PORT}`. Put a reverse proxy or
ingress in front for TLS. The certificates under `certs/` are dev-only,
self-signed, and are not required by any build.

## Troubleshooting

| Symptom                                      | Cause                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| API exits immediately, prints a config list  | Invalid `.env`; every problem is listed at once                                     |
| `503` from `/api/outreach`                   | Redis unreachable. The API degrades rather than crashing; check the `redis` service |
| `/api/queue-status` returns `degraded: true` | Same                                                                                |
| Search errors mentioning a missing column    | Migration not applied — see [Database](#database)                                   |
| Web build fails on the key check             | A Meilisearch key reached the bundle; it must be server-side only                   |
