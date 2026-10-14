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
RUN pnpm install --frozen-lockfile
# `...` = web AND its workspace deps, in order: packages publish from dist/,
# which is never in the build context.
RUN pnpm --filter "@edc/web..." build

FROM node:22-alpine AS run
WORKDIR /repo/apps/web
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# The whole installed workspace comes across, on purpose. `build/` is NOT
# standalone: Vite's SSR build EXTERNALISES every package listed in
# `dependencies` instead of inlining it, so the emitted server chunks still
# contain bare `import '@edc/chat-engine/core'` / `'markdown-it'` /
# `'dompurify'` and need a real `node_modules` at runtime. In a pnpm workspace
# those are symlinks into the root store and into `packages/`, so the root and
# app trees must be copied together or the links dangle. (devDependencies — zod, @sveltejs/kit, …
# — ARE inlined, which is why a broken copy boots fine and only the routes
# touching an externalised package fail, with `ERR_MODULE_NOT_FOUND`.)
COPY --from=build /repo /repo
EXPOSE ${PORT}
# Liveness hits the unauthenticated health route, which by contract checks
# nothing downstream — a backend blip must not restart this container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health > /dev/null || exit 1
CMD ["node", "build"]
