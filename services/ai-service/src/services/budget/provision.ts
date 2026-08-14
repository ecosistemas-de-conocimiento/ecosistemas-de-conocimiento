// Budget provisioning — the write half of `budget_state`.
//
// ADR-0003 D5: ai-service is FAIL-CLOSED. An org with no `budget_state` row
// cannot spend a cent — every generation 402s with `BudgetNotConfigured`. Until
// now the ONLY way to lift that gate was `scripts/set-budget.ts`, i.e. shell
// access to the target environment's Postgres. This module is the same
// operation behind an admin-gated endpoint (`PUT /v1/budget/:org`), so standing
// up a tenant no longer needs a DB session.
//
// Semantics are deliberately identical to the script:
//   - INSERT: limit = remaining = cap, `next_reset_at` anchored on the default
//     monthly-anniversary cadence so the lazy-reset path has something to read.
//   - UPDATE: limit := cap. `remaining` is CLAMPED DOWN to the new cap but never
//     raised — lowering a cap must not hand an org free spend — unless the
//     caller passes `refill`, which tops `remaining` back up to the cap.
//   - Idempotent: re-running with the same cap and no `refill` is a no-op.

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { budgetState } from '../../db/schema/index.js';
import { computeNextResetAt } from './reset.js';

export interface SetOrgBudgetInput {
  org: string;
  /** New hard cap in USD. Must be finite and >= 0. */
  limitUsd: number;
  /** Top `remaining_usd` back up to the new cap. Default false. */
  refill?: boolean;
}

export interface SetOrgBudgetResult {
  org: string;
  limitUsd: number;
  remainingUsd: number;
  currency: string;
  /** True when this call created the row (the fail-closed gate just lifted). */
  created: boolean;
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return 0;
}

export async function setOrgBudget(
  db: Db,
  input: SetOrgBudgetInput,
): Promise<SetOrgBudgetResult> {
  const { org, limitUsd, refill = false } = input;
  if (!Number.isFinite(limitUsd) || limitUsd < 0) {
    throw new TypeError('limitUsd must be a finite, non-negative number');
  }
  const cap = limitUsd.toFixed(6);

  const existing = await db
    .select({ org: budgetState.org })
    .from(budgetState)
    .where(eq(budgetState.org, org))
    .limit(1);

  if (existing.length === 0) {
    const nextReset = computeNextResetAt(new Date(), 'monthly_anniversary', 1, 'UTC');
    const inserted = await db
      .insert(budgetState)
      .values({
        org,
        limitUsd: cap,
        remainingUsd: cap,
        ...(nextReset ? { nextResetAt: nextReset } : {}),
      })
      .returning({
        limitUsd: budgetState.limitUsd,
        remainingUsd: budgetState.remainingUsd,
        currency: budgetState.currency,
      });
    const row = inserted[0];
    return {
      org,
      limitUsd: asNumber(row?.limitUsd ?? cap),
      remainingUsd: asNumber(row?.remainingUsd ?? cap),
      currency: row?.currency ?? 'USD',
      created: true,
    };
  }

  const updated = await db
    .update(budgetState)
    .set({
      limitUsd: cap,
      remainingUsd: refill
        ? cap
        : sql`LEAST(${budgetState.remainingUsd}, ${cap}::numeric)`,
      updatedAt: new Date(),
    })
    .where(eq(budgetState.org, org))
    .returning({
      limitUsd: budgetState.limitUsd,
      remainingUsd: budgetState.remainingUsd,
      currency: budgetState.currency,
    });
  const row = updated[0];
  return {
    org,
    limitUsd: asNumber(row?.limitUsd ?? cap),
    remainingUsd: asNumber(row?.remainingUsd ?? cap),
    currency: row?.currency ?? 'USD',
    created: false,
  };
}
