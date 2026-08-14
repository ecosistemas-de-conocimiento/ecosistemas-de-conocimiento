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
COPY . .
# src/payload-types.ts is gitignored; routes that import it need it present at
# build time. `generate:types` reads the config only — no database, no onInit.
WORKDIR /repo/apps/backend
RUN pnpm payload generate:types && pnpm build

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
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/apps/backend ./
EXPOSE ${PORT}
# ⚠ `start` is `next start` ONLY — it does NOT run `payload migrate`, because
# there is no baseline migration yet and the schema is created by Payload's
# push. See src/migrations/README.md: when the baseline lands, this becomes
# `payload migrate && next start` and PAYLOAD_DISABLE_PUSH=1 goes into every
# deployed environment, in the same change.
CMD ["pnpm", "start"]
