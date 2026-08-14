# SECURITY-LOCAL — ai-service dev container hardening

Scope: the local dev-in-docker setup (`Dockerfile.dev` plus the root
`docker-compose.yml` that runs it). Not stage/prod — that is the multi-stage
`Dockerfile`.

## Lifecycle-script hardening

- Dependency install scripts are blocked by default. pnpm 9 does not run
  `preinstall`/`install`/`postinstall` for dependencies unless the package is
  listed in the root `pnpm-workspace.yaml` under `onlyBuiltDependencies`.
  That allowlist is the single place to audit; it currently permits `esbuild`,
  `@parcel/watcher` and `sharp`, none of which ai-service pulls in directly.
- **ai-service itself needs no build-script allowlist.** It has zero
  dependencies that require a native compile step. The only native artifact is
  esbuild (pulled in transitively by `tsx`), which ships prebuilt per-platform
  binaries via `optionalDependencies` — no `postinstall` build.
- This package used to carry its own `.npmrc` with `ignore-scripts=true`. It was
  removed: pnpm resolves `.npmrc` from the install root, so a package-level file
  is dead config in a workspace and reading it as active protection is worse
  than not having it. The root `.npmrc` + `onlyBuiltDependencies` own this now.
- If a future dependency genuinely needs a lifecycle script, add it to
  `onlyBuiltDependencies` in the root `pnpm-workspace.yaml`, deliberately, and
  record the reason here.

## Other hardening

- Runs as the non-root `node` user (uid 1000) baked into the node image.
- `node_modules` lives in named volumes — never bind-mounted from the host
  (perf + avoids host/container native-binary mismatch). Because pnpm links
  packages relatively into `/repo/node_modules/.pnpm`, BOTH trees need a volume:
  `/repo/node_modules` and `/repo/services/ai-service/node_modules`. The image
  seeds them on first run.
- The repo is bind-mounted at `/repo` at runtime for hot-reload; no host secrets
  are mounted.
- Secrets are runtime-only env via compose `env_file` — never build args, never
  copied into an image layer. `.env*` is gitignored.
- `/var/run/docker.sock` is never mounted.

## Secrets that reach this service

`OPENROUTER_API_KEY` is platform-wide and single: only ai-service holds it, and
consumers reach OpenRouter through `/v1/openrouter/credits` rather than
carrying their own key. `API_KEYS` holds the per-consumer bearer tokens AND
their `callbackSecret` HMAC keys. Both are env-only, never in the database, and
`server.ts` redacts `req.headers.authorization` from the request log.
