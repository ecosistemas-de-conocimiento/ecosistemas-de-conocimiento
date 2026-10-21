// /v1/ingest against a real Postgres — the PLAN-live-ingest lane L1
// fault cases that need the real schema rather than a stub:
//
//   · GET /v1/ingest/<unknown id>          → 404 IngestNotFoundError (A11)
//   · callbackUrl from a secret-less key   → 400 CallbackSecretMissingError (D4)
//   · a committed document ⇒ its `callback_deliveries` row exists (outbox, A7),
//     and the terminal status snapshot carries per-document chunkCount
//   · a vanished corpus ⇒ an `ingest.failed` row and a terminal batch (A3)
//
// The worker is driven in-process through `processIngestJob` with a stub
// embedder: no OpenRouter, no BullMQ, no network.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const SECRET = 'l1-integration-callback-secret-32+chars';
// Rewrite env BEFORE any import that pulls `config/env.ts` / `server.ts`.
process.env.API_KEYS = JSON.stringify({
  'app-with-secret': { org: 'acme', project: 'chat', role: 'app', callbackSecret: SECRET },
  'app-no-secret': { org: 'acme', project: 'chat', role: 'app' },
  'app-other-org': { org: 'other', project: 'chat', role: 'app', callbackSecret: SECRET },
});
// The callback target is a closed loopback port: the post-commit kick fails
// fast with ECONNREFUSED instead of waiting on a real network.
process.env.CALLBACK_ALLOW_PRIVATE = '1';
const CALLBACK_URL = 'http://127.0.0.1:9/cb';

import type { FastifyInstance } from 'fastify';

describe('/v1/ingest — L1 delivery durability (integration)', () => {
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
  });

  beforeEach(async () => {
    const { db } = await import('../db/client.js');
    await db.execute(
      sql`TRUNCATE TABLE callback_deliveries, ingest_jobs, ingest_requests, chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
    // Ingest is charged against the org's cap; the enforcer is fail-closed on a missing row.
    // Both orgs the keys above act as.
    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
      VALUES ('acme', 100, 100), ('other', 100, 100)
      ON CONFLICT ("org") DO UPDATE SET "limit_usd" = 100, "remaining_usd" = 100
    `);
  });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  /** Run every queued job of an ingest through the real worker body. */
  async function runJobs(ingestId: string, over: { corpusId?: string } = {}) {
    const { db } = await import('../db/client.js');
    const { corpora, ingestJobs, ingestRequests } = await import('../db/schema/index.js');
    const { processIngestJob } = await import('../workers/ingest.worker.js');
    const req = (await db.select().from(ingestRequests).where(eq(ingestRequests.id, ingestId)))[0]!;
    const corpus = (await db.select().from(corpora).where(eq(corpora.id, req.corpusId!)))[0]!;
    const jobs = await db.select().from(ingestJobs).where(eq(ingestJobs.ingestId, ingestId));
    const embedder = async (opts: { input: string | string[] }) => {
      const input = Array.isArray(opts.input) ? opts.input : [opts.input];
      return {
        embeddings: input.map(() => {
          const v = new Array(corpus.embeddingDim).fill(0);
          v[0] = 1;
          return v;
        }),
        usage: { inputTokens: 10, estimatedCostUsd: 0 },
      };
    };
    for (const j of jobs) {
      await processIngestJob(
        {
          id: `bull-${j.id}`,
          data: {
            ingestId,
            jobId: j.id,
            corpusId: over.corpusId ?? corpus.id,
            org: req.org,
            project: req.project!,
            externalId: j.externalId,
            text: 'Hello world. This is a short document about callbacks and outboxes.',
          },
        },
        { db, embedder: embedder as never },
      );
    }
  }

  it('A11: an unknown ingest id is a 404 with a typed body', async () => {
    const id = '0b7c3d9e-2f41-4a8b-9c6d-5e4f3a2b1c0d';
    const res = await app.inject({ method: 'GET', url: `/v1/ingest/${id}`, headers: auth('app-with-secret') });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'IngestNotFoundError',
      code: 'ERR_INGEST_NOT_FOUND',
      ingestId: id,
      message: `ingest '${id}' not found in this org/project`,
    });
  });

  it('A11: a non-UUID id is a 404, not a 500 from the uuid cast', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ingest/nope', headers: auth('app-with-secret') });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ERR_INGEST_NOT_FOUND' });
  });

  it('D4: callbackUrl from a key without callbackSecret → 400, nothing persisted', async () => {
    const { db } = await import('../db/client.js');
    const { ingestRequests } = await import('../db/schema/index.js');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: auth('app-no-secret'),
      payload: { corpus: 'docs', callbackUrl: CALLBACK_URL, documents: [{ id: 'd1', text: 'x' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'CallbackSecretMissingError',
      code: 'ERR_CALLBACK_SECRET_MISSING',
    });
    expect(await db.select().from(ingestRequests)).toHaveLength(0);
  });

  it('D4: the same key WITHOUT callbackUrl is still accepted (polling consumers)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: auth('app-no-secret'),
      payload: { corpus: 'docs', documents: [{ id: 'd1', text: 'x' }] },
    });
    expect(res.statusCode).toBe(202);
  });

  it('outbox: a committed document has its ingest.completed delivery row; status carries chunkCount', async () => {
    const { db } = await import('../db/client.js');
    const { callbackDeliveries, chunks } = await import('../db/schema/index.js');
    const post = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: auth('app-with-secret'),
      payload: { corpus: 'docs', callbackUrl: CALLBACK_URL, documents: [{ id: 'doc-1', text: 'x' }] },
    });
    expect(post.statusCode).toBe(202);
    const { ingestId } = post.json() as { ingestId: string };

    // While queued: processing, and no per-doc detail yet.
    const before = await app.inject({ method: 'GET', url: `/v1/ingest/${ingestId}`, headers: auth('app-with-secret') });
    expect(before.json()).toMatchObject({ status: 'processing', completedDocs: 0 });
    expect(before.json()).not.toHaveProperty('documents');

    await runJobs(ingestId);

    const rows = await db.select().from(callbackDeliveries).where(eq(callbackDeliveries.sourceId, ingestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'ingest.completed', itemKey: 'doc-1', source: 'ingest' });
    expect(rows[0]!.signature).not.toBe('');

    const chunkRows = await db.select().from(chunks);
    const after = await app.inject({ method: 'GET', url: `/v1/ingest/${ingestId}`, headers: auth('app-with-secret') });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({
      ingestId,
      totalDocs: 1,
      completedDocs: 1,
      failedDocs: 0,
      status: 'completed',
      chunkCount: chunkRows.length,
      documents: [{ docId: 'doc-1', chunkCount: chunkRows.length }],
    });
    expect(chunkRows.length).toBeGreaterThan(0);

    // Another org asking for the same id gets the same 404 as a random one.
    const foreign = await app.inject({ method: 'GET', url: `/v1/ingest/${ingestId}`, headers: auth('app-other-org') });
    expect(foreign.statusCode).toBe(404);
  });

  it('A3: a corpus that vanished before the worker ran → ingest.failed row and a terminal batch', async () => {
    const { db } = await import('../db/client.js');
    const { callbackDeliveries } = await import('../db/schema/index.js');
    const post = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: auth('app-with-secret'),
      payload: { corpus: 'docs', callbackUrl: CALLBACK_URL, documents: [{ id: 'doc-x', text: 'x' }] },
    });
    const { ingestId } = post.json() as { ingestId: string };

    await runJobs(ingestId, { corpusId: '00000000-0000-4000-8000-000000000000' });

    const rows = await db.select().from(callbackDeliveries).where(eq(callbackDeliveries.sourceId, ingestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'ingest.failed', itemKey: 'doc-x' });
    expect(JSON.parse(rows[0]!.body)).toMatchObject({ error: { code: 'corpus-missing' } });

    const st = await app.inject({ method: 'GET', url: `/v1/ingest/${ingestId}`, headers: auth('app-with-secret') });
    expect(st.json()).toMatchObject({ status: 'failed', failedDocs: 1, completedDocs: 0, chunkCount: 0, documents: [] });
  });
});
