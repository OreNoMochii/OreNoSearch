# syntax=docker/dockerfile:1.7
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#   docker build -f packages/api/Dockerfile -t metaview-api .
#
# This is an npm workspace: the lockfile lives at the root and dependencies are
# hoisted into the root node_modules, so a build scoped to packages/api cannot
# resolve them. The previous version copied ./package-lock.json relative to this
# directory, which ceased to exist when the repo moved to workspaces.

# ---- dependencies (production only) ----------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
# Manifests only, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/api/package.json      packages/api/
COPY packages/web/package.json      packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @metaview/api --include-workspace-root

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/api/package.json      packages/api/
COPY packages/web/package.json      packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @metaview/api --include-workspace-root
COPY packages/api/tsconfig.json packages/api/
COPY packages/api/src           packages/api/src
RUN npx tsc -p packages/api/tsconfig.json

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024"

# tini reaps zombies and forwards SIGTERM. Without it the graceful-shutdown
# handler never runs, and a deploy kills in-flight campaigns after they have
# written to Sheets but before outreach history is recorded.
#
# python3 is required by the tree scorer, which the API invokes through
# utils/python_runner (spawn, no shell).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home appuser

WORKDIR /app
COPY --from=deps  --chown=appuser:appuser /repo/node_modules        ./node_modules
COPY --from=build --chown=appuser:appuser /repo/packages/api/dist   ./dist
COPY --chown=appuser:appuser packages/api/package.json ./

USER appuser
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
