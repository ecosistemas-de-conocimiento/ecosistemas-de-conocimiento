// Ingest embedding spend against the REAL budget counter.
//
// ── The defect (audit 2026-10-17, AIS-7, ingest half) ──────────────────────
// The ingest worker logged its embedding cost to `usage_logs` but never took a
// reserve and never decremented `budget_state`, so an org could ingest without
// limit past its cap. These cases drive `processIngestJob` with the default
// (real) `BudgetEnforcer` on Postgres and a fake embedder — no paid call.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { corpora, ingestJobs, ingestRequests } from '../../db/schema/index.js';
import { processIngestJob, reapLostIngestJob } from '../../workers/ingest.worker.js';
import { BudgetEnforcer } from './enforcer.js';
import type { Db } from '../../db/client.js';
import type { callOpenRouterEmbedding } from '../ai/embeddings/openrouter.js';

const ORG = 'ingest-budget-org';
const PROJECT = 'ingest-budget-project';
const EMBED_DIM = 1024;
/** Priced in `task-profiles.ts`, so the pre-embed estimate is > 0. */
const MODEL = 'openai/text-embedding-3-small';
const ACTUAL_COST = 0.000012;

let db: Db;

function rows(out: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
  return (out as { rows?: Array<Record<string, unknown>> }).rows ?? [];
}

async function seedBudget(remaining: number, limit = 1): Promise<void> {
  await db.execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${ORG}, ${limit}::numeric, ${remaining}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${limit}::numeric, "remaining_usd" = ${remaining}::numeric
  `);
  // Ledger rows are not in the per-test truncate set; start each case clean.
  await db.execute(sql`DELETE FROM "budget_reservations" WHERE "org" = ${ORG}`);
}

async function remainingUsd(): Promise<number> {
  const out = await db.execute(
    sql`SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${ORG}`,
  );
  return Number(rows(out)[0]?.['remaining_usd'] ?? NaN);
}

async function ledgerStates(): Promise<string[]> {
  const out = await db.execute(
    sql`SELECT "state" FROM "budget_reservations" WHERE "org" = ${ORG} ORDER BY "created_at"`,
  );
  return rows(out).map((r) => String(r['state']));
}

async function seedIngest(): Promise<{ corpusId: string; ingestId: string; jobRowId: string }> {
  // `corpora` survives between cases; a fresh name per case avoids the unique index.
  const name = `budget-corpus-${randomUUID()}`;
  const corpusId = (
    await db
      .insert(corpora)
      .values({ org: ORG, project: PROJECT, name, embeddingModel: MODEL, embeddingDim: EMBED_DIM })
      .returning({ id: corpora.id })
  )[0]!.id;
  const ingestId = (
    await db
      .insert(ingestRequests)
      .values({
        org: ORG,
        project: PROJECT,
        corpus: name,
        corpusId,
        status: 'queued',
        totalDocs: 1,
        startedAt: new Date(),
      })
      .returning({ id: ingestRequests.id })
  )[0]!.id;
  const jobRowId = (
    await db
      .insert(ingestJobs)
      .values({ org: ORG, project: PROJECT, ingestId, externalId: null, status: 'queued' })
      .returning({ id: ingestJobs.id })
  )[0]!.id;
  return { corpusId, ingestId, jobRowId };
}

function fakeEmbedder(opts: { fail?: boolean } = {}): {
  embedder: typeof callOpenRouterEmbedding;
  calls: () => number;
} {
  let calls = 0;
  const embedder = (async (o: { model: string; input: string[] }) => {
    calls += 1;
    if (opts.fail) throw new Error('fake embed outage');
    return {
      embeddings: o.input.map(() => Array.from({ length: EMBED_DIM }, () => 0.01)),
      usage: { inputTokens: 12, estimatedCostUsd: ACTUAL_COST },
      model: o.model,
    };
  }) as unknown as typeof callOpenRouterEmbedding;
  return { embedder, calls: () => calls };
}

function job(ids: { corpusId: string; ingestId: string; jobRowId: string }) {
  return {
    id: 'bull-1',
    data: {
      ingestId: ids.ingestId,
      corpusId: ids.corpusId,
      org: ORG,
      project: PROJECT,
      externalId: null,
      jobId: ids.jobRowId,
      text: 'El presupuesto participativo se decide en asamblea. '.repeat(20),
    },
  };
}

describe('ingest embedding spend on the budget counter (integration)', () => {
  beforeAll(async () => {
    ({ db } = await import('../../db/client.js'));
  });

  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('🔴 a completed ingest debits the ACTUAL embedding cost and settles its hold', async () => {
    await seedBudget(1);
    const ids = await seedIngest();
    const { embedder } = fakeEmbedder();

    await processIngestJob(job(ids), { db, embedder });

    expect(await remainingUsd()).toBeCloseTo(1 - ACTUAL_COST, 8);
    expect(await ledgerStates()).toEqual(['settled']);
  });

  it('a failed embed refunds the hold: the counter is unchanged', async () => {
    await seedBudget(1);
    const ids = await seedIngest();
    const { embedder } = fakeEmbedder({ fail: true });

    await expect(processIngestJob(job(ids), { db, embedder })).rejects.toThrow('fake embed outage');

    expect(await remainingUsd()).toBeCloseTo(1, 9);
    expect(await ledgerStates()).toEqual(['refunded']);
  });

  it('🔴 an org over its cap is refused BEFORE the paid embed', async () => {
    await seedBudget(0);
    const ids = await seedIngest();
    const { embedder, calls } = fakeEmbedder();

    await processIngestJob(job(ids), { db, embedder });

    expect(calls()).toBe(0);
    expect(await remainingUsd()).toBe(0);
    const req = await db.execute(
      sql`SELECT "failed_docs", "status" FROM "ingest_requests" WHERE "id" = ${ids.ingestId}`,
    );
    expect(rows(req)[0]).toMatchObject({ failed_docs: 1, status: 'failed' });
  });

  it('the reaper refunds a lost job\'s live hold exactly once', async () => {
    await seedBudget(1);
    const ids = await seedIngest();
    // What a worker killed between reserve and true-up leaves behind: a live
    // hold keyed by the job row, and the row stuck at 'running'.
    await new BudgetEnforcer(db).reserve({ org: ORG, amountUsd: 0.25, traceId: 't-lost', jobId: ids.jobRowId });
    await db.execute(sql`
      UPDATE "ingest_jobs" SET "status" = 'running', "started_at" = now() - interval '1 hour'
       WHERE "id" = ${ids.jobRowId}
    `);
    expect(await remainingUsd()).toBeCloseTo(0.75, 9);

    expect(await reapLostIngestJob(ids.jobRowId, { db, windowMs: 1_000 })).toBe(true);
    expect(await remainingUsd()).toBeCloseTo(1, 9);
    expect(await ledgerStates()).toEqual(['refunded']);

    expect(await reapLostIngestJob(ids.jobRowId, { db, windowMs: 1_000 })).toBe(false);
    expect(await remainingUsd()).toBeCloseTo(1, 9);
  });
});
