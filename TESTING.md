# Running the tests

```bash
pnpm test          # every workspace, one at a time — this is the reliable one
pnpm typecheck
```

Current state, measured 2026-08-14: **1,767 passing, 13 skipped, 0 failing.**

| Workspace | Tests |
| --- | ---: |
| `services/ai-service` | 675 (+13 skipped) |
| `apps/backend` | 542 |
| `apps/web` | 417 |
| `packages/ai-client` | 55 |
| `packages/identity-client` | 50 |
| `packages/chat-engine` | 28 |

The 13 skips are ai-service integration tests that provision their own database and
skip when it is unavailable. They are not failures, but they are also not coverage —
they only run where Docker is available to them.

## 🔴 Why `pnpm test` is deliberately sequential

`pnpm -r test` runs all six workspaces **concurrently**. On this repo that produces
**intermittent failures that are not real**: a different test fails on each run, and
every one of them fails at almost exactly 5000 ms — vitest's default per-test timeout.

Measured on a 16-core machine:

- run 1 — 2 failures in `services/ai-service` (`/v1/route` registry precedence)
- run 2 — 1 failure in `apps/backend` (local-disk fallback), 1 in ai-service (`/v1/capabilities`)
- sequential — **0 failures, three runs in a row**

The tests that flake are the ones doing genuine work inside a single test body:
building the real Payload config, standing up a Fastify instance, constructing a
postgres adapter. Six workspaces of that at once starves them of CPU, they cross 5 s,
and vitest fails them for lateness rather than for being wrong.

⚠ **This matters more than the lost minute.** A suite that fails randomly teaches
everyone to re-run it until it passes, and a real regression then reads as "just the
flaky one again". Sequential is slower and believable; parallel is faster and not.

`pnpm test:parallel` still exists for when you want speed and can read the result
critically.

## 📝 The better fix, not done here

Sequential execution treats the symptom. The underlying issue is that a handful of
tests do multi-second setup work under a 5 s per-test budget. Raising `testTimeout`
for those specific suites — or hoisting the expensive setup into `beforeAll` so it is
paid once per file rather than once per test — would let the suite run in parallel
honestly. That is a real piece of work, not a config line, so it is written down
rather than guessed at.

## Not covered by any of this

- **No `docker build` has ever run.** Every Dockerfile is unverified.
- **The audio path has never run end to end** — no model weights, no built image.
- **Svelte components are typechecked and built, never rendered.** There is no DOM
  test environment, so UI logic is tested only where it was extracted into pure
  functions.
- **Object storage was exercised live against RustFS `1.0.0-rc.1`** — upload, ranged
  GET, cross-tenant 403 — but only with a **root** credential. A scoped credential is
  untested, and it is the one a real deployment would use.
