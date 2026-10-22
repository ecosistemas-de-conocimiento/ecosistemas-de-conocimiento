// `BudgetEnforcer` against REAL Postgres — the overdraft guard and the lazy
// monthly reset.
//
// ── Why this file exists (audit 2026-10-17, AIS-4) ─────────────────────────
// The unit suite (`enforcer.test.ts`) runs on a fake DB that implements the
// `remaining_usd >= amount` guard ITSELF, and the only check on the real SQL
// was a regex over its text. MEASURED in that audit: rewriting the guard to
// `"remaining_usd" >= 0::numeric` (overspend allowed) left every budget test
// green. These cases run the enforcer's own SQL on the real engine, so the
// same mutation turns them red.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { BudgetEnforcer } from './enforcer.js';
import { BudgetExceeded } from './errors.js';
import type { Db } from '../../db/client.js';

const ORG = 'enforcer-int-org';

let db: Db;

function rows(out: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
  return (out as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

async function seed(opts: {
  limit: number;
  remaining: number;
  nextResetAt?: Date;
  cadence?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state"
      ("org", "limit_usd", "remaining_usd", "reset_cadence", "next_reset_at")
    VALUES (
      ${ORG},
      ${opts.limit}::numeric,
      ${opts.remaining}::numeric,
      ${opts.cadence ?? 'monthly_anniversary'},
      ${opts.nextResetAt ? opts.nextResetAt.toISOString() : null}::timestamptz
    )
  `);
}

async function readRow(): Promise<{ remaining: number; nextResetAt: Date | null }> {
  const out = await db.execute(sql`
    SELECT "remaining_usd", "next_reset_at" FROM "budget_state" WHERE "org" = ${ORG}
  `);
  const r = rows(out)[0]!;
  const next = r['next_reset_at'];
  return {
    remaining: Number(r['remaining_usd']),
    nextResetAt: next === null || next === undefined ? null : new Date(next as string),
  };
}

describe('BudgetEnforcer on real Postgres (integration)', () => {
  beforeAll(async () => {
    ({ db } = await import('../../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('🔴 refuses a reserve larger than remaining, and moves no money', async () => {
    await seed({ limit: 10, remaining: 0.001 });
    const enforcer = new BudgetEnforcer(db);

    const err = await enforcer
      .reserve({ org: ORG, amountUsd: 0.01, traceId: 'overdraft' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);

    expect((await readRow()).remaining).toBeCloseTo(0.001, 9);
    // No ledger hold for a refused reserve: the row is written only after the
    // atomic UPDATE wins.
    const held = await db.execute(
      sql`SELECT 1 FROM "budget_reservations" WHERE "trace_id" = ${'overdraft'}`,
    );
    expect(rows(held)).toHaveLength(0);
  });

  it('a reserve that fits exactly is taken to zero', async () => {
    await seed({ limit: 10, remaining: 0.01 });
    const res = await new BudgetEnforcer(db).reserve({ org: ORG, amountUsd: 0.01 });
    expect(res.remainingUsd).toBeCloseTo(0, 9);
    expect((await readRow()).remaining).toBeCloseTo(0, 9);
  });

  it('🔴 a passed next_reset_at restores remaining to the limit before the reserve', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await seed({ limit: 5, remaining: 0.001, nextResetAt: past });
    const enforcer = new BudgetEnforcer(db);

    // $0.01 does not fit the pre-reset $0.001; it only succeeds if the reset
    // UPDATE ran on the real row first.
    const res = await enforcer.reserve({ org: ORG, amountUsd: 0.01 });
    expect(res.resetOccurred).toBe(true);
    expect(res.remainingUsd).toBeCloseTo(5 - 0.01, 9);

    const row = await readRow();
    expect(row.remaining).toBeCloseTo(5 - 0.01, 9);
    // The boundary moved forward, so the next reserve does not reset again.
    expect(row.nextResetAt!.getTime()).toBeGreaterThan(Date.now());

    // Refund the probe: remaining == limit, which is what the reset promised.
    await enforcer.refund({ org: ORG, amountUsd: 0.01 });
    expect((await readRow()).remaining).toBeCloseTo(5, 9);

    const audit = await db.execute(sql`
      SELECT 1 FROM "usage_logs" WHERE "org" = ${ORG} AND "endpoint" = 'budget-reset'
    `);
    expect(rows(audit)).toHaveLength(1);
  });

  it('a future next_reset_at leaves remaining alone', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seed({ limit: 5, remaining: 1, nextResetAt: future });
    const res = await new BudgetEnforcer(db).reserve({ org: ORG, amountUsd: 0.5 });
    expect(res.resetOccurred).toBeUndefined();
    expect((await readRow()).remaining).toBeCloseTo(0.5, 9);
  });
});
