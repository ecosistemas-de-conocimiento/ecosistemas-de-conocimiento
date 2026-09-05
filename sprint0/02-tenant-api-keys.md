# 02 — Per-ecosistema API keys, before prod

**Status:** ✅ **DECIDED 2026-09-04.** No longer open. Kept for the reasoning.
**Independent of task 03** — that fix is still worth doing; see the bottom.

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


---

## ✅ The decision (owner, 2026-09-04)

> *"We have a single master API key for now, and we create our own system for
> handing off keys to tenants."*

So: **option A, built by us, later.** Not option C — the shared key is explicitly
an interim state, not an accepted permanent risk. And not ai-service's `API_KEYS`
env map as the provisioning mechanism, which was the part of option A that did
not scale.

### What this means for whoever builds that system

- 🔴 **ai-service must still learn about every key.** Its `API_KEYS` map is the
  authority for `(org, project, role)` — a key it has never heard of is a 401.
  A tenant-key system therefore needs a provisioning path into ai-service, not
  just a way to hand keys to customers. That is the hard part, and it is worth
  designing before the first tenant rather than after.
- ⚠ **The interim risk is live until then.** One ecosistema bulk-uploading can
  exhaust the rate limit and the budget for all of them, with no signal that
  distinguishes it from an outage. The corpus seed did exactly this. Acceptable
  with few trusted tenants; write down which condition ends it.
- ⚠ **Budget attribution follows keys.** ai-service meters spend per `org` from
  the key. Until keys are per-tenant, per-tenant billing is not derivable from
  anything ai-service records.

### Task 03 is unaffected and still worth doing

It stops being about tenant fairness and becomes two other things: it isolates
this product from other products on the same ai-service, and it is the
foundation the tenant-key system needs — a per-key limiter that does not work is
a per-key limiter that will not work for tenant keys either.
