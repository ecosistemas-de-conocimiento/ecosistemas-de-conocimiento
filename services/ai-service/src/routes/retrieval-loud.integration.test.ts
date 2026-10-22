// Retrieval fails LOUDLY and is METERED — end to end, through the real routes.
//
// AIS-3: `includeContext` on `/v1/generate*` used to swallow a missing corpus
// and an unknown recipe into an empty `__context`, then answer 200 from an
// UNGROUNDED prompt. AIS-7 (retrieval half): the query embed and the rerank
// never touched the budget cap. This file drives real HTTP requests against a
// real Postgres, the real budget enforcer and the TEST-ONLY fake provider
// (zero spend), and asserts on the wire and on `budget_state`.
//
// What each case pins:
//   1. /v1/retrieve over budget → 402 BudgetExceeded, embedder never called,
//      remaining unchanged.
//   2. /v1/retrieve with no budget row → 402 BudgetNotConfigured (fail-closed).
//   3. /v1/retrieve within budget → 200, remaining DECREASED by the embed cost,
//      no hold left `reserved`.
//   4. /v1/retrieve/multi over budget → 402, NOT a 200 with `failed` rows.
//   5. /v1/generate/sync + includeContext on a missing corpus → 404, the model
//      is never called.
//   6. /v1/generate/sync + an unknown recipe → 400 SpecResolutionError.
//   7. /v1/generate/sync + includeContext that resolves → 200 with a
//      `retrievalTrace` naming the chunk ids the prompt got.
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only` here: the integration lane has no
// skip path.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeEmbedOne, startFakeProvider } from '../../test-support/fake-provider/server.mjs';

const ORG = 'loud';
const PROJECT = 'rag';
const KEY = 'app-loud';

// Env must be rewritten BEFORE `server.js` / `env.ts` are imported.
const fake = await startFakeProvider();
Object.assign(process.env, fake.env);
process.env.SPARSE_ENABLED = 'false';
delete process.env.SPARSE_EMBED_URL;
process.env.API_KEYS = JSON.stringify({ [KEY]: { org: ORG, project: PROJECT, role: 'app' } });

import type { FastifyInstance } from 'fastify';

/** 4,000 chars ⇒ 1,000 estimated tokens ⇒ a $0.00001 reserve on `baai/bge-m3`. */
const LONG_QUERY = 'quarterly revenue '.repeat(222).slice(0, 4_000);

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const { db } = await import('../db/client.js');
  const res = await db.execute(query);
  return ((res as unknown as { rows?: T[] }).rows ?? (res as unknown as T[])) as T[];
}

async function setBudget(remaining: string): Promise<void> {
  await q(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${ORG}, 100::numeric, ${remaining}::numeric)
    ON CONFLICT ("org") DO UPDATE SET "limit_usd" = 100::numeric, "remaining_usd" = ${remaining}::numeric
  `);
}

async function remaining(): Promise<number> {
  const [row] = await q<{ r: string }>(sql`
    SELECT "remaining_usd"::text AS r FROM "budget_state" WHERE "org" = ${ORG}
  `);
  return Number(row?.r);
}

async function seedCorpus(name: string, texts: string[]): Promise<void> {
  const { db } = await import('../db/client.js');
  const { chunks, corpora, documents } = await import('../db/schema/index.js');
  const corpusId = (
    await db.insert(corpora).values({ org: ORG, project: PROJECT, name }).returning({ id: corpora.id })
  )[0]!.id;
  const documentId = (
    await db
      .insert(documents)
      .values({ corpusId, org: ORG, project: PROJECT, externalId: `${name}-doc`, text: texts.join('\n') })
      .returning({ id: documents.id })
  )[0]!.id;
  await db.insert(chunks).values(
    texts.map((text, ordinal) => ({
      documentId,
      corpusId,
      org: ORG,
      project: PROJECT,
      ordinal,
      text,
      embedding: fakeEmbedOne(text),
    })),
  );
}

const embedCalls = () => fake.requests.filter((r: { kind: string }) => r.kind === 'embeddings').length;
const chatCalls = () => fake.requests.filter((r: { kind: string }) => r.kind === 'chat').length;

describe('retrieval is metered and fails loudly (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  beforeEach(async () => {
    await q(sql`TRUNCATE TABLE corpus_aliases, chunks, documents, corpora RESTART IDENTITY CASCADE`);
    await q(sql`DELETE FROM "project_configs" WHERE "org" = ${ORG}`);
    await seedCorpus('ledger', ['quarterly revenue figure for the northern region']);
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${KEY}` }, payload: payload as object });

  it('1. /v1/retrieve over budget → 402 BudgetExceeded; nothing embedded, nothing spent', async () => {
    await setBudget('0.000001');
    const before = embedCalls();
    const res = await post('/v1/retrieve', { corpus: 'ledger', query: LONG_QUERY });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'BudgetExceeded', org: ORG });
    expect(embedCalls()).toBe(before);
    expect(await remaining()).toBe(0.000001);
  });

  it('2. /v1/retrieve with no budget row → 402 BudgetNotConfigured', async () => {
    const res = await post('/v1/retrieve', { corpus: 'ledger', query: 'quarterly revenue' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'BudgetNotConfigured' });
  });

  it('3. /v1/retrieve within budget → 200 and the embed cost is debited, no live hold', async () => {
    await setBudget('1');
    const res = await post('/v1/retrieve', { corpus: 'ledger', query: LONG_QUERY });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { chunks: unknown[] }).chunks).toHaveLength(1);
    const after = await remaining();
    expect(after).toBeLessThan(1);
    expect(after).toBeGreaterThan(0.99);
    const [live] = await q<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM "budget_reservations" WHERE "org" = ${ORG} AND "state" = 'reserved'
    `);
    expect(Number(live?.n)).toBe(0);
  });

  it('4. /v1/retrieve/multi over budget → 402, not a 200 with `failed` diagnostics', async () => {
    await setBudget('0.000001');
    const res = await post('/v1/retrieve/multi', { corpora: ['ledger'], query: LONG_QUERY });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'BudgetExceeded' });
  });

  it('5. /v1/generate/sync + includeContext on a missing corpus → 404; the model is never called', async () => {
    await setBudget('1');
    const before = chatCalls();
    const res = await post('/v1/generate/sync', {
      unit: { unitKey: 'loud-404', input: {}, specOverride: { promptTemplate: 'Use {{__context.nope}}' } },
      includeContext: [{ corpus: 'nope', query: 'anything' }],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'CORPUS_NOT_FOUND', message: expect.stringContaining('nope') } });
    expect(chatCalls()).toBe(before);
  });

  it('6. /v1/generate/sync + an unknown recipe → 400 SpecResolutionError; the model is never called', async () => {
    await setBudget('1');
    const before = chatCalls();
    const res = await post('/v1/generate/sync', {
      unit: { unitKey: 'loud-400', input: {}, specOverride: { promptTemplate: 'Use {{__context.style}}' } },
      includeContext: [{ name: 'style' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'SpecResolutionError', cause: 'unknown context recipe' });
    expect(chatCalls()).toBe(before);
  });

  it('7. /v1/generate/sync + a resolving recipe → 200 with a retrievalTrace of chunk ids', async () => {
    // Full budget, so no BUDGET_SOFT_CAP warning joins the trace entry.
    await setBudget('100');
    await q(sql`
      INSERT INTO "project_configs" ("org", "project", "context_rules")
      VALUES (${ORG}, ${PROJECT}, ${JSON.stringify({ rev: { corpus: 'ledger', query: 'quarterly revenue' } })}::jsonb)
    `);
    const [chunk] = await q<{ id: string }>(sql`SELECT "id"::text AS id FROM "chunks" LIMIT 1`);
    const res = await post('/v1/generate/sync', {
      unit: {
        unitKey: 'loud-200',
        input: {},
        specOverride: { promptTemplate: '{{#each __context.rev}}{{this}}{{/each}}' },
      },
      includeContext: [{ name: 'rev' }],
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { retrievalTrace: unknown }).retrievalTrace).toEqual([
      { key: 'rev', corpus: 'ledger', chunkIds: [chunk!.id], legs: ['dense'] },
    ]);
  });
});
