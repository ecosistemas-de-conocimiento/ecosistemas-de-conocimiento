// Cost-rollup integration test (real Postgres) — ADR-0003 Track 1 / S2.
//
// Locks the invariant a consumer's credit debit trues-up from:
//
//   generation_requests.actual_cost_usd == Σ(traces.actual_cost_usd)
//
// for every unit in the request. The bug this guards against: the worker's
// validator-retry path makes a SECOND router.route() call (which writes its
// own trace row and spends real budget) but used to roll up only the FINAL
// `result.usage.estimatedCostUsd`, dropping the discarded first-call cost. On a
// fan-out where most units retry once that undercounts the request rollup by
// ~2× — exactly the symptom the ADR measured ($0.0037 recorded vs $0.0088
// trace-summed). We now accumulate the cost of every call the worker makes.
//
// Why integration, not unit: the divergence is between the rows the REAL
// router/trace-writer persist and the rollup the worker computes. A mocked
// router can't write traces, so only a real-DB run can assert the two agree.
// We inject a deterministic fake ADAPTER (not a fake router) so the genuine
// router pipeline — validation, retry messages, trace writes, budget reserve/
// true-up — all execute against Postgres.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  generationJobs,
  generationRequests,
  traces,
} from '../db/schema/index.js';
import { createRouter } from '../services/ai/router/router.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import { TraceWriter } from '../services/ai/router/trace-writer.js';
import { processGenerationJob } from './generation.worker.js';
import { createEventBus } from '../services/events/bus.js';
import type { Db } from '../db/client.js';
import type {
  callOpenRouter,
  OpenRouterCompletion,
} from '../services/ai/router/adapters/openrouter.js';

const ORG = 'cost-rollup-org';
const PROJECT = 'cost-rollup-project';

// Fixed per-call cost so the arithmetic is exact and the assertion is a true
// equality, not an approximation. Two units × two calls each (first fails a
// regex validator, retry passes) ⇒ 4 calls ⇒ Σ trace = 4 × CALL_COST.
const CALL_COST = 0.002;

/**
 * Deterministic fake adapter matching `callOpenRouter`'s signature. Tracks call
 * count PER prompt-shape so the FIRST call for a unit returns content that fails
 * the unit's `OK` regex validator (forcing the worker's retry) and the SECOND
 * returns passing content. Every call reports the same non-zero `costUsd`, so
 * the trace the router writes for each call carries CALL_COST.
 */
function makeRetryingAdapter(): typeof callOpenRouter {
  // Key by the assistant-echo presence: the retry call includes an `assistant`
  // message (the rejected draft) per the worker's refine-style retry payload.
  const adapter = (async (opts): Promise<OpenRouterCompletion> => {
    const isRetry = opts.messages.some((m) => m.role === 'assistant');
    const contentText = isRetry ? 'OK retry output' : 'bad first draft';
    return {
      contentText,
      finishReason: 'stop',
      model: opts.model,
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        costUsd: CALL_COST,
        costSource: 'openrouter',
      },
    };
  }) as typeof callOpenRouter;
  return adapter;
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

describe('generation worker cost rollup (integration, real Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('request.actual_cost_usd equals Σ(trace.actual_cost_usd) across a multi-unit run with retries', async () => {
    // Ample explicit budget so reserves succeed (no bootstrap path).
    await seedBudget(db, ORG, 100);

    // A regex validator requiring "OK" in the output. The first adapter reply
    // ("bad first draft") fails it → blocker → the worker retries; the retry
    // ("OK retry output") passes. So each unit makes exactly two router calls.
    const specOverride = {
      promptTemplate: 'generate {{thing}}',
      effortLevel: 'standard' as const,
      model: 'mock/model',
      validators: [{ type: 'regex', params: { pattern: 'OK' } }],
    };

    const reqInsert = await db
      .insert(generationRequests)
      .values({
        org: ORG,
        project: PROJECT,
        status: 'queued',
        totalJobs: 2,
        effort: 'standard',
        estimatedCostUsd: '0',
        actualCostUsd: '0',
        startedAt: new Date(),
      })
      .returning({ id: generationRequests.id });
    const requestId = reqInsert[0]!.id;

    const unitKeys = ['unit-a', 'unit-b'];
    for (const unitKey of unitKeys) {
      await db.insert(generationJobs).values({
        generationRequestId: requestId,
        org: ORG,
        project: PROJECT,
        unitKey,
        status: 'queued',
        effort: 'standard',
        specOverride,
        input: { __renderedPrompt: `generate ${unitKey}` },
        estimatedCostUsd: '0',
      });
    }

    const jobRows = await db
      .select({ id: generationJobs.id, unitKey: generationJobs.unitKey })
      .from(generationJobs)
      .where(eq(generationJobs.generationRequestId, requestId));

    // Real router + DB-backed persistence, fake adapter. One shared bus we
    // don't assert on here (the cost invariant is the subject).
    const router = createRouter({
      budget: new BudgetEnforcer(db),
      traceWriter: new TraceWriter(db),
      adapter: makeRetryingAdapter(),
    });
    const bus = createEventBus();

    for (const job of jobRows) {
      await processGenerationJob(
        {
          id: `q-${job.unitKey}`,
          data: {
            jobId: job.id,
            generationRequestId: requestId,
            org: ORG,
            project: PROJECT,
            unitKey: job.unitKey,
          },
        },
        { db, router, bus },
      );
    }

    // ── The invariant ──────────────────────────────────────────────────────
    const reqAfter = await db
      .select({ actualCostUsd: generationRequests.actualCostUsd })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .limit(1);
    const requestCost = Number(reqAfter[0]!.actualCostUsd);

    const traceSumRow = await db
      .select({
        total: sql<string>`COALESCE(SUM(${traces.actualCostUsd}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(traces)
      .where(eq(traces.generationRequestId, requestId));
    const traceSum = Number(traceSumRow[0]!.total);
    const traceCount = Number(traceSumRow[0]!.count);

    // 2 units × 2 calls (fail + retry) = 4 traces, each CALL_COST.
    expect(traceCount).toBe(4);
    expect(traceSum).toBeCloseTo(4 * CALL_COST, 6);

    // The load-bearing assertion: the request rollup is the authoritative sum
    // of its units' actual trace costs — NOT the ~2× undercount.
    expect(requestCost).toBeCloseTo(traceSum, 6);
    expect(requestCost).toBeCloseTo(4 * CALL_COST, 6);

    // Per-job rows also carry the full (both-call) cost.
    const jobsAfter = await db
      .select({ actualCostUsd: generationJobs.actualCostUsd })
      .from(generationJobs)
      .where(eq(generationJobs.generationRequestId, requestId));
    for (const j of jobsAfter) {
      expect(Number(j.actualCostUsd)).toBeCloseTo(2 * CALL_COST, 6);
    }
  });
});
