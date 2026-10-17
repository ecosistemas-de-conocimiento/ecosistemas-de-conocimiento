// Stub-db tests for BudgetEnforcer.
//
// We don't have a live Postgres in the M3.4 unit-test window (docker-compose
// lands in M3.7). The enforcer's correctness rests on Postgres' atomic
// UPDATE … WHERE … RETURNING semantics, which we can't fully prove without
// the real DB — but we can verify (1) the SQL shape the enforcer emits, and
// (2) the behavioural contract around bootstrap / underflow / refund / adjust.
//
// The deterministic in-memory `stubDb` simulates the atomic-reserve invariant
// (UPDATE only succeeds if remaining >= amount; both reads and writes serialise
// through a single in-memory map) so we can keep the concurrency test
// shape: two reserves in Promise.all — exactly one wins. TODO: M3.7
// adds a real-DB integration test using docker-compose's pgvector image.

import { sql, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { BudgetEnforcer } from './enforcer.js';
import {
  BudgetExceeded,
  BudgetNotConfigured,
  ERR_BUDGET_EXCEEDED,
  ERR_BUDGET_NOT_CONFIGURED,
} from './errors.js';

interface BudgetRow {
  org: string;
  limit_usd: number;
  remaining_usd: number;
  // 0007_budget_reset columns — optional in seeds for backward compat with
  // tests that only care about the legacy reserve/refund/adjust contract.
  reset_cadence?: string;
  reset_anchor_day?: number;
  reset_tz?: string;
  last_reset_at?: Date | null;
  next_reset_at?: Date | null;
  soft_cap_pct?: number;
  soft_cap_warned_at?: Date | null;
}

interface LlmConfigSeed {
  org: string;
  monthly_budget_usd: number;
  is_active: boolean;
  created_at: number;
}

interface UsageLogRow {
  org: string;
  project: string | null;
  endpoint: string;
  input_tokens: number;
  output_tokens: number;
  actual_cost_usd: number;
  metadata: unknown;
}

function makeStubDb(opts: { llmConfigs?: LlmConfigSeed[]; seedBudgets?: BudgetRow[] }) {
  const budgetRows = new Map<string, BudgetRow>();
  for (const r of opts.seedBudgets ?? []) {
    // Fill in 0007_budget_reset defaults so the read-row helper has something
    // to return. Tests that need non-defaults set them explicitly.
    budgetRows.set(r.org, {
      reset_cadence: 'monthly_anniversary',
      reset_anchor_day: 1,
      reset_tz: 'UTC',
      last_reset_at: null,
      next_reset_at: null,
      soft_cap_pct: 90,
      soft_cap_warned_at: null,
      ...r,
    });
  }
  const llmConfigs = opts.llmConfigs ?? [];
  const usageLogRows: UsageLogRow[] = [];

  // Tracks every SQL chunk concatenated for the most recent call, so tests
  // can assert on the SQL shape the enforcer emitted.
  const calls: string[] = [];

  function isStringChunk(c: unknown): c is { value: string[] } {
    return (
      typeof c === 'object' &&
      c !== null &&
      Array.isArray((c as { value?: unknown }).value)
    );
  }

  function stringify(q: SQL): string {
    // Drizzle's SQL object exposes `.queryChunks`; string fragments are
    // `StringChunk { value: string[] }`, and bind params are passed directly
    // as primitive values (number, string, bigint, etc.) — not wrapped.
    const anyQ = q as unknown as { queryChunks?: unknown[] };
    let s = '';
    for (const c of anyQ.queryChunks ?? []) {
      if (isStringChunk(c)) s += c.value.join('');
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function executeBudgetUpdate(qstr: string, params: unknown[]): unknown {
    // 0007_budget_reset — lazy reset UPDATE.
    //   UPDATE budget_state SET remaining_usd = limit_usd, last_reset_at=..,
    //     next_reset_at=.., soft_cap_warned_at=NULL WHERE org=$ AND next_reset_at=$
    //     RETURNING remaining_usd
    if (qstr.includes('"remaining_usd" = "limit_usd"') && qstr.includes('RETURNING')) {
      const [nowIso, newNextIso, org, observedNextIso] = params as [
        string,
        string | null,
        string,
        string,
      ];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      // Predicate: only flip if the observed next_reset_at still matches.
      const currentIso =
        row.next_reset_at instanceof Date ? row.next_reset_at.toISOString() : null;
      if (currentIso !== observedNextIso) return { rows: [] };
      row.remaining_usd = row.limit_usd;
      row.last_reset_at = new Date(nowIso);
      row.next_reset_at = newNextIso ? new Date(newNextIso) : null;
      row.soft_cap_warned_at = null;
      return { rows: [{ remaining_usd: row.remaining_usd }] };
    }
    // Soft-cap warning stamp.
    //   UPDATE budget_state SET soft_cap_warned_at = $ WHERE org = $
    if (qstr.includes('"soft_cap_warned_at" = ') && !qstr.includes('RETURNING')) {
      const [warnIso, org] = params as [string, string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      row.soft_cap_warned_at = new Date(warnIso);
      return { rows: [] };
    }
    // Decrement: ... WHERE org = ? AND remaining_usd >= ? RETURNING remaining_usd
    if (qstr.includes('"remaining_usd" - ') && qstr.includes('RETURNING')) {
      const [amount, org] = params as [number, string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      if (row.remaining_usd < amount) return { rows: [] };
      row.remaining_usd -= amount;
      return { rows: [{ remaining_usd: row.remaining_usd }] };
    }
    // Clamped increment (refund):
    //   SET remaining_usd = LEAST(remaining_usd + ?, limit_usd) WHERE org = ?
    // Mirrors Postgres' LEAST so an over-refund cannot mint budget in the stub
    // either — without this branch the generic `+` branch below would swallow
    // the refund SQL and the clamp would be untested.
    if (qstr.includes('LEAST(') && qstr.includes('"remaining_usd" + ')) {
      const [amount, org] = params as [number, string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      row.remaining_usd = Math.min(row.remaining_usd + amount, row.limit_usd);
      return { rows: [{ remaining_usd: row.remaining_usd }] };
    }
    // Increment (adjust true-up): ... SET remaining_usd = remaining_usd + ? WHERE org = ?
    if (qstr.includes('"remaining_usd" + ')) {
      const [delta, org] = params as [number, string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      row.remaining_usd += delta;
      return { rows: [{ remaining_usd: row.remaining_usd }] };
    }
    // Bootstrap insert (also seeds `next_reset_at`).
    if (qstr.startsWith('INSERT INTO "budget_state"')) {
      const [org, nextResetIso] = params as [string, string | null];
      if (budgetRows.has(org)) return { rows: [] };
      const seed =
        llmConfigs
          .filter((c) => c.org === org && c.is_active)
          .sort((a, b) => b.created_at - a.created_at)[0]?.monthly_budget_usd ?? 100;
      budgetRows.set(org, {
        org,
        limit_usd: seed,
        remaining_usd: seed,
        reset_cadence: 'monthly_anniversary',
        reset_anchor_day: 1,
        reset_tz: 'UTC',
        last_reset_at: null,
        next_reset_at: nextResetIso ? new Date(nextResetIso) : null,
        soft_cap_pct: 90,
        soft_cap_warned_at: null,
      });
      return { rows: [] };
    }
    // Usage_logs audit row insert (budget-reset trail).
    if (qstr.startsWith('INSERT INTO "usage_logs"')) {
      const [org, endpoint, inputTokens, outputTokens, actualCost, metadata] = params as [
        string,
        string,
        number,
        number,
        number,
        string,
      ];
      usageLogRows.push({
        org,
        project: null,
        endpoint,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        actual_cost_usd: actualCost,
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
      });
      return { rows: [] };
    }
    // Read full row (SELECT limit_usd, remaining_usd, reset_cadence, ...).
    if (qstr.startsWith('SELECT "limit_usd"') && qstr.includes('"reset_cadence"')) {
      const [org] = params as [string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      return {
        rows: [
          {
            limit_usd: row.limit_usd,
            remaining_usd: row.remaining_usd,
            reset_cadence: row.reset_cadence ?? 'monthly_anniversary',
            reset_anchor_day: row.reset_anchor_day ?? 1,
            reset_tz: row.reset_tz ?? 'UTC',
            last_reset_at: row.last_reset_at ?? null,
            next_reset_at: row.next_reset_at ?? null,
            soft_cap_pct: row.soft_cap_pct ?? 90,
            soft_cap_warned_at: row.soft_cap_warned_at ?? null,
          },
        ],
      };
    }
    // SELECT remaining_usd
    if (qstr.startsWith('SELECT "remaining_usd"')) {
      const [org] = params as [string];
      const row = budgetRows.get(org);
      if (!row) return { rows: [] };
      return { rows: [{ remaining_usd: row.remaining_usd }] };
    }
    // rowExists probe: SELECT 1 FROM "budget_state" WHERE org = ? LIMIT 1
    if (qstr.startsWith('SELECT 1 FROM "budget_state"')) {
      const [org] = params as [string];
      return budgetRows.has(org) ? { rows: [{ '?column?': 1 }] } : { rows: [] };
    }
    throw new Error(`stubDb: unrecognised query: ${qstr}`);
  }

  const db = {
    execute(q: SQL) {
      const qstr = stringify(q);
      const qAny = q as unknown as { queryChunks?: unknown[] };
      // Bind params: every chunk that ISN'T a StringChunk is a primitive
      // (number, string, bigint, …) passed directly through the tagged
      // template — in insertion order.
      const params: unknown[] = [];
      for (const c of qAny.queryChunks ?? []) {
        if (!isStringChunk(c)) params.push(c);
      }
      calls.push(qstr);
      return Promise.resolve(executeBudgetUpdate(qstr, params));
    },
  } as unknown as Db;

  return { db, budgetRows, calls, usageLogRows };
}

describe('BudgetEnforcer.reserve', () => {
  it('decrements remaining atomically and returns new balance', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org-rich', limit_usd: 100, remaining_usd: 100 }],
    });
    const enforcer = new BudgetEnforcer(db);
    const { remainingUsd } = await enforcer.reserve({ org: 'org-rich', amountUsd: 25 });
    expect(remainingUsd).toBe(75);
    expect(budgetRows.get('org-rich')?.remaining_usd).toBe(75);
  });

  it('throws BudgetExceeded when remaining < amount', async () => {
    const { db } = makeStubDb({
      seedBudgets: [{ org: 'org-poor', limit_usd: 10, remaining_usd: 0.5 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await expect(enforcer.reserve({ org: 'org-poor', amountUsd: 5 })).rejects.toMatchObject({
      code: ERR_BUDGET_EXCEEDED,
      org: 'org-poor',
      requested: 5,
      remaining: 0.5,
      shortfallUsd: 4.5,
    });
  });

  it('BudgetExceeded is the expected class', async () => {
    const { db } = makeStubDb({
      seedBudgets: [{ org: 'org-poor', limit_usd: 10, remaining_usd: 0 }],
    });
    const enforcer = new BudgetEnforcer(db);
    try {
      await enforcer.reserve({ org: 'org-poor', amountUsd: 1 });
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceeded);
    }
  });

  // FAIL-CLOSED (ADR-0003 D5): an org with NO budget_state row is rejected with
  // BudgetNotConfigured instead of the old silent $100 (or llm_configs) bootstrap.
  it('fail-closed: reserve against an unconfigured org throws BudgetNotConfigured', async () => {
    const { db, budgetRows, calls } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    await expect(
      enforcer.reserve({ org: 'org-unconfigured', amountUsd: 7 }),
    ).rejects.toMatchObject({
      code: ERR_BUDGET_NOT_CONFIGURED,
      org: 'org-unconfigured',
    });
    // No row was fabricated.
    expect(budgetRows.has('org-unconfigured')).toBe(false);
    // No INSERT bootstrap was issued.
    expect(calls.find((c) => c.startsWith('INSERT INTO "budget_state"'))).toBeUndefined();
  });

  it('fail-closed error is the BudgetNotConfigured class with a clear message', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    try {
      await enforcer.reserve({ org: 'ghost-org', amountUsd: 1 });
      throw new Error('should not reach');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetNotConfigured);
      expect((e as Error).message).toBe('no budget configured for org ghost-org');
    }
  });

  it('amountUsd = 0 is a free call against a CONFIGURED org: no UPDATE issued', async () => {
    const { db, calls } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 100 }],
    });
    const enforcer = new BudgetEnforcer(db);
    const { remainingUsd } = await enforcer.reserve({ org: 'org', amountUsd: 0 });
    expect(remainingUsd).toBe(100);
    expect(calls.find((c) => c.includes('"remaining_usd" -'))).toBeUndefined();
  });

  it('amountUsd = 0 is still fail-closed against an unconfigured org', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    await expect(enforcer.reserve({ org: 'no-budget', amountUsd: 0 })).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );
  });

  it('negative amount rejects loudly', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    await expect(enforcer.reserve({ org: 'org', amountUsd: -1 })).rejects.toThrow(/>= 0/);
  });

  it('concurrent reserves: exactly one wins when balance only covers one', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org-tight', limit_usd: 10, remaining_usd: 10 }],
    });
    const enforcer = new BudgetEnforcer(db);

    const results = await Promise.allSettled([
      enforcer.reserve({ org: 'org-tight', amountUsd: 6 }),
      enforcer.reserve({ org: 'org-tight', amountUsd: 6 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(budgetRows.get('org-tight')?.remaining_usd).toBe(4);
  });
});

describe('BudgetEnforcer.refund', () => {
  it('increments remaining', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 50 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.refund({ org: 'org', amountUsd: 10 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(60);
  });

  it('no-ops for non-positive amounts', async () => {
    const { db, budgetRows, calls } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 50 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.refund({ org: 'org', amountUsd: 0 });
    await enforcer.refund({ org: 'org', amountUsd: -5 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(50);
    expect(calls).toHaveLength(0);
  });

  it('never errors when no row exists', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    await expect(enforcer.refund({ org: 'no-such-org', amountUsd: 10 })).resolves.toBeUndefined();
  });

  // F11 — an unclamped refund MINTS budget. A refund credits money that was
  // supposedly held, but nothing proves it was: refund twice, or refund a hold
  // whose reserve was already released, and `remaining` climbs past the cap.
  it('clamps at limit_usd: an over-refund lands exactly on the cap, never above', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 10, remaining_usd: 9.9 }],
    });
    const enforcer = new BudgetEnforcer(db);
    // Refund far more than was ever reserved.
    await enforcer.refund({ org: 'org', amountUsd: 5 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(10);
    expect(budgetRows.get('org')?.remaining_usd).toBeLessThanOrEqual(10);
  });

  it('clamps at limit_usd: a double refund cannot exceed the cap', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 10, remaining_usd: 9 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.refund({ org: 'org', amountUsd: 1 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(10);
    // Second (spurious) refund of the same hold — the money is already back.
    await enforcer.refund({ org: 'org', amountUsd: 1 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(10);
  });

  it('a refund that stays inside the cap still credits the FULL amount', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 40 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.refund({ org: 'org', amountUsd: 12.5 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(52.5);
  });

  it('emits the clamp in the SQL, as ONE statement (no read-then-write)', async () => {
    const { db, calls } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 10, remaining_usd: 5 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.refund({ org: 'org', amountUsd: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/LEAST\(\s*"remaining_usd" \+ .*"limit_usd"\s*\)/);
  });
});

describe('BudgetEnforcer.adjust', () => {
  it('applies positive delta (true-up refund)', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 80 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.adjust({ org: 'org', deltaUsd: 5 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(85);
  });

  it('applies negative delta and can push below zero (no floor)', async () => {
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 1 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.adjust({ org: 'org', deltaUsd: -3 });
    expect(budgetRows.get('org')?.remaining_usd).toBe(-2);
  });

  it('no-ops on near-zero delta', async () => {
    const { db, calls } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 50 }],
    });
    const enforcer = new BudgetEnforcer(db);
    await enforcer.adjust({ org: 'org', deltaUsd: 1e-12 });
    expect(calls).toHaveLength(0);
  });
});

describe('BudgetEnforcer.getRemaining', () => {
  it('returns 0 when no row exists', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    expect(await enforcer.getRemaining('absent-org')).toBe(0);
  });

  it('returns the current remaining_usd', async () => {
    const { db } = makeStubDb({
      seedBudgets: [{ org: 'org', limit_usd: 100, remaining_usd: 42.5 }],
    });
    const enforcer = new BudgetEnforcer(db);
    expect(await enforcer.getRemaining('org')).toBe(42.5);
  });
});

describe('BudgetEnforcer — SQL shape (sanity)', () => {
  // Touch-test that the SQL the enforcer emits contains the atomic-reserve
  // shape. If someone refactors the enforcer to use raw drizzle insert/update
  // builders, this test breaks — that's the warning. The real correctness
  // proof for the atomic SQL lives in the M3.7 integration tests against a
  // real Postgres.
  let calls: string[];
  let enforcer: BudgetEnforcer;
  beforeEach(() => {
    const stub = makeStubDb({ seedBudgets: [{ org: 'o', limit_usd: 100, remaining_usd: 100 }] });
    calls = stub.calls;
    enforcer = new BudgetEnforcer(stub.db);
  });
  afterEach(() => {
    calls.length = 0;
  });

  it('reserve emits an UPDATE … RETURNING remaining_usd', async () => {
    await enforcer.reserve({ org: 'o', amountUsd: 1 });
    const seen = calls.join(' | ');
    expect(seen).toMatch(/UPDATE "budget_state"/);
    expect(seen).toMatch(/RETURNING "remaining_usd"/);
    expect(seen).toMatch(/"remaining_usd" - /);
    expect(seen).toMatch(/"remaining_usd" >= /);
  });
});

// ---------------------------------------------------------------------------
// 0007_budget_reset — lazy reset + soft cap
// ---------------------------------------------------------------------------

describe('BudgetEnforcer — lazy reset (0007_budget_reset)', () => {
  it('no reset when next_reset_at is in the future', async () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const { db, budgetRows, usageLogRows } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 60,
          reset_cadence: 'monthly_anniversary',
          reset_anchor_day: 1,
          reset_tz: 'UTC',
          next_reset_at: future,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 5 });
    expect(result.remainingUsd).toBe(55);
    expect(result.resetOccurred).toBeUndefined();
    expect(budgetRows.get('org')?.remaining_usd).toBe(55);
    expect(usageLogRows).toHaveLength(0);
  });

  it('resets when next_reset_at has passed; remaining=limit-amount, audit row written', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const { db, budgetRows, usageLogRows } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 12,
          reset_cadence: 'monthly_anniversary',
          reset_anchor_day: 1,
          reset_tz: 'UTC',
          next_reset_at: past,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 5 });
    expect(result.resetOccurred).toBe(true);
    // After reset: remaining = limit (100); reserve takes 5 → 95.
    expect(result.remainingUsd).toBe(95);
    expect(budgetRows.get('org')?.remaining_usd).toBe(95);
    expect(budgetRows.get('org')?.soft_cap_warned_at).toBeNull();
    // Audit row written.
    expect(usageLogRows).toHaveLength(1);
    expect(usageLogRows[0]?.endpoint).toBe('budget-reset');
    const meta = usageLogRows[0]?.metadata as Record<string, unknown>;
    expect(meta?.['resetFrom']).toBe(12);
    expect(meta?.['resetTo']).toBe(100);
    expect(meta?.['cadence']).toBe('monthly_anniversary');
  });

  it("'never' cadence never resets, even with past next_reset_at", async () => {
    const past = new Date(2020, 0, 1);
    const { db, budgetRows, usageLogRows } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 10,
          reset_cadence: 'never',
          next_reset_at: past,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 5 });
    expect(result.remainingUsd).toBe(5);
    expect(result.resetOccurred).toBeUndefined();
    expect(budgetRows.get('org')?.remaining_usd).toBe(5);
    expect(usageLogRows).toHaveLength(0);
  });
});

describe('BudgetEnforcer — soft cap (0007_budget_reset)', () => {
  it('reserve returns softCap=true when remaining drops below threshold', async () => {
    // limit=100, soft_cap_pct=90 ⇒ warn threshold = 100 * (1 - 0.9) = 10.
    // After reserve from 12 → 5, 5 < 10, so softCap fires.
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const { db } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 12,
          soft_cap_pct: 90,
          next_reset_at: future,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 7 });
    expect(result.remainingUsd).toBe(5);
    expect(result.softCap).toBe(true);
  });

  it('throttles soft-cap: second reserve within 5 min suppresses the flag', async () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const { db, budgetRows } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 12,
          soft_cap_pct: 90,
          next_reset_at: future,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const first = await enforcer.reserve({ org: 'org', amountUsd: 5 });
    expect(first.softCap).toBe(true);
    expect(budgetRows.get('org')?.soft_cap_warned_at).toBeInstanceOf(Date);
    const stamped = budgetRows.get('org')?.soft_cap_warned_at;
    const second = await enforcer.reserve({ org: 'org', amountUsd: 1 });
    expect(second.softCap).toBe(false);
    // Throttle: warned_at not advanced.
    expect(budgetRows.get('org')?.soft_cap_warned_at).toBe(stamped);
  });

  it('soft_cap_pct=100 disables the warning entirely', async () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const { db } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 1,
          soft_cap_pct: 100,
          next_reset_at: future,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 0.5 });
    expect(result.softCap).toBe(false);
  });

  it('softCap remains false when remaining is above the threshold', async () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const { db } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 90,
          soft_cap_pct: 90,
          next_reset_at: future,
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    const result = await enforcer.reserve({ org: 'org', amountUsd: 5 });
    // After: 85, threshold is 10; 85 >= 10 → no softCap.
    expect(result.remainingUsd).toBe(85);
    expect(result.softCap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSoftCap — the PROJECTED remaining, not the current one
//
// 🔴 THE REGRESSION THIS PINS. The async `/v1/generate` path used to reserve
// the whole batch estimate, and the soft-cap warning fell out of that reserve —
// i.e. it was evaluated on the POST-spend remaining, so the batch that CROSSES
// the threshold is the batch that warns. When the leaking batch reserve was
// removed, `checkSoftCap` replaced it but judged the PRE-spend remaining, which
// warns one batch too late: the crossing batch says nothing.
//
// MEASURED on real Postgres — limit 100, soft_cap_pct 90 (⇒ threshold 10),
// remaining 10.5, batch estimate 1.0: the old post-reserve evaluation fires
// (9.5 < 10); the pre-spend evaluation does not (10.5 >= 10). a consumer can treat this
// warning as "the one advance notice", so the miss is consumer-visible.
//
// These cases run the REAL enforcer against the stub db. A `vi.fn()` returning
// `softCap: true` would have passed throughout the regression.
// ---------------------------------------------------------------------------

describe('BudgetEnforcer.checkSoftCap — evaluated on remaining MINUS the estimate', () => {
  const FUTURE = () => new Date(Date.now() + 24 * 3600 * 1000);
  /** limit 100 @ soft_cap_pct 90 ⇒ warn threshold = 100 × (1 − 0.9) = 10. */
  function seedCrossingRow() {
    return makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 10.5,
          soft_cap_pct: 90,
          next_reset_at: FUTURE(),
        },
      ],
    });
  }

  it('🔴 warns on the batch that CROSSES the threshold (10.5 − 1.0 = 9.5 < 10)', async () => {
    const { db } = seedCrossingRow();
    const enforcer = new BudgetEnforcer(db);
    expect(await enforcer.checkSoftCap('org', 1.0)).toBe(true);
  });

  it('without the estimate the SAME row does not warn — the pre-spend bug, pinned', async () => {
    const { db } = seedCrossingRow();
    const enforcer = new BudgetEnforcer(db);
    // 10.5 >= 10. This is exactly what the crossing batch used to report, and
    // is why the estimate has to be passed in.
    expect(await enforcer.checkSoftCap('org')).toBe(false);
  });

  it('a batch too small to cross the threshold still does not warn', async () => {
    const { db } = seedCrossingRow();
    const enforcer = new BudgetEnforcer(db);
    // 10.5 − 0.2 = 10.3 >= 10.
    expect(await enforcer.checkSoftCap('org', 0.2)).toBe(false);
  });

  it('moves no money, but stamps the throttle so the next probe stays quiet', async () => {
    const { db, budgetRows } = seedCrossingRow();
    const enforcer = new BudgetEnforcer(db);
    expect(await enforcer.checkSoftCap('org', 1.0)).toBe(true);
    // `remaining_usd` untouched — the probe is not a reserve.
    expect(budgetRows.get('org')?.remaining_usd).toBe(10.5);
    // …but `soft_cap_warned_at` IS written: that is the 5-minute throttle, and
    // it is why the doc comment no longer claims "read-only".
    expect(budgetRows.get('org')?.soft_cap_warned_at).toBeInstanceOf(Date);
    expect(await enforcer.checkSoftCap('org', 1.0)).toBe(false);
  });

  it('a negative estimate cannot inflate remaining and suppress a due warning', async () => {
    const { db } = makeStubDb({
      seedBudgets: [
        {
          org: 'org',
          limit_usd: 100,
          remaining_usd: 5,
          soft_cap_pct: 90,
          next_reset_at: FUTURE(),
        },
      ],
    });
    const enforcer = new BudgetEnforcer(db);
    // 5 is already below the threshold of 10; −100 must be clamped to 0.
    expect(await enforcer.checkSoftCap('org', -100)).toBe(true);
  });

  it('an org with no budget_state row never warns', async () => {
    const { db } = makeStubDb({});
    const enforcer = new BudgetEnforcer(db);
    expect(await enforcer.checkSoftCap('missing-org', 1.0)).toBe(false);
  });
});

// Silence unused-import warnings — the import is intentional so the stub's
// `stringify` can use `SQL`. We don't actually call `sql` from tests.
void sql;
