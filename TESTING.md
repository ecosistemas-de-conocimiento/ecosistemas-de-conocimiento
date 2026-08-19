# Running the tests

```bash
pnpm test          # every workspace, in parallel
pnpm typecheck
```

Current state, measured 2026-08-18: **1,811 passing, 0 skipped, 0 failing.**

| Workspace | Tests |
| --- | ---: |
| `services/ai-service` | 688 |
| `apps/backend` | 564 |
| `apps/web` | 426 |
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

## ✅ Parallel again — and why it was not, for three days

`pnpm test` runs all six workspaces concurrently. It used to produce
**intermittent failures that were not real**: a different test failed on each run,
and every one failed at almost exactly 5000 ms — vitest's default per-test timeout.

The cause was never flakiness in the usual sense. Two suites did multi-second
setup work *inside a test body*, and were charged for it against that one test's
budget:

- **`services/ai-service`** — every route test called `await import('../server.js')`
  inside `makeApp()`, paying ~3 s of module-graph transform on the first test of
  each file. Hoisted into `beforeAll` via `src/test/server-harness.ts`. Slowest
  single test: **4,564 ms → 877 ms**.
- **`apps/backend`** — `payload.config.storage.test.ts` built the real Payload
  config in the test body, ~3.8 s. Both configs are now built once in a single
  `beforeAll`. Slowest single test in that file is now under 2 s.

`testTimeout` stays at the strict 5 s default in both. That is deliberate: a slow
*test* should still fail, while a slow one-time *setup* should not be charged to
one. `hookTimeout` carries the real budget instead.

**Evidence for flipping the default back** (2026-08-18, 16-core box): three
consecutive parallel runs clean, plus one more under 12 synthetic busy workers at
load average 34 — **1,811 passing, 0 failing, zero 5000 ms timeouts** every time.

`pnpm test:sequential` remains for when you want to rule the scheduler out entirely.

⚠ **Why this mattered more than the minute it cost.** A suite that fails randomly
teaches everyone to re-run it until it passes, and a real regression then reads as
"just the flaky one again". Sequential was the honest stopgap; this is the fix.

## Not covered by any of this

- **No `docker build` has ever run.** Every Dockerfile is unverified.
- **The audio path has never run end to end** — no model weights, no built image.
- **Svelte components are typechecked and built, never rendered.** There is no DOM
  test environment, so UI logic is tested only where it was extracted into pure
  functions.
- **Object storage was exercised live against RustFS `1.0.0-rc.1`** — upload, ranged
  GET, cross-tenant 403 — but only with a **root** credential. A scoped credential is
  untested, and it is the one a real deployment would use.
