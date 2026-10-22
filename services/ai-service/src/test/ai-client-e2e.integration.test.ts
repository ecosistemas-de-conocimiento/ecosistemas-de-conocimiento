// The REAL `@edc/ai-client` against the REAL server, over real HTTP (AIS-9).
//
// ── Why this file exists ────────────────────────────────────────────────────
// Before it, `new AIClient(` appeared in no file outside `packages/ai-client/src`
// (2026-10-17 fleet AI audit, AIS-9, measured by grep). The client's own tests
// run against a fake `fetch`; the server's integration tests use `app.inject`
// with hand-written bodies. Nothing checked that the request the client SENDS is
// the one the server ACCEPTS, or that the response the server SENDS carries the
// fields the client's types promise. A field renamed on either side kept both
// suites green.
//
// ── What it does ───────────────────────────────────────────────────────────
// `buildServer().listen(0)` on loopback, a real `new AIClient({ baseUrl })`
// pointed at it, real Postgres from the integration harness, and the TEST-ONLY
// fake provider (`test-support/fake-provider/`) for every model and embedding
// call: deterministic vectors (`fakeEmbedOne`), scripted replies
// (`[[FAKE_REPLY:<base64>]]`), zero spend.
//
// Every assertion reads a value the SERVER computed (a chunk id it wrote, a
// trace row it inserted, a reply it parsed out of the provider body, a budget it
// debited) — never a value a mock handed back.
//
// ── Tenancy: the org header is load-bearing ────────────────────────────────
// The key below delegates (`delegateOrgPrefix: 'e2e-'`). The main client sends
// `org: 'acme'`, so the server acts as `e2e-acme`, and ONLY `e2e-acme` has a
// budget row. A client that stops sending `X-AI-Org` acts as the key's own org
// `e2e`, which has none, and every metered call turns into a 402. That is also
// the typed-402 case: the same key without `org` must surface
// `BudgetNotConfiguredError` through the client.
//
// Mutation results (recorded when the file was written, 2026-10-17) are in the
// commit message that added it.
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only`: the integration lane has no skip
// path (`integration-database.test.ts` fails the unit suite if a file gates
// itself).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import {
  AIClient,
  BudgetNotConfiguredError,
  CapabilityNegotiationError,
  createCapabilityCheck,
  type RetrievalLeg,
  type RetrievalWarning,
  type RetrieveMultiResult,
  type RetrieveResult,
} from '../../../../packages/ai-client/src/index.js';

// Cost the fake provider reports per completion (`usage.cost`). Non-zero so the
// budget debit is observable.
const FAKE_COST_USD = 0.0025;

// Rewrite env BEFORE `buildServer` / `env.ts` load (dynamic import below).
const fake = await startFakeProvider({ costUsd: FAKE_COST_USD });
Object.assign(process.env, fake.env);
// The second lexical leg must be the tsvector one, deterministically.
process.env.SPARSE_ENABLED = 'false';
delete process.env.SPARSE_EMBED_URL;
// No reranker on this server: `rerank: true` must come back as a typed warning.
process.env.RERANK_ENABLED = 'false';
const API_KEY = 'app-e2e-client';
process.env.API_KEYS = JSON.stringify({
  [API_KEY]: { org: 'e2e', project: 'chat', role: 'app', delegateOrgPrefix: 'e2e-' },
});

const ORG_SUFFIX = 'acme';
const EFFECTIVE_ORG = `e2e-${ORG_SUFFIX}`;
const BUDGET_USD = 100;

const POLICIES = [
  { id: 'p-es', text: 'Politica de privacidad para datos personales de la organizacion.', metadata: { lang: 'es' } },
  { id: 'p-en', text: 'Privacy policy for municipal personal data and retention.', metadata: { lang: 'en' } },
  { id: 'p-fr', text: 'Politique de confidentialite des donnees municipales.', metadata: { lang: 'fr' } },
] as const;
const DRAFTS = [
  { id: 'd-12', text: 'Draft twelve: street lighting budget for the north district.', metadata: { docId: '12' } },
  { id: 'd-34', text: 'Draft thirty-four: water network maintenance schedule.', metadata: { docId: '34' } },
  { id: 'd-56', text: 'Draft fifty-six: parks and recreation volunteer roster.', metadata: { docId: '56' } },
] as const;

// base64url, unpadded: the prompt renderer HTML-escapes `=` (`&#x3D;`) and `/`,
// which breaks the fake provider's directive. Its decoder accepts both forms.
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function db() {
  return (await import('../db/client.js')).db;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return [...((await (await db()).execute(query)) as unknown as Iterable<T>)];
}

async function seedBudget(): Promise<void> {
  await (await db()).execute(sql`
    INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
    VALUES (${EFFECTIVE_ORG}, ${BUDGET_USD}::numeric, ${BUDGET_USD}::numeric)
    ON CONFLICT ("org") DO UPDATE
      SET "limit_usd" = ${BUDGET_USD}::numeric, "remaining_usd" = ${BUDGET_USD}::numeric
  `);
}

async function remainingUsd(): Promise<number> {
  const [row] = await rows<{ remaining_usd: string }>(
    sql`SELECT "remaining_usd" FROM "budget_state" WHERE "org" = ${EFFECTIVE_ORG}`,
  );
  return Number(row!.remaining_usd);
}

/** The `usage_logs` rows the server wrote for one router call. */
async function usageFor(traceId: string) {
  const found = await rows<{ org: string; model: string; actual_cost_usd: string | null }>(sql`
    SELECT "org", "model", "actual_cost_usd" FROM "usage_logs" WHERE "trace_id" = ${traceId}::uuid
  `);
  return found.map((r) => ({ ...r, actual_cost_usd: Number(r.actual_cost_usd) }));
}

/** Chunk ids the server wrote, keyed by the external document id. */
async function chunkIdsByDoc(corpus: string): Promise<Map<string, string>> {
  const found = await rows<{ external_id: string; id: string }>(sql`
    SELECT d."external_id", c."id"
      FROM "chunks" c
      JOIN "documents" d ON d."id" = c."document_id"
      JOIN "corpora" k ON k."id" = c."corpus_id"
     WHERE k."name" = ${corpus} AND k."org" = ${EFFECTIVE_ORG}
  `);
  return new Map(found.map((r) => [r.external_id, r.id]));
}

describe('ai-client <-> server over HTTP (AIS-9)', () => {
  let app: import('fastify').FastifyInstance;
  let client: AIClient;
  let clientNoOrg: AIClient;
  let baseUrl: string;
  const ingest: Record<string, { ingestId: string; status: Awaited<ReturnType<AIClient['ingest']['status']>> }> = {};

  /** Run every queued ingest job of `ingestId` through the real worker body and real embedder. */
  async function drainIngest(ingestId: string): Promise<void> {
    const { processIngestJob } = await import('../workers/ingest.worker.js');
    const queue = app.runtime.queues.ingest as unknown as {
      __mockJobs: Array<{ id: string; data: { ingestId: string } }>;
    };
    const jobs = queue.__mockJobs.filter((j) => j.data.ingestId === ingestId);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) await processIngestJob(job as never);
  }

  async function ingestCorpus(corpus: string, documents: ReadonlyArray<{ id: string; text: string; metadata: Record<string, unknown> }>) {
    const res = await client.ingest.enqueue({ corpus, documents: documents.map((d) => ({ ...d })) });
    expect(res.totalDocs).toBe(documents.length);
    await drainIngest(res.ingestId);
    ingest[corpus] = { ingestId: res.ingestId, status: await client.ingest.status(res.ingestId) };
  }

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    client = new AIClient({ baseUrl, apiKey: API_KEY, org: ORG_SUFFIX, retry: { attempts: 1 } });
    clientNoOrg = new AIClient({ baseUrl, apiKey: API_KEY, retry: { attempts: 1 } });

    await (await db()).execute(
      sql`TRUNCATE TABLE corpus_aliases, chunks, documents, ingest_jobs, ingest_requests, corpora RESTART IDENTITY CASCADE`,
    );
    await seedBudget();

    // `policies` is created through the control plane first; `drafts` is
    // auto-created by its first ingest. Both paths exercised.
    await client.corpora.create({ name: 'policies', language: 'simple' });
    await ingestCorpus('policies', POLICIES);
    await ingestCorpus('drafts', DRAFTS);
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
    await fake.close();
  });

  // The shared per-test truncate wipes `budget_state`.
  beforeEach(seedBudget);

  // ── capabilities ──────────────────────────────────────────────────────────

  it('the strict capability check passes on what this server has, and names what it lacks', async () => {
    const check = createCapabilityCheck({
      consumer: 'ais9-e2e',
      require: () => ['retrievalLegs', 'metadataFilterIn', 'orgDelegation'],
      client: () => client,
    });
    await expect(check.run(silent)).resolves.toBeUndefined();

    const err = await client.capabilities
      .negotiate({ consumer: 'ais9-e2e', require: ['retrievalLegs', 'ais9NoSuchCapability'], logger: silent, attempts: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    expect((err as CapabilityNegotiationError).status).toBe('missing');
    expect((err as CapabilityNegotiationError).missing).toEqual(['ais9NoSuchCapability']);
  });

  // ── corpora + ingest ──────────────────────────────────────────────────────

  it('ingest runs to completion, and the status carries the chunk counts the worker wrote', async () => {
    for (const [corpus, docs] of [['policies', POLICIES], ['drafts', DRAFTS]] as const) {
      const ids = await chunkIdsByDoc(corpus);
      const { status } = ingest[corpus]!;
      expect(status.status).toBe('completed');
      expect(status.totalDocs).toBe(docs.length);
      expect(status.completedDocs).toBe(docs.length);
      expect(status.failedDocs).toBe(0);
      expect(ids.size).toBe(docs.length);
      expect(status.chunkCount).toBe(ids.size);
      expect([...(status.documents ?? [])].map((d) => d.docId).sort()).toEqual(docs.map((d) => d.id).sort());
    }
  });

  it('corpora list/get return the live counts, under the DELEGATED org', async () => {
    const listed = await client.corpora.list();
    expect(listed.map((c) => c.name).sort()).toEqual(['drafts', 'policies']);
    const policies = await client.corpora.get('policies');
    expect(policies.documentCount).toBe(POLICIES.length);
    expect(policies.chunkCount).toBe((await chunkIdsByDoc('policies')).size);
    expect(policies.language).toBe('simple');

    // The rows belong to `e2e-acme`, not to the key's own org.
    const owners = await rows<{ org: string }>(sql`SELECT DISTINCT "org" FROM "corpora"`);
    expect(owners).toEqual([{ org: EFFECTIVE_ORG }]);
  });

  // ── retrieve ──────────────────────────────────────────────────────────────

  it('retrieve: `$in` filter excludes on the server; legs and warnings arrive typed', async () => {
    const ids = await chunkIdsByDoc('policies');
    const french = POLICIES[2];

    // Control: unfiltered, the exact-text query ranks the French doc first.
    const control = await client.retrieve.retrieve({ corpus: 'policies', query: french.text, topK: 5 });
    expect(control.chunks[0]!.chunkId).toBe(ids.get('p-fr'));
    expect(control.chunks[0]!.score).toBeCloseTo(1, 5);

    const res: RetrieveResult = await client.retrieve.retrieve({
      corpus: 'policies',
      query: french.text,
      topK: 5,
      mode: 'hybrid',
      rerank: true,
      filter: { lang: { $in: ['es', 'en'] } },
    });
    expect(res.chunks.map((c) => c.chunkId).sort()).toEqual([ids.get('p-es'), ids.get('p-en')].sort());
    expect(res.chunks.map((c) => c.metadata?.['lang']).sort()).toEqual(['en', 'es']);

    const legs: RetrievalLeg[] = res.legs ?? [];
    expect(Array.isArray(res.legs)).toBe(true);
    expect(legs).toContain('dense');
    expect(legs).not.toContain('rerank');
    const warnings: RetrievalWarning[] = res.warnings ?? [];
    expect(warnings).toEqual([expect.objectContaining({ code: 'RERANK_DEGRADED', reason: 'unavailable' })]);
    expect(warnings[0]!.message).toBeTypeOf('string');
  });

  it('retrieve/multi: `corpusFilters` narrows one corpus only; legs, warnings and diagnostics arrive typed', async () => {
    const drafts = await chunkIdsByDoc('drafts');
    const policies = await chunkIdsByDoc('policies');

    const res: RetrieveMultiResult = await client.retrieve.retrieveMulti({
      corpora: ['policies', 'drafts'],
      query: DRAFTS[2].text,
      topK: 5,
      limit: 20,
      rerank: true,
      corpusFilters: { drafts: { docId: { $in: ['12', '34'] } } },
    });

    const got = res.chunks.map((c) => `${c.corpus}:${c.chunkId}`).sort();
    expect(got).toEqual(
      [
        ...[...policies.values()].map((id) => `policies:${id}`),
        `drafts:${drafts.get('d-12')}`,
        `drafts:${drafts.get('d-34')}`,
      ].sort(),
    );
    expect(res.query).toBe(DRAFTS[2].text);
    expect(res.rewritten).toBe(false);
    const byCorpus = Object.fromEntries(res.corpora.map((c) => [c.corpus, c]));
    expect(byCorpus['policies']).toMatchObject({ matched: 3 });
    expect(byCorpus['drafts']).toMatchObject({ matched: 2 });
    expect(byCorpus['drafts']!.error).toBeUndefined();

    const legs: RetrievalLeg[] = res.legs ?? [];
    expect(Array.isArray(res.legs)).toBe(true);
    expect(legs).toContain('dense');
    const warnings: RetrievalWarning[] = res.warnings ?? [];
    expect(warnings).toEqual([expect.objectContaining({ code: 'RERANK_DEGRADED', reason: 'unavailable' })]);
  });

  // ── generate ──────────────────────────────────────────────────────────────

  it('generate.sync: scripted reply, real trace row, retrievalTrace, and a real budget debit', async () => {
    const reply = 'ais9 sync answer: forty-two';
    const before = await remainingUsd();
    const policies = await chunkIdsByDoc('policies');

    const res = await client.generate.sync({
      unit: {
        unitKey: 'ais9-sync',
        input: { q: `[[FAKE_REPLY:${b64(reply)}]]` },
        specOverride: { promptTemplate: 'Answer: {{q}}' },
      },
      includeContext: [
        { corpus: 'policies', query: POLICIES[0].text, topK: 1, filter: { lang: { $in: ['es'] } } },
      ],
    });

    expect(res.text).toBe(reply);
    expect(res.costUsd).toBeCloseTo(FAKE_COST_USD, 10);
    expect(res.retrievalTrace).toEqual([
      expect.objectContaining({ key: 'policies', corpus: 'policies', chunkIds: [policies.get('p-es')] }),
    ]);
    expect(res.retrievalTrace![0]!.legs).toContain('dense');

    // `traceId` is the router's id, which `usage_logs.trace_id` links to.
    expect(await usageFor(res.traceId)).toEqual([
      { org: EFFECTIVE_ORG, model: res.modelUsed, actual_cost_usd: FAKE_COST_USD },
    ]);
    expect(await remainingUsd()).toBeLessThan(before);
  });

  it('generate.stream: deltas concatenate to the done frame, which carries the scripted reply', async () => {
    const reply = 'ais9 stream answer, token by token';
    const stream = await client.generate.stream({
      unit: {
        unitKey: 'ais9-stream',
        input: { q: `[[FAKE_REPLY:${b64(reply)}]]` },
        specOverride: { promptTemplate: 'Answer: {{q}}' },
      },
    });
    const deltas: string[] = [];
    const done = await stream.collect((t) => deltas.push(t));
    expect(done.type).toBe('done');
    expect(done.text).toBe(reply);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(reply);
    expect(done.costUsd).toBeCloseTo(FAKE_COST_USD, 10);
    expect(await usageFor(done.traceId)).toEqual([
      { org: EFFECTIVE_ORG, model: done.modelUsed, actual_cost_usd: FAKE_COST_USD },
    ]);
  });

  // ── route ─────────────────────────────────────────────────────────────────

  it('route: the server parses the model choice; not the fallback', async () => {
    const res = await client.route({
      question: `Where do I pay my water bill? [[FAKE_REPLY:${b64(JSON.stringify({ routeId: 'billing', reason: 'ais9 pick' }))}]]`,
      candidates: [
        { id: 'billing', description: 'Payments and bills' },
        { id: 'support', description: 'Everything else' },
      ],
      defaultRouteId: 'support',
    });
    expect(res).toMatchObject({ routeId: 'billing', reason: 'ais9 pick', fallback: false });
  });

  // ── org header + typed 402 ────────────────────────────────────────────────

  it('without the org header the key acts as its own org, which has no budget: typed 402', async () => {
    const err = await clientNoOrg.generate
      .sync({ unit: { unitKey: 'ais9-402', input: {}, specOverride: { promptTemplate: 'hi' } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetNotConfiguredError);
    expect((err as BudgetNotConfiguredError).status).toBe(402);
    expect((err as BudgetNotConfiguredError).org).toBe('e2e');

    // Same key, same moment, WITH the header: the delegated org is funded.
    await expect(
      client.generate.sync({ unit: { unitKey: 'ais9-200', input: {}, specOverride: { promptTemplate: 'hi' } } }),
    ).resolves.toMatchObject({ costUsd: expect.any(Number) });
  });
});
