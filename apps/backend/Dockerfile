# @edc/backend — container image.
#
# ⚠ THIS IS A PNPM WORKSPACE MEMBER. It depends on `@edc/ai-client` and
# `@edc/chat-engine` via `workspace:*`, so the BUILD CONTEXT IS THE REPO ROOT,
# not this directory. Building from `apps/backend/` cannot work: the workspace
# links have nothing to resolve against.
#
# Build:  docker build -f apps/backend/Dockerfile -t edc-backend .   (from the repo root)

# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# ── deps: install the whole workspace (cacheable layer) ─────────────────────
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /repo
RUN corepack enable
# Only the manifests first, so a source-only change does not re-run the install.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/ai-client/package.json ./packages/ai-client/
COPY packages/chat-engine/package.json ./packages/chat-engine/
COPY packages/identity-client/package.json ./packages/identity-client/
# ⚠ No .npmrc and no registry token. The `@edc/*` packages used to be published
# to a private registry and pulled with a PAT at build time; in this repo they
# are workspace members on disk, so there is nothing to authenticate to.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── build: generate payload-types, then `next build` ────────────────────────
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /repo/packages/ai-client/node_modules ./packages/ai-client/node_modules
COPY --from=deps /repo/packages/chat-engine/node_modules ./packages/chat-engine/node_modules
COPY --from=deps /repo/packages/identity-client/node_modules ./packages/identity-client/node_modules
COPY . .
# The workspace packages publish from dist/, which is gitignored and
# dockerignored — build them here, or a clean checkout dies ERR_MODULE_NOT_FOUND.
RUN pnpm --filter "@edc/backend^..." build
# src/payload-types.ts is gitignored; routes that import it need it present at
# build time. `generate:types` reads the config only — no database, no onInit.
WORKDIR /repo/apps/backend
RUN pnpm payload generate:types && pnpm build
# `pnpm deploy --prod` writes a self-contained copy of the backend's PRODUCTION
# dependencies to /out (its own `.pnpm` store, the `@edc/*` packages copied in
# from their dist/). The runtime stage takes that instead of the workspace's
# full `node_modules`, which carries every dev dep (typescript, eslint, vitest,
# drizzle-kit, playwright, …). The deps stage's store is not here, so this
# re-fetches from the registry — prod deps only.
WORKDIR /repo
RUN pnpm --filter @edc/backend deploy --prod /out \
# pnpm installs the native optional deps for BOTH libcs here (measured: next's
# swc, sharp's libvips, lightningcss, @napi-rs/canvas — ~220 MB of musl
# binaries). This image is Debian (glibc); the musl builds can never load.
  && find /out/node_modules/.pnpm -maxdepth 1 -name '*musl*' -exec rm -rf {} +
# `.next/cache` is next build's incremental cache — ~450 MB measured in the
# previous image, and `next start` never reads it. The dev-deps symlink farm in
# `apps/backend/node_modules` is replaced by /out's below.
#
# 🔴 `typescript` is a devDependency, but `next start` NEEDS it: Next loads
# `next.config.ts` through it, and without it tries `yarn add typescript` at
# boot and dies (measured). It has no dependencies, so a plain copy suffices.
RUN cp -rL apps/backend/node_modules/typescript /out/node_modules/typescript \
  && rm -rf apps/backend/.next/cache apps/backend/node_modules

# ── runtime: ship .next plus the source the path aliases need ───────────────
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /repo/apps/backend
RUN corepack enable
ENV NODE_ENV=production
# Container-INTERNAL listen port. `next start` and the EXPOSE below both read
# it, and the package.json `start` script passes it through. Whatever routes
# traffic to this container must be pointed at the same number.
ENV PORT=3002
# `curl` lets an orchestrator hit /api/health from inside the container as a
# HEALTHCHECK. ~3 MB added.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
# Source stays (payload.config.ts, src/migrations, tsconfig paths): `payload
# migrate` and the `payload run` ops scripts load TypeScript through tsx at
# runtime. node_modules is /out's production-only, self-contained tree, so
# /repo/node_modules and /repo/packages are no longer needed.
COPY --from=build /repo/apps/backend ./
COPY --from=build /out/node_modules ./node_modules
EXPOSE ${PORT}
# 🔴 NO pnpm AT RUNTIME. DO NOT "simplify" the CMD below back to `pnpm start`.
#
# pnpm 11 runs a dependency-status check before any script, and that check
# re-reads the WORKSPACE. This runtime stage deliberately carries only the
# backend and its deployed `node_modules` — there is no root
# `package.json` or `pnpm-workspace.yaml` — so the check sees a workspace of
# exactly one package and dies with:
#   "@edc/ai-client@workspace:*" is in the dependencies but no package named
#   "@edc/ai-client" is present in the workspace
# It then tries a full `pnpm install` inside the container and fails.
#
# The dependencies are installed and correct; only the check is wrong. It
# presents as an install error at container start, which reads like a broken
# image rather than a tooling default — hence this comment.
#
# `npm_config_verify_deps_before_run=false` does NOT fix it (pnpm reads that
# setting from .npmrc, not the environment) — measured, not assumed. Invoking
# the binaries directly sidesteps the whole thing and removes a package manager
# from the runtime image, which is where it least belongs.
# ✅ `start` is `payload migrate && next start`. The baseline migration exists
# (src/migrations/20260908_092211_baseline.ts), so the schema is created and
# advanced by migrations, NOT by Payload's schema push. No environment variable
# is needed to get that: the push gate is opt-IN (PAYLOAD_ALLOW_PUSH=1), so push
# is off unless someone deliberately turns it on. Do not turn it on here — push
# removes the baseline's four hand-written indexes without erroring, including
# the compound UNIQUE constraints behind ratings/memberships/callback
# de-duplication. See infra/fleet/env-manifests.md §6 and
# src/migrations/README.md.
#
# 🔴 If `payload migrate` fails, the container never reaches `next start` and
# the deploy fails loudly. That is the intended behaviour: booting an app
# against a schema its migrations could not produce is the failure mode that
# takes hours to diagnose.
#
# 🔴 `scripts/migrate.sh`, not bare `payload migrate`: the CLI can exit 0
# silently without migrating (34296a8 deploy, 2026-10-26). The script requires
# Payload's `Done.` line and retries a silent run. See its header.
CMD ["sh", "-c", "sh scripts/migrate.sh && exec node_modules/.bin/next start -p ${PORT:-3002}"]
