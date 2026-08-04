# syntax=docker/dockerfile:1.7
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker build -f packages/web/Dockerfile -t metaview-web .
#
# Serves the built SPA through nginx and proxies /api to the API container, so
# the browser makes same-origin requests. That matters beyond convenience: the
# Meilisearch key never reaches the client (B2), and search traffic is proxied
# through the authenticated API rather than hitting the search engine directly.

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/api/package.json      packages/api/
COPY packages/web/package.json      packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @metaview/web --include-workspace-root

COPY packages/web/ packages/web/
# The build must not require a Meilisearch key: none is embedded any more.
RUN npm run build --workspace @metaview/web

# Fail the build if a key ever reappears in the bundle. This is the same guard
# CI runs, enforced here so a bad image can never be produced at all.
RUN if grep -rEl "(MEILI_MASTER_KEY|masterKey|apiKey[[:space:]]*:[[:space:]]*['\"][A-Za-z0-9@%!*^]{20,})" \
      packages/web/dist/assets/*.js 2>/dev/null; then \
      echo "ERROR: a Meilisearch key is present in the production bundle"; exit 1; \
    fi

# ---- runtime ----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

RUN rm /etc/nginx/conf.d/default.conf
COPY packages/web/nginx.conf /etc/nginx/conf.d/app.conf
COPY --from=build /repo/packages/web/dist /usr/share/nginx/html

# nginx:alpine already runs workers unprivileged; drop the master to non-root
# too by handing over the paths it needs to write.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
