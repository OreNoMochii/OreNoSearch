# syntax=docker/dockerfile:1.7

# ---- dependencies (production only) ---------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024"

# tini reaps zombies and forwards SIGTERM, without which the graceful-shutdown
# handler in main.ts never runs and in-flight campaigns are killed mid-write.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home appuser

WORKDIR /app
COPY --from=deps  --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appuser /app/dist         ./dist
COPY --chown=appuser:appuser package.json ./

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
