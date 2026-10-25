# @edc/web — production image: pnpm + SvelteKit (adapter-node) → Node on :3000.
#
# ⚠ BUILD CONTEXT IS THE REPO ROOT, not this directory:
#     docker build -f apps/web/Dockerfile -t edc-web .
#
# This app depends on `@edc/ai-client` and `@edc/chat-engine` as `workspace:*`,
# so the lockfile, the workspace manifest and `packages/` must all be inside the
# context. There is no private registry and no install-time token any more —
# everything resolves from the workspace or the public registry.
#
# AI_SERVICE_URL / AI_SERVICE_API_KEY / BACKEND_URL are *runtime* env vars
# (read per request via $env/dynamic/private), so they are NOT build args and
# never enter the client bundle. See `.env.example` for the full list.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# ⚠ Docker reads only the CONTEXT ROOT's `.dockerignore`. With the repo root as
# the context, `apps/web/.dockerignore` is not consulted — the root needs one,
# or `.git/`, host `node_modules/` and unrelated trees land in the image.
COPY . .
# ⚠ `--frozen-lockfile` needs `pnpm-lock.yaml` to exist: run a root
# `pnpm install` once before the first image build.
# `--filter @edc/web...` installs web and its workspace deps only — not
# ai-service's or backend's trees, which this image never runs.
RUN pnpm install --frozen-lockfile --filter "@edc/web..."
# `...` = web AND its workspace deps, in order: packages publish from dist/,
# which is never in the build context.
RUN pnpm --filter "@edc/web..." build
# `pnpm deploy --prod` writes a self-contained copy of web's PRODUCTION
# dependencies to /out: real directories, no symlinks into the root store, and
# the `@edc/*` workspace packages copied in from their `files` (dist/). That
# is what lets the run stage drop the workspace, the dev deps and the store.
RUN pnpm --filter @edc/web deploy --prod /out

FROM node:22-alpine AS run
WORKDIR /repo/apps/web
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# 🔴 adapter-node's default is 512K and answers 413 BEFORE any route runs, so
# every recording past ~2 min failed (dev, 2026-10-24). 201M = the 200 MB audio
# cap (`MAX_AUDIO_UPLOAD_BYTES`, `apps/web/src/lib/config.ts`) + multipart
# overhead. `src/lib/bodyLimit.test.ts` keeps the two in step.
ENV BODY_SIZE_LIMIT=201M
# `build/` is NOT standalone: Vite's SSR build EXTERNALISES every package in
# `dependencies` instead of inlining it, so the emitted server chunks still
# contain bare `import '@edc/chat-engine/core'` / `'markdown-it'` /
# `'dompurify'` and need a real `node_modules` at runtime. devDependencies —
# zod, @sveltejs/kit, … — ARE inlined. So the run stage needs exactly:
# `build/`, plus the production `node_modules` that `pnpm deploy` produced.
# A missing entry boots fine and only the routes touching an externalised
# package fail, with `ERR_MODULE_NOT_FOUND` — check a chat route after changes.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/web/build ./build
EXPOSE ${PORT}
# Liveness hits the unauthenticated health route, which by contract checks
# nothing downstream — a backend blip must not restart this container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health > /dev/null || exit 1
CMD ["node", "build"]
