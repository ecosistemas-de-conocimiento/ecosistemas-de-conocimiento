# Running the tests

```bash
pnpm test          # every workspace, one at a time — this is the reliable one
pnpm typecheck
```

Current state, measured 2026-08-15: **1,780 passing, 0 skipped, 0 failing.**

| Workspace | Tests |
| --- | ---: |
| `services/ai-service` | 688 |
| `apps/backend` | 542 |
| `apps/web` | 417 |
| `packages/ai-client` | 55 |
| `packages/identity-client` | 50 |
| `packages/chat-engine` | 28 |

The 13 that used to show as skipped were `services/ai-service/src/routes/registry.test.ts`,
and they were never really a skip: the suite published its throwaway Postgres on a
**fixed host port 55432 — the same port `infra/docker-compose.yml` gives the local
demo**, so `docker run` failed with "port is already allocated" whenever the demo was
up. Those containers now bind an ephemeral host port (`-p 0:5432`) and read the
assignment back from `docker port`, so the suite runs alongside a live local stack.
See `services/ai-service/src/test/pg-container.ts`.

They still skip where Docker itself is absent — that is a real environment problem, and
the only one left that this harness treats as one.

## 🔴 Why `pnpm test` is deliberately sequential

`pnpm -r test` runs all six workspaces **concurrently**. On this repo that produces
**intermittent failures that are not real**: a different test fails on each run, and
every one of them fails at almost exactly 5000 ms — vitest's default per-test timeout.

Measured on a 16-core machine, 2026-08-14 (before the ai-service fix below):

- run 1 — 2 failures in `services/ai-service` (`/v1/route` registry precedence)
- run 2 — 1 failure in `apps/backend` (local-disk fallback), 1 in ai-service (`/v1/capabilities`)
- sequential — **0 failures, three runs in a row**

The ai-service half of that is fixed — see the section below. `apps/backend` still
flakes under `test:parallel`, which is why `pnpm test` remains sequential.

The tests that flake are the ones doing genuine work inside a single test body:
building the real Payload config, standing up a Fastify instance, constructing a
postgres adapter. Six workspaces of that at once starves them of CPU, they cross 5 s,
and vitest fails them for lateness rather than for being wrong.

⚠ **This matters more than the lost minute.** A suite that fails randomly teaches
everyone to re-run it until it passes, and a real regression then reads as "just the
flaky one again". Sequential is slower and believable; parallel is faster and not.

`pnpm test:parallel` still exists for when you want speed and can read the result
critically.

## The better fix — ✅ done for `services/ai-service`, 📝 still open elsewhere

Sequential execution treats the symptom. The underlying issue is that a handful of
tests do multi-second setup work under a 5 s per-test budget.

**`services/ai-service` no longer does.** Every route test used to call
`await import('../server.js')` inside `makeApp()`, so the first test in each file paid
~3 s of module-graph transform out of its own 5 s budget. That import is now hoisted
into `beforeAll` via `src/test/server-harness.ts`, paid once per file and off the
per-test clock. `testTimeout` stays at the strict 5 s default — a slow *test* should
still fail — while `hookTimeout` gets a realistic budget for the one-time setup.

Measured effect: the slowest single test in the suite went from **4,564 ms to 877 ms**.
Four consecutive `pnpm -r test:parallel` runs and four more under 16 synthetic busy
workers on a 16-core box: **688/688 passing every time, zero 5000 ms timeouts.**

📝 **`apps/backend` still has the pattern.** `src/payload.config.storage.test.ts >
leaves media on local disk` builds the real Payload config inside the test body and
takes **3.8 s unloaded**; it is the test that fails on every parallel run above. The
same `beforeAll` hoist would fix it. Until then `pnpm test` stays sequential.

## Not covered by any of this

- **No `docker build` has ever run.** Every Dockerfile is unverified.
- **The audio path has never run end to end** — no model weights, no built image.
- **Svelte components are typechecked and built, never rendered.** There is no DOM
  test environment, so UI logic is tested only where it was extracted into pure
  functions.
- **Object storage was exercised live against RustFS `1.0.0-rc.1`** — upload, ranged
  GET, cross-tenant 403 — but only with a **root** credential. A scoped credential is
  untested, and it is the one a real deployment would use.
