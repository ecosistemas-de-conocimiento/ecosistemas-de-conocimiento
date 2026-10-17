// Batch-reserve leak test (real Postgres) — ADR-0003 Track 1 / D5.
//
// ── The defect ─────────────────────────────────────────────────────────────
// `enqueueGeneration` reserved the WHOLE-request estimate inside its insert
// transaction, and nothing in the service ever released it: the only
// refund/adjust callers are the router (its own PER-CALL reserve/true-up) and
// `routes/embed.ts`. So every batch subtracted its estimate from
// `budget_state.remaining_usd` FOREVER, on top of the real spend.
//
// MEASURED before the fix: remaining 10 → 9.999263 after POST /v1/generate,
// still 9.999263 after the job completed with an actual cost of 0; on a
// 2-trace run remaining ended at 10 − 0.000737 − 0.000106 — the stranded
// estimate sitting on top of the real cost.
//
// ── The invariant ──────────────────────────────────────────────────────────
//   after a batch settles:  remaining_usd == initial − Σ(actual cost)
// with Σ(actual cost) read from the trace rows the router actually wrote, not
// from anything the orchestrator predicted.
//
// Why integration: the leak is a difference between what the enqueue path
// subtracts and what the execution path gives back. Only a real
// `budget_state` row, a real router and real trace rows can show the two agree.
//
// ⚠ FAIL-CLOSED IS NOT RELAXED, and the second case proves it: an org with no
// `budget_state` row is still refused UP FRONT, before any row is inserted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { generationJobs, generationRequests, traces } from '../../db/schema/index.js';
import { createRouter } from '../ai/router/router.js';
import { TraceWriter } from '../ai/router/trace-writer.js';
import { BudgetEnforcer } from '../budget/enforcer.js';
import { BudgetNotConfigured } from '../budget/errors.js';
import { createEventBus } from '../events/bus.js';
import { createTestRuntime } from '../../testing/runtime.js';
import type { Runtime } from '../../runtime.js';
import { processGenerationJob } from '../../workers/generation.worker.js';
import { enqueueGeneration } from './orchestrator.js';
import type { Db } from '../../db/client.js';
import type { GenerateRequest } from '../../types/generation.js';
import type {
  callOpenRouter,
  OpenRouterCompletion,
} from '../ai/router/adapters/openrouter.js';

const ORG = 'reserve-leak-org';
const PROJECT = 'reserve-leak-project';
const UNCONFIGURED_ORG = 'reserve-leak-no-budget-org';
const SOFT_CAP_ORG = 'soft-cap-crossing-org';
const CALL_COST = 0.0011;
const INITIAL_BUDGET = 10;

function makeAdapter(): typeof callOpenRouter {
  return (async (opts): Promise<OpenRouterCompletion> => ({
    contentText: 'fine output',
    finishReason: 'stop',
    model: opts.model,
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      costUsd: CALL_COST,
      costSource: 'openrouter',
    },
  })) as typeof callOpenRouter;
}

async function seedBudget(db: Db, org: string, amountUsd: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${org}, ${amountUsd}::numeric, ${amountUsd}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${amountUsd}::numeric,
          "remaining_usd" = ${amountUsd}::numeric
  `);
}

/**
 * Seed a row where limit ≠ remaining and the soft cap is explicit. The default
 * `seedBudget` sets remaining = limit, which can never be near a soft cap.
 */
async function seedSoftCapRow(
  db: Db,
  org: string,
  opts: { limitUsd: number; remainingUsd: number; softCapPct: number },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd", "soft_cap_pct")
    VALUES (
      ${org},
      ${opts.limitUsd}::numeric,
      ${opts.remainingUsd}::numeric,
      ${opts.softCapPct}::numeric
    )
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${opts.limitUsd}::numeric,
          "remaining_usd" = ${opts.remainingUsd}::numeric,
          "soft_cap_pct" = ${opts.softCapPct}::numeric,
          "soft_cap_warned_at" = NULL
  `);
}

async function clearBudget(db: Db, org: string): Promise<void> {
  await db.execute(sql`DELETE FROM "budget_state" WHERE "org" = ${org}`);
}

async function remainingUsd(db: Db, org: string): Promise<number> {
  const out = await db.execute(sql`
    SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${org} LIMIT 1
  `);
  const rows = Array.isArray(out)
    ? (out as Array<Record<string, unknown>>)
    : ((out as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  return Number(rows[0]?.['remaining_usd'] ?? NaN);
}

const SPEC_OVERRIDE = {
  promptTemplate: 'generate {{thing}}',
  effortLevel: 'standard' as const,
  model: 'mock/model',
  validators: [],
};

describe('generation batch budget accounting (integration, real Postgres)', () => {
  let db: Db;
  // Was `_resetQueuesForTests()` before each case; a fresh runtime per case is
  // the same isolation without module-scope state.
  let runtime: Runtime;

  beforeAll(async () => {
    ({ db } = await import('../../db/client.js'));
  });

  afterAll(async () => {
    await runtime?.close();
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('remaining_usd after a completed batch equals initial − Σ(actual cost)', async () => {
    runtime = createTestRuntime();
    await seedBudget(db, ORG, INITIAL_BUDGET);

    const req: GenerateRequest = {
      units: [
        { unitKey: 'u1', input: { thing: 'one' }, specOverride: SPEC_OVERRIDE },
        { unitKey: 'u2', input: { thing: 'two' }, specOverride: SPEC_OVERRIDE },
      ],
    };

    const launch = await enqueueGeneration(
      req,
      { org: ORG, project: PROJECT },
      {
        db,
        queue: runtime.queues.generation,
        flow: runtime.queues.flow,
        bus: createEventBus(),
      },
    );

    // 🔴 THE ENQUEUE ITSELF MUST NOT MOVE MONEY. Before the fix this line read
    // 9.999263 for a 10.0 budget — the stranded whole-batch estimate.
    expect(await remainingUsd(db, ORG)).toBeCloseTo(INITIAL_BUDGET, 6);
    expect(launch.totalJobs).toBe(2);

    const jobRows = await db
      .select({ id: generationJobs.id, unitKey: generationJobs.unitKey })
      .from(generationJobs)
      .where(eq(generationJobs.generationRequestId, launch.requestId));
    expect(jobRows).toHaveLength(2);

    const router = createRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
      adapter: makeAdapter(),
    });
    const bus = createEventBus();
    for (const job of jobRows) {
      await processGenerationJob(
        {
          id: `q-${job.unitKey}`,
          data: {
            jobId: job.id,
            generationRequestId: launch.requestId,
            org: ORG,
            project: PROJECT,
            unitKey: job.unitKey,
          },
        },
        { db, router, bus },
      );
    }

    // Σ(actual) read off the rows the router really wrote.
    const traceRows = await db
      .select({ actualCostUsd: traces.actualCostUsd })
      .from(traces)
      .where(eq(traces.generationRequestId, launch.requestId));
    expect(traceRows.length).toBeGreaterThan(0);
    const spent = traceRows.reduce((acc, t) => acc + Number(t.actualCostUsd ?? 0), 0);

    // ── THE INVARIANT ──
    expect(await remainingUsd(db, ORG)).toBeCloseTo(INITIAL_BUDGET - spent, 6);

    // And the request rollup agrees with the same Σ.
    const reqAfter = await db
      .select({
        actualCostUsd: generationRequests.actualCostUsd,
        status: generationRequests.status,
      })
      .from(generationRequests)
      .where(eq(generationRequests.id, launch.requestId))
      .limit(1);
    expect(Number(reqAfter[0]!.actualCostUsd)).toBeCloseTo(spent, 6);
    expect(reqAfter[0]!.status).toBe('completed');
  });

  /**
   * 🔴 THE SOFT-CAP WARNING MUST FIRE ON THE BATCH THAT CROSSES THE THRESHOLD.
   *
   * The old batch reserve evaluated the soft cap on the POST-reserve remaining,
   * so the crossing batch is the one that warns. When the leaking reserve was
   * dropped, the replacement probe judged the PRE-spend remaining — which warns
   * one batch late, and a consumer can treat this as its one advance notice.
   *
   * The numbers here are the measured ones: limit 100, soft_cap_pct 90 ⇒ warn
   * threshold 100 × (1 − 0.9) = 10; remaining 10.5; batch estimate 1.0.
   *   post-spend:  10.5 − 1.0 = 9.5  <  10  ⇒ warns   (correct)
   *   pre-spend:   10.5            >=  10  ⇒ silent  (the regression)
   *
   * The estimate is pinned by an inline `effortProfile` — `clampCallerLimits`
   * only FLOORS `estimatedCostUsdPerCall` at the admin baseline, so a caller
   * asking for 1.0 gets exactly 1.0 with `validationPasses`/`multiSample` at 1.
   */
  it('BUDGET_SOFT_CAP fires on the batch that CROSSES the threshold (10.5 − 1.0 < 10)', async () => {
    runtime = createTestRuntime();
    await seedSoftCapRow(db, SOFT_CAP_ORG, {
      limitUsd: 100,
      remainingUsd: 10.5,
      softCapPct: 90,
    });

    const req: GenerateRequest = {
      units: [
        {
          unitKey: 'u1',
          input: { thing: 'one' },
          specOverride: {
            ...SPEC_OVERRIDE,
            effortProfile: { estimatedCostUsdPerCall: 1.0 },
          },
        },
      ],
    };

    const launch = await enqueueGeneration(
      req,
      { org: SOFT_CAP_ORG, project: PROJECT },
      {
        db,
        queue: runtime.queues.generation,
        flow: runtime.queues.flow,
        bus: createEventBus(),
      },
    );

    // The estimate really is the 1.0 the arithmetic above assumes.
    expect(launch.estimatedCostUsd).toBeCloseTo(1.0, 6);
    expect(launch.warnings?.map((w) => w.code)).toEqual(['BUDGET_SOFT_CAP']);

    // Still no money moved by the enqueue — the probe is not a reserve.
    expect(await remainingUsd(db, SOFT_CAP_ORG)).toBeCloseTo(10.5, 6);
  });

  it('BUDGET_SOFT_CAP stays silent for a batch too small to cross the threshold', async () => {
    runtime = createTestRuntime();
    await seedSoftCapRow(db, SOFT_CAP_ORG, {
      limitUsd: 100,
      remainingUsd: 10.5,
      softCapPct: 90,
    });

    // 10.5 − 0.2 = 10.3 >= 10 — the warning is genuinely not due yet.
    const req: GenerateRequest = {
      units: [
        {
          unitKey: 'u1',
          input: { thing: 'one' },
          specOverride: {
            ...SPEC_OVERRIDE,
            effortProfile: { estimatedCostUsdPerCall: 0.2 },
          },
        },
      ],
    };

    const launch = await enqueueGeneration(
      req,
      { org: SOFT_CAP_ORG, project: PROJECT },
      {
        db,
        queue: runtime.queues.generation,
        flow: runtime.queues.flow,
        bus: createEventBus(),
      },
    );

    expect(launch.estimatedCostUsd).toBeCloseTo(0.2, 6);
    expect(launch.warnings).toBeUndefined();
  });

  it('FAIL-CLOSED still holds: an org with no budget_state row is refused up front (ADR-0003 D5)', async () => {
    runtime = createTestRuntime();
    await clearBudget(db, UNCONFIGURED_ORG);

    const req: GenerateRequest = {
      units: [{ unitKey: 'u1', input: { thing: 'one' }, specOverride: SPEC_OVERRIDE }],
    };

    await expect(
      enqueueGeneration(
        req,
        { org: UNCONFIGURED_ORG, project: PROJECT },
        {
          db,
          queue: runtime.queues.generation,
          flow: runtime.queues.flow,
          bus: createEventBus(),
        },
      ),
    ).rejects.toBeInstanceOf(BudgetNotConfigured);

    // Refused BEFORE any row was written — not after a rollback.
    const rows = await db
      .select({ id: generationRequests.id })
      .from(generationRequests)
      .where(eq(generationRequests.org, UNCONFIGURED_ORG));
    expect(rows).toHaveLength(0);
  });
});
