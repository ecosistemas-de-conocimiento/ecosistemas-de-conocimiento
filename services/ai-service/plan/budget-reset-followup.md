# Budget reset policy — design follow-up

> **Status.** Design doc only. No migration, no code beyond the
> `/v1/embed` atomic-reserve fix that landed alongside this note. Picks up the
> tech-debt item flagged in `plan/m3-m4-decisions.md` §2 and the cross-cutting
> list at the bottom of that file.

## Current state

`budget_state.remaining_usd` is bootstrapped once and only decreases.
`BudgetEnforcer.reserve` (see `src/services/budget/enforcer.ts`) seeds the row
on first call from `llm_configs.monthly_budget_usd` (falling back to the
schema default of 100 USD) and then atomically decrements it. There is no
automatic top-up. Once an org reaches zero, the only path back to a working
budget is a manual `BudgetEnforcer.adjust({ deltaUsd: + X })` invocation —
there is no scheduled job, no per-org reset anchor, and no rolling-window
re-derivation. Decision §2 explicitly flagged this: *"monthly reset (rolling
30d? calendar month?) isn't specified — currently the budget is set once and
decremented forever until someone manually adjusts it. Tech debt: no reset
policy."*

## Why a reset policy matters

ai-service consumers expect a budget that behaves like a SaaS spending cap:
"I have $X to spend this month, then it resets." Without that, a consumer
running a steady workload hits zero on some unknown day and silently starts
failing `BudgetExceeded` until somebody notices and runs a manual adjust.
This is a production-realism gap, not a correctness bug — the atomic-reserve
guarantee still holds — but it makes ai-service unusable in any setting where
the operator isn't continuously watching budget_state.

## Three design options

### Option 1 — Calendar month reset

At 00:00 UTC on the 1st of each month, a cron job (or a lazy check on every
`reserve`) resets every org's `remaining_usd` back to `limit_usd`. Simple,
predictable, mental-model matches SaaS billing.

- **Pros:** standard. One semantic everybody understands. Cron-driven path is
  ~50 lines; lazy-check path is ~5 lines inside `reserve`.
- **Cons:** hot job (all orgs reset at once); calendar drift across consumer
  timezones; consumers running a batch that straddles 00:00 UTC on the 1st
  can hit confusing race conditions (one half of the batch reserves against
  the old remaining, the other half against the freshly-reset remaining).

### Option 2 — Anniversary reset

Each org carries a `reset_anchor_day` (1–28) plus a `last_reset_at`. Whenever
that day rolls around in the org's local frame the row resets. Requires a
nightly scan ("which orgs are due today?") or — same as option 1 — lazy
semantics on every `reserve`.

- **Pros:** smoother load (resets are spread across the month); matches each
  customer's billing anniversary so the budget cycle aligns with their
  invoice.
- **Cons:** more schema; one more column on `budget_state`; harder to reason
  about ("when does this org reset?" requires a row lookup, not a calendar
  glance); per-tenant timezone handling is awkward unless we punt to UTC.

### Option 3 — Rolling 30d window

Drop the `remaining_usd` column. On every `reserve`, recompute as
`limit_usd − SUM(usage_logs.actual_cost_usd WHERE created_at > now() -
interval '30 days')`. No cron, no boundaries, no resets — the budget is
always exactly the last 30 days of spend.

- **Pros:** continuously self-correcting; zero boundary races; no cron infra;
  the audit table is the source of truth.
- **Cons:** every reserve becomes a SUM-over-recent-`usage_logs` query
  (expensive at scale; partially mitigated by an index on `(org, created_at)`).
  **Critically: atomic reserve is lost.** The current invariant — "two
  concurrent callers cannot both succeed when only one of them fits the
  budget" — relies on the `UPDATE … RETURNING` predicate in `enforcer.ts`.
  A rolling-sum approach would have to wrap reserve + the eventual usage_log
  insert in a serializable transaction, and even then two concurrent bursts
  read the same SUM before either insert lands. Prototype-style concurrency tests
  (the ones we ported to `src/services/budget/enforcer.test.ts`) would no
  longer pass.

## Implementation comparison

| | Calendar | Anniversary | Rolling 30d |
|---|---|---|---|
| Schema change | none (or `+next_reset_at`) | `+reset_anchor_day, +last_reset_at` | drop `remaining_usd` (or make it a cached view) |
| Cron required | yes (1st of month) or lazy | yes (daily scan) or lazy | no |
| Atomic reserve | preserved | preserved | **LOST** |
| Tenant fairness | low (boundary spikes) | high | high |
| Debug complexity | low (one cron log) | medium | high (depends on usage_logs retention/freshness) |
| Per-tenant config | none | required | none |

## Recommendation

**Start with calendar-month reset (option 1), implemented via lazy semantics
on every `reserve()` rather than a global cron.**

The reasoning:

1. **Simplest mental model.** Consumers don't have to think about a per-tenant
   anchor day; ops doesn't have to think about a hot cron.
2. **Preserves the atomic-reserve invariant.** The reset is just one more
   atomic SQL statement (`UPDATE budget_state SET remaining_usd = limit_usd,
   last_reset_at = now(), next_reset_at = … WHERE org = $ AND next_reset_at
   <= now()`), running in the same transaction as the reserve. A prototype's tests
   still pass.
3. **Lazy beats cron.** No "what if the cron didn't run?" question. No hot
   simultaneous reset of every org. The first caller in a new month pays the
   tiny extra UPDATE; everyone after that hits the normal hot path.
4. **Anniversary is the right answer later.** When customers complain about
   boundary spikes or when invoicing aligns to a non-1st-of-the-month cycle,
   migrate to option 2. The migration is additive: `reset_anchor_day` and
   `last_reset_at` columns, with a backfill default of `1` and `now()`.

**Rolling 30d is the wrong shape for ai-service.** Losing atomic-reserve
means losing the budget guarantee the test suite (and the chat router's
`reserve`/`adjust` bracket) rely on. It's a fine policy for a billing
read-model, not for the live spend gate.

## Concrete next-step task

For whoever picks this up:

1. Add migration `0007_budget_reset.sql`:
   - `ALTER TABLE budget_state ADD COLUMN last_reset_at timestamptz NOT NULL DEFAULT now()`;
   - `ALTER TABLE budget_state ADD COLUMN next_reset_at timestamptz NOT NULL DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')`.
2. Add a `BudgetReset` helper (or inline it on `BudgetEnforcer`) that on every
   `reserve()` first checks `now() >= next_reset_at` and atomically resets if
   so:
   ```sql
   UPDATE budget_state
      SET remaining_usd = limit_usd,
          last_reset_at = now(),
          next_reset_at = date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month',
          updated_at = now()
    WHERE org = $1 AND next_reset_at <= now()
   ```
   Run this BEFORE `tryReserve`. It either resets exactly once or no-ops.
3. Test (`enforcer.test.ts`): seed a row with `next_reset_at = now() − 1
   second`, call `reserve(1)`, assert `remaining_usd` came back to `limit_usd
   − 1`. Bonus: assert concurrent first-callers cannot double-reset (single
   `UPDATE` is naturally idempotent under the predicate).
4. Append an audit row in `usage_logs` with `endpoint: 'budget-reset'` so
   resets show up in the budget view alongside spend.

Estimated work: ~80 lines of code + ~30 lines of test. Migration is one file.

## Open questions / asks for the user

- **Per-org configurable or globally fixed?** A `reset_cadence` enum on
  `llm_configs` (`monthly_calendar` | `anniversary` | `manual`) would punt
  the option-1-vs-2 decision to per-org config. Annoying to support; useful
  if a single tenant has a hard requirement that diverges from the default.
  Recommendation: ship globally fixed (option 1) first; revisit if a tenant
  asks.
- **Hard-stop vs. soft-cap-with-grace-period?** Today's behaviour is hard-stop
  at zero. A nicer UX is "soft cap at 90% — log a warning to `usage_logs`
  but allow the call; hard cap at 100%". Adds one column (`soft_cap_pct`)
  and one branch in `reserve`. Decide before option 1 lands so we don't ship
  a reset and then immediately migrate again.
- **Timezone.** Calendar-month reset in UTC is the obvious default but
  consumers in non-UTC regions may have opinions. Punt to a future per-org
  `reset_tz` column if it ever comes up; UTC for v1.
- **What happens to in-flight reservations across a reset boundary?** A
  caller who reserved at 23:59:59 on the last day of the month and is still
  waiting on the LLM response at 00:00:01 the next day will call `adjust`
  against a reset row. The math still works (delta is small) but the audit
  trail will show a confusing "spend after reset". Worth a note in the
  README.
