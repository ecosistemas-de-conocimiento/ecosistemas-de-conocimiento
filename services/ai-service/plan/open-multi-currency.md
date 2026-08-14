> **Status — open (deferred).** Picks up the cross-cutting
> tech debt in `m3-m4-decisions.md` (§2 "Tradeoffs" line and the bottom
> "Cross-cutting open items" list).

# Multi-currency support

Right now, `ai-service` does all of its budget arithmetic in US dollars
and only US dollars. Every per-million-token price is a USD figure;
every reservation, true-up, and refund stamps `currency: 'USD'`; the
budget endpoint reports remaining spend as a USD number. This is fine
today because every consumer is internally funded and the
provider (OpenRouter) bills in USD. The moment a consumer wants to bill
their *own* users in pesos / euros / reais, the service has nowhere to
record that exchange rate or to display non-USD totals. This is a
genuine product gap, not a bug; deferring it costs nothing as long as
we know what we're deferring.

## What "multi-currency support" actually requires

Four roughly-independent pieces, none of which exist today:

1. **Per-org currency column.** Already exists in
   `src/db/schema/index.ts` (`budget_state.currency` is a column;
   `usage_logs.currency` and `traces.cost_currency` are columns). All
   are hardcoded to `'USD'`. The schema is ready; nothing reads or
   writes anything else.

2. **Per-currency `MODEL_PRICING`.** Doesn't exist. `MODEL_PRICING` in
   `src/services/ai/router/task-profiles.ts` is a flat
   `model → { inputPerMillionUsd, outputPerMillionUsd }` map. Going
   multi-currency means either (a) a nested
   `model → currency → prices` map (duplicates whatever conversion was
   used at table-bake time and goes stale immediately), or (b) keep
   the USD table as the source of truth and apply a conversion rate
   at reserve / true-up time.

3. **Conversion rate source.** Decide where the rate comes from. Three
   choices: (a) hardcoded per-org rate column (operator updates
   manually; goes stale); (b) daily fetch from a public FX API
   (introduces a network dep, rate is stale by up-to-24h); (c) live
   fetch on every reserve (kills reproducibility; thrashes the FX
   API). Recommended path is (a) for v1 — most internal use-cases
   tolerate weekly rate updates and operators are happy to set
   `MXN: 17.5` once a week.

4. **Audit-trail rate snapshot per call.** This is the non-obvious
   one. When a call costs $0.12 and the org's currency is MXN at
   17.5, the `usage_logs` row should record *both* the USD cost
   ($0.12) *and* the converted cost (MXN 2.10) *and* the rate used
   (17.5). Otherwise a retrospective audit can't reconstruct the
   numbers. Add columns: `usage_logs.cost_in_org_currency`,
   `usage_logs.fx_rate_applied`. Migration.

## Why this is deferred

Three reasons, all of which would have to change for it to become
urgent:

- **No consumer asks.** A prototype is the only consumer today and it
  internally bills in USD (or doesn't bill at all — the platform owner
  absorbs the cost). Nothing in production is misrepresented by USD-only.
- **It's additive.** Going multi-currency later doesn't break any
  contract — the existing schema columns are already named and typed
  for it. Today's consumer would never notice the change.
- **Atomic-reserve invariant is non-trivial across currencies.** The
  reserve primitive (`UPDATE budget_state SET remaining_usd =
  remaining_usd - $1 WHERE ... AND remaining_usd >= $1 RETURNING ...`)
  operates in one currency. If `budget_state` holds MXN but the cost
  is computed in USD, you either (a) reserve in MXN (then the
  conversion happens *before* the atomic step, opening a small race
  where the rate moved between fetch and reserve), or (b) reserve in
  USD and convert for display (then `budget_state.remaining_usd`
  becomes misleadingly named). Both are solvable; both need a careful
  design pass.

## Acceptance criteria (when it lands)

- An org with `currency = 'MXN'` set has its budget reservations,
  true-ups, refunds, and budget-endpoint responses all consistent in
  MXN.
- `usage_logs` rows for that org record *both* USD cost and converted
  cost, plus the FX rate applied.
- The `MODEL_PRICING` table stays USD-source-of-truth; conversion
  happens at the budget boundary.
- Tests cover: same call charged to a USD org and an MXN org produce
  the same `actual_cost_usd` but different `actual_cost_in_org_currency`.
- The atomic-reserve race window is documented (and ideally collapsed
  to the same statement — see the budget reset implementation for
  the pattern).

## Blockers / risks

- **FX rate provider choice.** Public FX APIs (Frankfurter, ECB,
  exchangerate.host) have varying reliability and licence terms.
  Decide before building.
- **Mixed-currency joins on dashboards.** A "total spend across all
  orgs" view becomes meaningless unless converted to a reporting
  currency. Out of scope for the service itself; consumer concern.
- **Pricing-refresh script.** `scripts/refresh-model-pricing.ts`
  fetches USD figures from OpenRouter. If we ever store non-USD
  prices anywhere, the refresh script's contract changes.

## Estimated cost

Medium. A focused 2–3 days for the schema additions, the budget /
trace plumbing, and the test pass. The harder part is making the
operator UX for "set my org's currency and rate" pleasant; that's
either a registry-write extension or a new admin endpoint.
