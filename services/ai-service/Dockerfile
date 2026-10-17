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
#
# ⚠ The node major on every stage here, in `Dockerfile.dev` and in `.nvmrc`
# must AGREE — `src/config/toolchain-pins.test.ts` fails the build on drift.
# Node 26 no longer bundles corepack, so pnpm is installed with npm, pinned to
# the root package.json's `packageManager`.

FROM node:26-bookworm-slim AS base
RUN npm install -g pnpm@9.15.4
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

# `pnpm deploy --prod` writes a self-contained copy of the PRODUCTION deps to
# /out (its own `.pnpm` store, no links into /repo). It replaced an in-place
# `pnpm install --prod`, which unlinked the dev deps but left them in the root
# `.pnpm` store: measured 3.22 GB copied into the old image — promptfoo's
# onnxruntime, codex and claude-agent-sdk binaries, typescript, vite.
# The musl builds of native optional deps can never load on this glibc image.
RUN pnpm --filter @edc/ai-service deploy --prod /out \
  && find /out/node_modules/.pnpm -maxdepth 1 -name '*musl*' -exec rm -rf {} +

# --- runtime ---
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production
# curl backs the container healthcheck below.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# /out/node_modules is self-contained (its symlinks point inside itself), so
# only that one tree comes across. The `/repo/services/ai-service` workdir is
# kept so paths in logs and ops docs stay the same.
WORKDIR /repo/services/ai-service
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/services/ai-service/dist ./dist
COPY --from=build /repo/services/ai-service/drizzle ./drizzle
COPY --from=build /repo/services/ai-service/package.json ./
# The holding page served at `GET /` (src/routes/holding.ts reads it at boot).
COPY --from=build /repo/services/ai-service/static ./static
# The boot SCHEMA GATE. Plain .mjs importing only node:* and `postgres` (a
# runtime dependency), so it needs no TypeScript and no dev deps. Read its
# header before changing this line — it is what stops a container booting
# against a database drizzle's ledger wrongly reports as up to date.
COPY --from=build /repo/services/ai-service/scripts/schema-gate.mjs ./scripts/schema-gate.mjs

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1


# ── STOP SIGNAL ─────────────────────────────────────────────────────────────
# Explicit, though SIGTERM is already Docker's default. Stating it here makes
# the contract visible at the one place someone reads before changing `CMD`:
# the signal that reaches PID 1 is the signal `src/index.ts` installs its
# cooperative-shutdown handler for. Change `CMD` to a wrapper that does not
# `exec`, and the signal stops reaching node — which is why the `CMD` below
# uses `exec node …` and not `npm run start`.
#
# 🔴 THE PLATFORM'S STOP GRACE MUST EXCEED `SHUTDOWN_GRACE_MS` (default 30s).
# On SIGTERM the workers stop taking new jobs, give the in-flight ones that
# window to finish, then abort the survivors so each settles as a named
# terminal job with its cost billed and its callback fired. Docker — and
# Coolify on top of it — waits only 10 SECONDS after SIGTERM and then SIGKILLs.
# At the default that kill lands 20s INTO the grace window, and every job still
# running dies at `status='running'` for the reaper to find later as
# `worker_lost`: exactly the outcome the grace window exists to prevent.
#
# ⚠ AN IMAGE CANNOT SET ITS OWN STOP TIMEOUT. There is no Dockerfile
# instruction for it — it belongs to whoever RUNS the container
# (`docker run --stop-timeout`, `stop_grace_period:` in a compose service, the
# platform's own setting). So this is a deploy-side change that has to be made
# per environment, or `SHUTDOWN_GRACE_MS` has to be lowered to fit inside 10s.
STOPSIGNAL SIGTERM

# Coolify health check can hit GET /health.
#
# Migrations run on every container start, WRAPPED BY THE SCHEMA GATE:
#
#   db:gate precheck  →  dist/db/migrate.js  →  db:gate stamp  →  the server
#
# 🔴 "idempotent — Drizzle skips applied ones" was the old comment here and it
# is the exact belief that lets drift through. MEASURED (drizzle-orm
# 0.38.4): drizzle compares only the NEWEST ledger row's created_at against each
# migration's journal `when` and never reads back the hash it stored, so a
# baseline edited in place is skipped and reported as success. The gate compares
# CONTENT — migration bytes, and the live column list — and refuses the boot
# when either has moved. See scripts/schema-gate.mjs.
#
# ⚠ AN APPENDED MIGRATION IS ALLOWED AND DOES NOT REFUSE THE BOOT (since
# this service left the one-baseline dev phase). The stamp lists the
# migrations individually, so "0002 was added" is distinguishable from "0001 was
# edited"; the first is a deploy, the second is still an exit 1. An added
# migration prints a line naming it and then applies normally. See
# plan/schema-gate-additive-migrations.md.
#
# The chain lives in package.json (`db:migrate:prod`) so there is ONE definition
# of it rather than one here and one there. The node image ships npm, which is
# enough to run a script; pnpm is not needed at runtime.
# 🔴 THE `--import` FLAG IS LOAD-BEARING AND MUST MATCH package.json's `start`
# SCRIPT — `src/telemetry/preload.ts` installs the ESM loader hook without which
# `@opentelemetry/instrumentation-pino` patches nothing and no log line ever
# carries a `trace_id` (read that file's header). It is inert with
# OTEL_EXPORTER_OTLP_ENDPOINT unset. The two copies of the flag are kept honest
# by `src/telemetry/preload.test.ts`, which reads both files.
#
# Why not `exec npm run start` and have one copy: npm would sit between the
# container's PID 1 and node, and SIGTERM must reach node itself — `index.ts`
# drains the workers and flushes the span processor on it.
CMD ["sh", "-c", "npm run --silent db:migrate:prod && exec node --import ./dist/telemetry/preload.js dist/index.js"]
