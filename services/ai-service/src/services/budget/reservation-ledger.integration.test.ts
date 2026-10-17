// `budget_reservations` — the per-hold ledger, on real Postgres.
//
// ── The defect this closes ─────────────────────────────────────────────────
// `budget_state.remaining_usd` is a counter: it knows how much is LEFT and
// nothing about what is HELD. So when a worker died mid-run, the refund had to
// be guessed (`lostReserveUsd`), from one of two numbers on the job row:
//
//   · `metadata.reservePerCallUsd` — ONE pass's estimate. A `maximum`-effort
//     unit takes FOUR holds (generate + refine + 2 extra samples), so this
//     refunds a quarter of the money and strands the rest.
//   · `estimated_cost_usd` — `perCall × validationPasses × multiSample`, which
//     for `maximum` is 6 × perCall against 4 holds actually taken. It credits
//     the org money it never had held.
//
// Both numbers are asserted below AGAINST the ledger's, so this file fails if
// anyone decides the old estimate was close enough.
//
// ── Why the crash is real and not stubbed ──────────────────────────────────
// To leave live holds behind, the router has to stop AFTER its reserves and
// BEFORE its true-up. `CrashingEnforcer` throws from `adjust()` — the exact
// window a `kill -9` lands in — so the ledger rows this test reads were
// written by the REAL `Router` on the REAL reserve path, not seeded by hand.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { generationJobs, generationRequests } from '../../db/schema/index.js';
import { BudgetEnforcer } from './enforcer.js';
import { Router } from '../ai/router/router.js';
import { createProviderResilience } from '../ai/router/resilience.js';
import { RouterCache } from '../ai/router/cache.js';
import { EFFORT_PROFILES } from '../registry/resolve.js';
import { reapLostGenerationJob } from '../../workers/generation.worker.js';
import { createEventBus } from '../events/bus.js';
import type { Db } from '../../db/client.js';
import type {
  callOpenRouter,
  OpenRouterCompletion,
} from '../ai/router/adapters/openrouter.js';

const ORG = 'ledger-org';
const PROJECT = 'ledger-project';
const INITIAL_BUDGET = 10;
const MAXIMUM = EFFORT_PROFILES.maximum;
/** generate + refine + (multiSample − 1) extra samples. */
const EXPECTED_HOLDS = 1 + 1 + (MAXIMUM.multiSample! - 1);
const PER_CALL = MAXIMUM.estimatedCostUsdPerCall;
const COST_PER_CALL = 0.0001;

let db: Db;

async function seedBudget(amountUsd: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${ORG}, ${amountUsd}::numeric, ${amountUsd}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${amountUsd}::numeric,
          "remaining_usd" = ${amountUsd}::numeric
  `);
}

function rows(out: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
  return (out as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

async function remainingUsd(): Promise<number> {
  const out = await db.execute(
    sql`SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${ORG} LIMIT 1`,
  );
  return Number(rows(out)[0]?.['remaining_usd'] ?? NaN);
}

async function ledger(jobId: string): Promise<Array<{ state: string; amount: number }>> {
  const out = await db.execute(sql`
    SELECT "state", "amount_usd" FROM "budget_reservations"
     WHERE "job_id" = ${jobId}
     ORDER BY "created_at"
  `);
  return rows(out).map((r) => ({ state: String(r['state']), amount: Number(r['amount_usd']) }));
}

const okAdapter = (async (opts): Promise<OpenRouterCompletion> => ({
  contentText: '{"ok":true}',
  finishReason: 'stop',
  model: opts.model,
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    costUsd: COST_PER_CALL,
    costSource: 'openrouter',
  },
})) as typeof callOpenRouter;

/** A `kill -9` between the last reserve and the true-up. */
class CrashingEnforcer extends BudgetEnforcer {
  override async adjust(): Promise<void> {
    throw new Error('worker died before the true-up');
  }
}

async function seedJob(): Promise<{ requestId: string; jobId: string; startedAgo: number }> {
  const requestId = (
    await db
      .insert(generationRequests)
      .values({
        org: ORG,
        project: PROJECT,
        status: 'running',
        totalJobs: 1,
        effort: 'maximum',
        estimatedCostUsd: String(PER_CALL * MAXIMUM.validationPasses! * MAXIMUM.multiSample!),
        actualCostUsd: '0',
        startedAt: new Date(),
      })
      .returning({ id: generationRequests.id })
  )[0]!.id;

  const jobId = (
    await db
      .insert(generationJobs)
      .values({
        generationRequestId: requestId,
        org: ORG,
        project: PROJECT,
        unitKey: 'ledger-unit',
        status: 'running',
        attempts: 1,
        effort: 'maximum',
        input: { __renderedPrompt: 'go' },
        // BOTH legacy numbers, so the assertions below can compare against the
        // exact refund each of them would have produced.
        estimatedCostUsd: String(PER_CALL * MAXIMUM.validationPasses! * MAXIMUM.multiSample!),
        metadata: { reservePerCallUsd: PER_CALL },
        startedAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: generationJobs.id })
  )[0]!.id;

  return { requestId, jobId, startedAgo: 60_000 };
}

/** Drive the real router to the point of the crash. Returns the holds it left. */
async function reserveThenCrash(jobId: string): Promise<void> {
  const router = new Router({
    adapter: okAdapter,
    budget: new CrashingEnforcer(db),
    cache: new RouterCache({ max: 4 }),
    resilience: createProviderResilience({ baseDelayMs: 1, maxDelayMs: 5 }),
  });
  await expect(
    router.route({
      label: 'ledger:unit',
      unitKey: 'ledger-unit',
      unitType: 'u',
      org: ORG,
      project: PROJECT,
      generationJobId: jobId,
      messages: [{ role: 'user', content: `go ${jobId}` }],
      model: MAXIMUM.model!,
      effortLevel: 'maximum',
      effortProfile: MAXIMUM,
    }),
  ).rejects.toThrow('worker died before the true-up');
}

describe('budget_reservations (integration)', () => {
  beforeAll(async () => {
    ({ db } = await import('../../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('the router writes one ledger row per hold, and settles them all on a clean true-up', async () => {
    await seedBudget(INITIAL_BUDGET);
    const { jobId } = await seedJob();

    const router = new Router({
      adapter: okAdapter,
      budget: new BudgetEnforcer(db),
      cache: new RouterCache({ max: 4 }),
      resilience: createProviderResilience({ baseDelayMs: 1, maxDelayMs: 5 }),
    });
    await router.route({
      label: 'ledger:unit',
      unitKey: 'ledger-unit',
      unitType: 'u',
      org: ORG,
      project: PROJECT,
      generationJobId: jobId,
      messages: [{ role: 'user', content: `clean ${jobId}` }],
      model: MAXIMUM.model!,
      effortLevel: 'maximum',
      effortProfile: MAXIMUM,
    });

    const held = await ledger(jobId);
    expect(held).toHaveLength(EXPECTED_HOLDS);
    for (const r of held) {
      expect(r.amount).toBeCloseTo(PER_CALL, 9);
      // Every hold is closed out: nothing is left `reserved` for the reaper.
      expect(r.state).toBe('settled');
    }
    // Counter reconciled to the ACTUAL spend, not the estimate.
    expect(await remainingUsd()).toBeCloseTo(INITIAL_BUDGET - EXPECTED_HOLDS * COST_PER_CALL, 6);
  });

  it('🔴 refunds a lost job EXACTLY what the ledger says is held, where both old estimates were wrong', async () => {
    await seedBudget(INITIAL_BUDGET);
    const { jobId } = await seedJob();
    await reserveThenCrash(jobId);

    const live = await ledger(jobId);
    expect(live).toHaveLength(EXPECTED_HOLDS);
    expect(live.every((r) => r.state === 'reserved')).toBe(true);

    const trueHold = EXPECTED_HOLDS * PER_CALL;
    const afterCrash = await remainingUsd();
    expect(afterCrash).toBeCloseTo(INITIAL_BUDGET - trueHold, 6);

    // Both legacy guesses miss, in OPPOSITE directions — this is the whole
    // reason the ledger exists.
    const legacyPerCall = PER_CALL;
    const legacyEstimate = PER_CALL * MAXIMUM.validationPasses! * MAXIMUM.multiSample!;
    expect(legacyPerCall).toBeLessThan(trueHold); // strands 3 of 4 holds
    expect(legacyEstimate).toBeGreaterThan(trueHold); // credits 2 holds too many

    const reaped = await reapLostGenerationJob(jobId, {
      db,
      bus: createEventBus(),
      budget: new BudgetEnforcer(db),
      windowMs: 1_000,
    });
    expect(reaped).toBe(true);

    // The org is made exactly whole — not `−0.014535` short (per-call), and not
    // `+0.00969` over (the estimate).
    expect(await remainingUsd()).toBeCloseTo(INITIAL_BUDGET, 6);
    expect((await ledger(jobId)).every((r) => r.state === 'refunded')).toBe(true);
  });

  it('a second sweep of the same job refunds nothing', async () => {
    await seedBudget(INITIAL_BUDGET);
    const { jobId } = await seedJob();
    await reserveThenCrash(jobId);

    const budget = new BudgetEnforcer(db);
    const bus = createEventBus();
    expect(await reapLostGenerationJob(jobId, { db, bus, budget, windowMs: 1_000 })).toBe(true);
    const afterFirst = await remainingUsd();
    // The guarded UPDATE is the first line; the ledger's `state = 'reserved'`
    // predicate is the second. Either alone would be enough — both is why a
    // concurrent reaper and a `/cancel` cannot double-credit.
    expect(await reapLostGenerationJob(jobId, { db, bus, budget, windowMs: 1_000 })).toBe(false);
    expect(await remainingUsd()).toBeCloseTo(afterFirst, 9);
  });

  it('falls back to the old estimate for a job that predates the ledger', async () => {
    await seedBudget(INITIAL_BUDGET);
    const { jobId } = await seedJob();
    // No ledger rows at all — exactly what every job enqueued before migration
    // 0003 looks like. Money WAS held by the old code path, so simulate that.
    await db.execute(sql`
      UPDATE "budget_state" SET "remaining_usd" = "remaining_usd" - ${PER_CALL}::numeric
       WHERE "org" = ${ORG}
    `);
    expect(await ledger(jobId)).toHaveLength(0);

    await reapLostGenerationJob(jobId, {
      db,
      bus: createEventBus(),
      budget: new BudgetEnforcer(db),
      windowMs: 1_000,
    });

    // `metadata.reservePerCallUsd` wins over `estimated_cost_usd`, unchanged
    // from the pre-ledger behaviour.
    expect(await remainingUsd()).toBeCloseTo(INITIAL_BUDGET, 6);
  });
});
