# syntax=docker/dockerfile:1
#
# ai-service — production image.
#
# ⚠ BUILD CONTEXT IS THE REPO ROOT, not this directory. pnpm-lock.yaml and
#   pnpm-workspace.yaml live at the root, so a service-scoped context cannot
#   produce a reproducible install. Build with:
#
#     docker build -f services/ai-service/Dockerfile -t edc-ai-service .
#
#   or, from the root docker-compose.yml:
#
#     build:
#       context: .
#       dockerfile: services/ai-service/Dockerfile
#
#   The root needs a `.dockerignore` containing at least `node_modules`,
#   `**/node_modules`, `**/dist`, `.git` — otherwise this context is enormous.
#
# ⚠ The `COPY <pkg>/package.json` list below must track `pnpm-workspace.yaml`.
#   pnpm validates `--frozen-lockfile` against every workspace manifest, so a
#   missing one fails the install with "lockfile is not up to date".
#
# Runtime deps: Postgres with the `vector` extension, and Redis. See
# `services/ai-service/.env.example` for the full env surface.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# --- build: install (incl. dev), compile TS -> dist, then prune to prod deps ---
FROM base AS build

# Manifests first so the install layer caches across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/backend/package.json apps/backend/
COPY packages/ai-client/package.json packages/ai-client/
COPY packages/identity-client/package.json packages/identity-client/
COPY packages/chat-engine/package.json packages/chat-engine/
COPY services/ai-service/package.json services/ai-service/

# `@edc/ai-service...` = the package plus its workspace dependencies.
RUN pnpm install --filter @edc/ai-service... --frozen-lockfile

COPY services/ai-service ./services/ai-service
RUN pnpm --filter @edc/ai-service build

# Prune dev dependencies in place. Keeps the pnpm symlink layout intact, which
# the runtime stage copies verbatim (see below).
RUN pnpm install --filter @edc/ai-service... --frozen-lockfile --prod

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# curl backs the container healthcheck below.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A pnpm install is a symlink farm: `services/ai-service/node_modules/<dep>` is
# a RELATIVE link into `/repo/node_modules/.pnpm/...`. Both trees must therefore
# land at their ORIGINAL absolute paths or every import breaks — hence the
# `/repo/...` targets and the `/repo/services/ai-service` workdir.
WORKDIR /repo/services/ai-service
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/services/ai-service/node_modules /repo/services/ai-service/node_modules
COPY --from=build /repo/services/ai-service/dist ./dist
COPY --from=build /repo/services/ai-service/drizzle ./drizzle
COPY --from=build /repo/services/ai-service/package.json ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

# Migrations run on every container start (idempotent — Drizzle skips applied
# ones), then the HTTP server + in-process BullMQ workers boot.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
