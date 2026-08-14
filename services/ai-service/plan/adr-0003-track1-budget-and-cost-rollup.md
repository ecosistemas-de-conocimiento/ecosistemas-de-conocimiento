> **Status.** Decision log for ADR-0003 Track 1 (ai-service half).
> Implements S1 (fail-closed per-org budget cap) + S2 (cost-rollup undercount
> fix). The ADR lives in the strategy vault:
> `plan/tecnología/ai-infra/adr-0003-consumer-credit-ledger-and-balance-display.md`.
> Track 2 (a prototype credit ledger) and Track 3 (shared package) are NOT in this
> change. Same format as `m5-decisions.md`.

# ADR-0003 Track 1 — fail-closed budget + cost-rollup fix

## 1. S2 — cost-rollup undercount root cause + fix

**Symptom (from the ADR).** `generation_requests.actual_cost_usd` undercounts
Σ(trace `actual_cost_usd`) by ~2–2.4× (a 39-unit batch recorded $0.0037 while
its traces summed to $0.0088). Track 2's credit debit trues-up from this number,
so the undercount drained credits ~half too slow.

**Root cause.** The generation worker's **validator-retry** path
(`src/workers/generation.worker.ts`) makes a SECOND `router.route()` call when
the first result has blocker flags. Each `route()` call writes its OWN `traces`
row (with its own `actual_cost_usd`) and spends real budget — but the worker
rolled up only the FINAL `result.usage.estimatedCostUsd`, dropping the discarded
first-call cost. On a structured-JSON fan-out where most units fail first-pass
validation and retry once, each retrying unit produces 2 traces but contributed
only 1 to the request rollup → ~2× undercount. (The router's multi-pass
refine/sample accounting was already correct: it writes ONE trace per `route()`
with `actual_cost_usd = Σ breakdown`, and `usage.estimatedCostUsd` mirrors it.
The gap was strictly the worker dropping a whole `route()` call's cost.)

**Fix.** The worker now accumulates `accumulatedCostUsd` across EVERY
`router.route()` call it makes for a unit (initial pass + validator retry), and
uses that sum for the job row's `actual_cost_usd`, the parent request rollup
(`costDelta`), the per-unit callback `costUsd`, and the cancel-after-retry stamp.
Invariant restored: **request rollup == Σ(trace actual_cost_usd)**.

**Tests.** Unit (`generation.worker.test.ts`) asserts the retry case rolls up
BOTH calls' cost; a new real-Postgres integration test
(`generation.worker.integration.test.ts`) drives the real router + DB-backed
trace writer through a 2-unit run where each unit retries once, and asserts
`generation_requests.actual_cost_usd == Σ(traces.actual_cost_usd)` exactly
(4 traces, $0.008 both sides).

**Tradeoff.** The per-unit callback `costUsd` is now the unit's TOTAL spend
(both calls), not the winning call's — correct for true-up and for "Σ units ==
request total", but a consumer that assumed it was the single-winner cost will
see a larger number. This is the intended, more-accurate value.

## 2. S1 — fail-closed per-org budget cap

**Decision.** Replace the silent $100 `budget_state` bootstrap with explicit,
fail-closed caps. `BudgetEnforcer.reserve()` no longer fabricates a row: if the
org has no `budget_state` row it throws the new `BudgetNotConfigured` (HTTP 402,
message `"no budget configured for org <org>"`). The orchestrator gains an
up-front `budget.assertConfigured(org)` so the friendly 402 fires before any DB
write; the atomic reserve enforces the same invariant as the real boundary. The
router writes a failed trace for `BudgetNotConfigured` too (observability parity
with `BudgetExceeded`).

**Surfaces touched.** `/v1/generate`, `/v1/generate/sync`, `/v1/generate/stream`
(via `mapGenerateError` / `classifyStreamError`), `/v1/embed`. `/v1/route` keeps
its existing fail-SAFE behaviour (degrades to the fallback route — never spends).
OpenAPI 402 descriptions updated. The typed client gained a
`BudgetNotConfiguredError` (additive; consumers catching `AIServiceError` or
`BudgetExceededError` are unaffected — forward-compatible).

**Provisioning — `scripts/set-budget.ts` (`pnpm run set-budget`).** Caps are set
via this idempotent upsert script, changeable per the ADR WITHOUT a deploy (run
it against the target env's `DATABASE_URL`). A migration was deliberately NOT
used: a migration runs identical SQL on every env, but the rollout needs
different per-env values AND prod left UNSET — which a migration can't express.

**Per-env caps to provision (org `edc`).** Every consumer shares this
org today, so this single cap bounds ALL dev spend — intended for
now.

| env    | cap   | command |
|--------|-------|---------|
| dev    | $25   | `DATABASE_URL=<dev>    pnpm run set-budget -- --org edc --limit 25` |
| stage  | $25   | `DATABASE_URL=<stage>  pnpm run set-budget -- --org edc --limit 25` |
| demo-0 | $10   | `DATABASE_URL=<demo-0> pnpm run set-budget -- --org edc --limit 10` |
| prod   | UNSET | (intentionally not provisioned — fail-closed; generation 402s until set) |

**Prod cap, when decided (Rodrigo runs this — NOT part of this change):**

```
DATABASE_URL=<prod> pnpm run set-budget -- --org edc --limit <USD>
```

**Operational caveat.** Because the service is now fail-closed, each env's
`edc` budget MUST be provisioned right after the dev/stage/demo-0 deploy
or generation 402s. The provisioning is a post-deploy step, not baked into the
migration.

**When to revisit.** When org `edc` is split per-product (so dev caps
stop being shared across every consumer); when a real `organizations` table lands
(`plan/open-organizations-table.md`) and caps move onto it; when prod traffic
needs its own ceiling.
