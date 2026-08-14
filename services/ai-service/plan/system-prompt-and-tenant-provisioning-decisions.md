# System prompts + tenant provisioning — decisions

Companion to `plan/m3-m4-decisions.md` / `plan/m5-decisions.md`. Two changes
landed together; they are independent but shared a branch.

Consumer-facing migration guide:
`plan/tecnología/ai-infra/system-prompt-consumer-cleanup-prompt.md` (strategy
vault, not this repo).

---

## Part A — system prompts

### A1. The bug

`src/workers/generation.worker.ts` called the router with a hardcoded
`messages: [{ role: 'user', content: renderedPrompt }]`, on both the first pass
and the validator-retry. `/v1/generate/sync` and `/v1/generate/stream` did the
same. **There was no `system` role anywhere in the generation path.**

Consequence: every consumer needing standing instructions (persona, output
contract, embedded response schema, anti-hallucination rules) hand-folded them
into the user prompt. That fold is invisible to types — a consumer tidying onto
the typed SDK loses it silently and the model returns junk that still parses.

Separately, `registry_entries.meta_prompt_template` existed (migration 0002),
was resolved in `services/registry/resolve.ts` and carried into `ResolvedSpec`
— and was then consumed by nothing. A socket designed and never wired.

### A2. Surface chosen: explicit `systemPrompt` field

Two new optional request fields:

- `unit.systemPrompt` — per unit, on `/v1/generate`, `/sync`, `/stream`.
- `systemPromptOverride` — batch/request level, on `/v1/generate` and `/sync`.

**Rejected alternative: honouring a `system` entry in the `input.messages`
array consumers already send.** Several consumers (the prototypes, chat)
today send `input.messages` *including* a system entry AND fold the same text
into `userPrompt`, because ai-service ignored the array. Honouring it would have
made those consumers send their instructions twice, immediately, with no code
change on their side — a silent behaviour change on live traffic. The hard
backward-compat gate forbids that. An explicit opt-in field is the only surface
that satisfies "absent system input ⇒ byte-identical behaviour".

The per-request field (not the registry column) is the load-bearing fix:
a system prompt built at runtime that varies per extraction profile and carries
the response schema cannot live in a registry row without duplicating and
desyncing.

### A3. Precedence

Highest first, implemented once in `src/services/generation/system-prompt.ts`
and used identically by the worker, `/sync` and `/stream`:

1. `unit.systemPrompt` — literal
2. `unit.specOverride.metaPromptTemplate` — rendered
3. `systemPromptOverride` — literal
4. `registry_entries.meta_prompt_template` — rendered
5. none ⇒ **no `system` message at all**

Rule: *most specific wins; per-request beats registry.* This mirrors the
existing `promptTemplate` chain in `resolveSpec` (inline specOverride → request
override → registry row) with the new explicit field on top.

Request-level beats registry-level because the registry row is an
admin-authored default and the request is what the consumer knows now. The
inverse would let a stale default silently override an explicit instruction.

Single-winner, not concatenation: a merged system prompt makes precedence
unreasonable and can double-inject contradictory contracts. Compose
consumer-side if both are wanted.

`ResolvedSpec.metaPromptSource: 'inline' | 'registry'` was added to carry
provenance — levels 2 and 4 are the same string field on the spec and must land
on different rungs of the ladder.

### A4. Rendered vs literal

Fields named `…Template` (levels 2, 4) are rendered with `renderPrompt`, using
the same variable bag as the user prompt. Fields named `systemPrompt` /
`systemPromptOverride` (levels 1, 3) are passed through byte-for-byte.

`renderPrompt` compiles Handlebars in **strict** mode: an unset variable throws.
A consumer-composed system prompt containing `{{` (embedded JSON schema, literal
example, mustache-looking placeholder) would blow up at generation time. Runtime
strings must be inert.

A render failure on a template-valued level surfaces as `RenderError` — the same
class the user-prompt path already throws, so routes map it to their existing
400 and the worker marks the job failed (`system prompt render error: …`).

### A5. Persistence (no migration)

- `unit.systemPrompt` → `generation_jobs.input.__systemPrompt` (jsonb, alongside
  `__renderedPrompt`). Deliberately NOT inside `__promptVars` — it is payload
  for the worker, not a template variable.
- `systemPromptOverride` → `generation_requests.meta_prompt_override`, a column
  that has existed since migration 0001 and was never written until now.
- Registry/inline levels need no persistence: the worker re-resolves the spec at
  pickup time.

**Zero schema changes in this work.**

### A6. Backward compatibility, and how it is proven

Guarantee: no system input at any level ⇒ the message array handed to the router
is byte-identical to before, so the router cache key (which hashes role+content
pairs) is unchanged and no existing consumer's behaviour moves.

Evidence in the suite:

- `services/generation/system-prompt.test.ts` — `withSystemMessage(undefined, …)`
  returns identical contents; blank/whitespace input counts as absent.
- `workers/generation.worker.test.ts` — the pre-existing happy-path test still
  pins `messages` to exactly `[{ role: 'user', … }]`; a new test pins the
  validator-retry to `['user','assistant','user']` when nothing is supplied.
- `routes/generate.test.ts` — "BACKWARD COMPAT: no system input ⇒ a single user
  message, exactly as before".
- `services/generation/orchestrator.test.ts` — the row shape is unchanged
  (`meta_prompt_override` null, no `__systemPrompt` key) AND the idempotency
  payload hash is byte-identical for callers that send no system prompt
  (`safe-stable-stringify` drops undefined values). This one matters: a changed
  hash would have flipped every live `clientRequestId` from replay to 409.
- `routes/openapi.test.ts` — the new request fields are documented and NOT in
  any `required` list.

### A7. `systemPromptApplied` — the migration safety net

`/v1/generate/sync` responses and the `/stream` `done` frame now carry
`systemPromptApplied: boolean` — true iff a real `system` message was sent.

Consumers assert `=== true` after migrating. A deployment that predates this
change omits the field entirely, so the assertion fails loudly instead of the
consumer silently losing its instructions. That failure mode — migrate, lose the
prompt, keep parsing fine — is the whole reason the flag exists.

Not exposed on the async batch path (no natural per-unit echo without widening
the job row's write shape); consumers verify that path via the same unit through
`/sync`.

### A8. Validator retry

The retry at `generation.worker.ts` carries the same system message as the first
pass. Asking a model to fix output while withholding the contract it violated
would be worse than not retrying.

---

## Part B — tenant provisioning

### B1. The problem

Standing up a consuming project needs three things, and a missing one fails as
three unrelated-looking errors:

| Missing | Failure |
|---|---|
| `API_KEYS` entry | 401 unauthorized |
| active `registry_entries` row | 400 `no active registry entry for unitType 'X'` |
| `budget_state` row | 402 `BudgetNotConfigured` |

Registry entries already had write endpoints. Budgets were **GET-only**, with
writes available exclusively through `scripts/set-budget.ts` — i.e. shell access
to the target environment's Postgres.

### B2. What was added

- `PUT /v1/budget/:org` — **admin**. Endpoint form of `scripts/set-budget.ts`,
  identical semantics (insert ⇒ limit = remaining = cap with a `next_reset_at`
  anchor; update ⇒ limit := cap, remaining clamped DOWN via
  `LEAST(remaining, cap)` and never raised unless `refill`). Idempotent. 201 on
  create, 200 on update.
- `POST /v1/tenant/provision` — **admin**. Budget + registry entries in one
  idempotent call. Per-item status (`created` / `updated` / `unchanged` /
  `skipped` / `failed`) rather than all-or-nothing: a bad prompt template for one
  unitType must not roll back the budget that already landed. An
  already-registered version reports `unchanged`, never an error.
- `GET /v1/tenant/readiness` — **any authenticated role**. Reports all three
  checks in plain language with a concrete `fix` per failure. Optional
  `?unitType=` turns the registry check from "any prompt at all" into the precise
  pre-emption of the 400.

### B3. Why readiness is not admin-gated

The other bullet points are admin-gated, consistent with the registry writes.
Readiness is deliberately not: the whole value is that the **consumer** hitting
the 401/400/402 can self-diagnose without waiting on an operator. It reports only
the caller's own scope, and only facts that scope can already read via
`GET /v1/budget/:org` and `GET /v1/registry/unit-types`. No new information is
disclosed.

### B4. What cannot be an endpoint

API keys live in the `API_KEYS` env map, parsed once at boot by
`config/env.ts`. There is no key table; adding one requires an environment edit
plus a container recreate. `provisionTenant` therefore **always** returns a
`manualSteps` entry spelling that out — reporting success on two of three pieces
and letting the operator discover the 401 later would recreate the exact
three-diagnoses-for-one-cause problem this endpoint exists to kill.

### B5. Tenancy invariant preserved

`org` / `project` come from `req.auth`, never from a request body. The
provisioning schemas are `.strict()` and have no `org`/`project` fields, so
smuggling a tenant in the body is a 400 — never a silent cross-tenant write.
`PUT /v1/budget/:org` validates the path param against `req.auth.org` and then
uses `req.auth.org` as the write key; a mismatch is 403. Tests pin all of this.

---

## Part C — test-infra note

`src/routes/registry.test.ts` hardcoded host port **55432** for its throwaway
Postgres container. The local-ecosystem docker stack (`edc-ai-db`)
binds the same port, so on a dev box running the local stack that entire suite
failed with `port is already allocated` — an environment failure indistinguishable
from a real one, which erodes the green-suite gate. The port is now
`AI_SVC_TEST_PG_PORT` with the same default. The new docker-backed suite
(`src/routes/tenant-provision.test.ts`) uses its own container name and port
(`AI_SVC_TEST_TENANT_PG_PORT`, default 55433) because vitest runs test files in
parallel.

---

## Open / deferred

- **`@edc/ai-client` bumped 0.5.0 → 0.6.0** (additive). Publishing is a
  separate, gated step.
- **A prototype's `*_META_PROMPT` blobs** could now move into
  `registry_entries.meta_prompt_template` instead of being sent per call. That is
  a prototype decision, separate from removing its fold, and is flagged in the
  consumer cleanup prompt rather than decided here.
- **chat's migration is behavioural, not mechanical**: it currently flattens the
  conversation through `specOverride.promptTemplate` with literal `system:` /
  `user:` role markers. Moving to a real system message changes what the model
  sees.
- **No `systemPromptApplied` on the async batch path** — see A7.
