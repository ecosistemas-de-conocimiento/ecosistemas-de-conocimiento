> **Status — Follow-up to decision #4 in `plan/m3-m4-decisions.md`.**
>
> Escalation path from a hardcoded validator-retry cap of 1 to per-project / per-call configurability.

# M3 validator-retry follow-up

## §1. Current state

The M3 worker hardcodes a single constant:

```ts
const MAX_VALIDATOR_RETRIES = 1; // src/workers/generation.worker.ts, line TBD when the worker lands
```

Flow: call the model; run `runValidators(checks, output, ctx)`; if any flag is `blocker` and `attempts < MAX_VALIDATOR_RETRIES + 1`, re-prompt with the validation summary appended and call again. After 1 retry (2 total model calls), if validators still fail, mark the job `failed`, write `error = <validator summary>`, and emit `generation.job.failed`. No backoff, no jitter, no per-validator weighting.

## §2. Why hardcoded was chosen

- **One knob is enough until evidence of need.** No consumer is asking for more. Building a config surface with no payoff is debt.
- **Spend protection.** Every retry doubles spend on that job. A low fixed cap is the easiest budget guard.
- **Failure visibility stays loud.** Chronic validator failures show up as `failed` rows on dashboards. A retry knob hides them in spend instead.

## §3. Three escalation tiers

In order of recommended adoption. Adopt the lowest tier that solves the problem.

### §3.1. Tier 1 — per-project config

**What.** Read `project_configs.metadata.validatorRetries`. Fall back to `MAX_VALIDATOR_RETRIES = 1` when absent.

**Schema change.** None. `project_configs.metadata` is opaque jsonb.

**Migration.** None.

**Code change.** One read in `src/workers/generation.worker.ts`:

```ts
const cap = ctx.projectConfig?.metadata?.validatorRetries ?? MAX_VALIDATOR_RETRIES;
```

The worker already has the project config loaded (registry resolution needs the defaults). No extra query.

**Risks.**

- **Silent drift.** A consumer can set `validatorRetries: 5` without understanding it can 5× the cost of a chronically-failing unitType. Mitigation: on the registry-write route, soft-cap at 3 and reject higher with a typed error.
- **No per-unitType differentiation.** A project with both a strict json-schema unit and a noisy free-form unit must pick one value.
- **Discovery.** The knob isn't in any OpenAPI schema — it's in opaque jsonb. Document in the consumer-contract.

**Adoption criterion.** Adopt tier 1 when **any** consumer reports a unitType that needs > 1 retry consistently — i.e. failure rate halves or better with one extra retry. Until that data exists, tier 1 is speculative.

### §3.2. Tier 2 — per-call override

**What.** Add `validatorRetries?: number` to the `POST /v1/generate` request body. Per-call: a consumer dials retries up for a specific noisy batch without changing project defaults.

**Schema change.** Zod update in `src/schemas/generate.ts`:

```ts
validatorRetries: z.number().int().min(0).max(3).optional(),
```

Stored on `generation_requests.metadata.validatorRetries` (no new column). Worker precedence: request-level → project-level → constant.

**Migration.** None.

**Risks.**

- **API-surface expansion.** One more optional knob in `/v1/generate`. Cumulatively these add up.
- **Spend abuse.** Setting `validatorRetries: 3` on every call burns 3× the model spend. Budget enforcer protects total org spend; per-call efficiency degrades silently. Mitigation: Zod `max(3)`; OpenAPI doc notes retries multiply per-call cost.
- **Precedence becomes a thing.** Three layers consumers must understand.

**Adoption criterion.** Adopt tier 2 when **either** a consumer has a small set of calls that justify a higher count, **or** a consumer wants to A/B test retries without changing project state.

### §3.3. Tier 3 — per-unitType in the registry

**What.** Add `validatorRetries?: number` to `registry_entries.spec` and to inline `specOverride`. Precedence: specOverride → request → project → constant.

**Schema change.** DB unchanged (`spec` is jsonb); `src/schemas/registry.ts` Zod gains the field. Consumer-contract documents it.

**Risks.**

- **Tightest control, biggest surface.** Three precedence layers means three places to look when debugging "why did this unit retry 4 times".
- **Drift across registry versions.** A `validatorRetries` bump in v4 is invisible in v3-vs-v4 diffs unless you know to look. Audit log catches it; root-causing spend spikes gets harder.
- **Probably overkill.** Consumers tune per-unitType only after per-project and per-call have failed. Likely never adopted; documented so the path exists.

**Adoption criterion.** Adopt tier 3 only when **multiple** consumers report **multiple** unitTypes each needing different budgets, AND per-project is provably insufficient (noisy and tight unitTypes can't share one value).

## §4. Tradeoffs of having no retry budget at all

A reasonable alternative is 0 retries — validators emit blockers, the worker marks `failed`, done. M3 keeps **one** retry because:

- LLM outputs sometimes fail validation on transient format slippage (a missing closing brace, a stray fence). One re-prompt with the error often fixes it cheaply.

But: if retries went off entirely, what protects spend?

- **Per-call estimate is exact only at 0 retries.** With N retries, the true upper bound is (N+1)× the estimate. `estimatedCostUsd` in the `/v1/generate` response is currently a lower bound; consumers may treat it as authoritative. Document the upper-bound semantics when tier 1+ lands.
- **Budget enforcer reserves the estimate, not the upper bound.** On true-up, actuals are deducted. The only real spend ceiling is `budget_state.remaining_usd`. There is no per-call cap. Fine at hardcoded-1; a real concern at tier 2 or 3.
- **Implication.** When adopting tier 2 or 3, the enforcer's reserve should switch to the upper bound: `estimatedCostUsd = perCall × passes × samples × (1 + maxRetries)` in `src/services/generation/estimate.ts`.

## §5. Recommended path forward

- **M3 ships tier 0** (hardcoded 1).
- **First evidence of need → tier 1** (one-line worker change).
- **Per-call requested by a consumer → tier 2** (Zod + worker; ~20 lines).
- **Tier 3 stays a known option but unbuilt** until the case appears.

Each tier is additive over the previous; adopting tier 2 doesn't undo tier 1. Precedence is the only place complexity grows.
