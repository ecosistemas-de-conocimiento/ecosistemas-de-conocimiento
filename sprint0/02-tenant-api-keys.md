# 02 — Per-ecosistema API keys, before prod

**Blocked on:** 🟡 owner. This is a design decision, not a task.
**Independent of task 03** — do not let this block that fix.

## The problem

`apps/backend/src/lib/aiClient.ts` builds **one** memoised client from a single
`AI_SERVICE_API_KEY`, used for every ecosistema. ai-service scopes budget and
rate limits by `(org, project)` taken from that key.

So today, across all tenants:

- one rate-limit bucket
- one spend cap
- one budget to exhaust

`apps/backend/src/lib/corpus.ts` already states this in its header: *"budget is
keyed on `org` ALONE, so all ecosistemas share one spend cap."* It was written as
a known limitation. Going to production turns it into a customer-facing one.

## What it means concretely

One ecosistema bulk-uploading — exactly what the corpus seed did — can exhaust
the rate limit and the budget for every other ecosistema. There is no mechanism
that prevents it and no signal that distinguishes it from an outage.

⚠ **Task 03 does not fix this.** Moving the limiter to per-key still leaves every
tenant on the same key. 03 isolates this product from *other products* sharing
that ai-service. It does not isolate customers from each other.

## Options

**A. Per-ecosistema API keys.** A key per organization in ai-service's `API_KEYS`
map, and a keyed client factory in the backend. Real isolation of budget and rate
limit. Costs: key provisioning and rotation become part of creating an
ecosistema, and `API_KEYS` is an env-var JSON map, so it is not obviously the
right home for hundreds of them.

**B. Application-level quota.** Keep one key, meter per organization in the
backend before calling out. Cheaper, no ai-service change, and it is the only
option that can express product-level fairness. But it is a second limiter that
can disagree with the real one.

**C. Accept it.** Defensible with few, trusted, similar-sized tenants. Not
defensible silently — it should be written down as an accepted risk with the
condition that revokes it.

## What is needed to decide

- How many ecosistemas at launch, and are they mutually trusting?
- Is spend billed per ecosistema, or pooled? If billed per tenant, A is close to
  forced — you cannot bill what you cannot attribute.
- Does ai-service serve other products in the same deployment?
