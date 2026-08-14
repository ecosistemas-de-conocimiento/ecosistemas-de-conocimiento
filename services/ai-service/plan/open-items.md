> **Status.** Index of open follow-up items in `ai-service`.
> Each entry links to a dedicated doc with a plain-language summary at the
> top (per `doc-style.md`) and technical detail below. Scan the summaries
> here, then open whichever rabbit hole you want.

# Open items

## Follow-ups

0. [Drizzle journal `when` trap](open-drizzle-journal-when-trap.md) — Hand-edited `when` timestamps in `drizzle/meta/_journal.json` silently cause subsequent migrations to be skipped on deploy. Hit + fixed today during the budget precision widening; worth a CI assertion so it can't recur.

## More follow-ups

1. [Pricing-refresh cadence](open-pricing-refresh-cadence.md) — Model pricing was just refreshed; decide whether to run `scripts/refresh-model-pricing.ts` on a cron or keep it manual. Next refresh due Q3 2026.
2. [Multi-currency support](open-multi-currency.md) — `budget_state` hardcodes USD; designing a per-org currency + per-currency pricing + audit-trail rate snapshot is deferred until a non-USD consumer needs it.
3. [Organizations table](open-organizations-table.md) — `org` is opaque text everywhere; a real `organizations` table (name, owner, billing email) would unify budgets/rate-limits/audits whenever a UI needs to render org metadata.
4. [API-key rotation](open-api-keys-rotation.md) — `API_KEYS` is a static JSON env var with no rotation or expiry; fine at single-digit scale, but a wider rollout needs a token table + rotation API.
5. [Live smoke against Coolify](open-live-smoke.md) — The deployed `ai-service` on Coolify hasn't been smoke-tested end-to-end yet; a one-time `curl` walkthrough is queued for the next session that has the URL + bearer.

## Pre-existing follow-ups (still open)

6. [Validator-retry escalation tiers](m3-validator-retry-followup.md) — Path from the hardcoded retry cap of 1 to per-project / per-call / per-unitType configurability; adopted in tiers as evidence appears.
7. [HMAC webhook signing](m3-webhook-signing-followup.md) — Design + migration plan for signing `callbackUrl` deliveries; phased rollout from "sign alongside" to "require everywhere".

## Reference / closed-but-load-bearing

8. [M3 DAG tradeoffs](m3-dag-tradeoffs.md) — Rationale for picking BullMQ FlowProducer over manual re-queue or topological waves, plus the back-out diff if Flow becomes a blocker.
9. [Budget-reset follow-up](budget-reset-followup.md) — Design doc that drove the implementation of migration `0007_budget_reset.sql`; kept for the open-questions section ("per-org cadence", "soft cap vs hard stop", "timezone") which are now answered in code.
