// 🔴 TENANT ISOLATION, PROVEN AGAINST A REAL POSTGRES.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Tenant isolation in this service is enforced by ONE thing: the `(org,
// project)` predicate that every scoped query carries. Before this file, the
// evidence that those predicates work was, in three places, a MOCK:
//
//   * `src/services/rag/corpus-delete.test.ts` stubbed the query builder with
//     `where: () => ({ … })` — a function taking NO parameters. Whatever
//     predicate the production code passed was DISCARDED by the stub, so a
//     cross-tenant corpus wipe passed green.
//   * `src/routes/generate.test.ts` asserted a cross-tenant 404 by emptying the
//     mock's row array, and said so in its own comment ("mocked to ignore the
//     predicate").
//   * `src/routes/retrieve.test.ts` asserted a cross-tenant 404 by telling the
//     mocked service to REJECT. It proved the route maps an error to a status
//     code, not that the row is unreachable.
//
// A mock cannot prove tenant isolation: the thing under test is the WHERE
// clause, and a stub that ignores it will agree with any predicate at all —
// including none. So every case here runs against a real database and, where
// the operation is destructive, READS THE OTHER TENANT'S ROWS BACK rather than
// trusting a return value.
//
// ── The shape every case follows ───────────────────────────────────────────
// Seed a row that belongs ONLY to tenant B. Act as tenant A. Assert:
//   1. A gets 404 (never 403 — a foreign row must be indistinguishable from a
//      missing one, or the status code itself leaks existence), AND
//   2. B's rows are still there / still unchanged, read back directly, AND
//   3. where it is cheap, that B ITSELF can still reach the row — otherwise a
//      suite with an empty database would pass every one of these.
//
// Point (3) is what makes these mutation-detecting rather than vacuous. Drop
// `eq(corpora.org, ctx.org)` from `corpus-delete.ts` and case 1 goes red
// because B's corpus is gone; drop it from `retrieve.ts` and the retrieve case
// goes red because A receives B's chunk text.
//
// ── Wiring ─────────────────────────────────────────────────────────────────
// Mirrors `corpus.integration.test.ts`: TEST_* URLs rebound by
// `integration-setup.ts`, `API_KEYS` rewritten at module top BEFORE the dynamic
// `import('../server.js')`, RAG tables truncated per test here (they are NOT in
// the shared `truncateEachTest` list). The embedder is the real
// `callOpenRouterEmbedding`, pointed at the TEST-ONLY fake provider
// (`test-support/fake-provider/`), whose vectors are `fakeEmbedOne(text)` — so
// `/v1/retrieve` runs over local HTTP with zero spend and a reproducible
// cosine score.
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only` in this file, deliberately: the
// integration lane has no skip path (`integration-global-setup.ts` throws
// rather than skipping) and `integration-database.test.ts` fails the unit suite
// if an integration file gates itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeEmbedOne, startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import { and, eq, sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls `config/env.ts` / `server.ts`.
// Static imports are hoisted above these assignments, which is exactly why
// `buildServer` is pulled in with a dynamic `import()` inside `beforeAll`.
const fake = await startFakeProvider();
Object.assign(process.env, fake.env);
process.env.API_KEYS = JSON.stringify({
  'app-a': { org: 'acme', project: 'chat', role: 'app' },
  'app-b-org': { org: 'other', project: 'chat', role: 'app' },
  'app-b-project': { org: 'acme', project: 'other', role: 'app' },
  // `PUT /v1/budget/:org` is admin-only, so the budget cases need an admin key
  // on tenant A to prove that admin does NOT widen the org scope.
  'admin-a': { org: 'acme', project: 'chat', role: 'admin' },
});

import type { FastifyInstance } from 'fastify';


/** Tenant A — the caller in every case below. */
const A = { org: 'acme', project: 'chat', key: 'app-a' } as const;
/** Tenant B, reached by a DIFFERENT org. Gates the `org` half of the predicate. */
const B_ORG = { org: 'other', project: 'chat', key: 'app-b-org' } as const;
/** Tenant B, reached by a DIFFERENT project in the same org. Gates the `project` half. */
const B_PROJECT = { org: 'acme', project: 'other', key: 'app-b-project' } as const;

type Tenant = { readonly org: string; readonly project: string; readonly key: string };

const auth = (t: Tenant) => ({ authorization: `Bearer ${t.key}` });

async function dbHandle() {
  const { db } = await import('../db/client.js');
  return db;
}

async function schema() {
  return import('../db/schema/index.js');
}

/**
 * Seed one corpus with `docs` documents and `chunksPerDoc` chunks each, all
 * owned by `t`. Returns the ids so a test can read them back afterwards.
 *
 * `chunkText` seeds the embedding via `fakeEmbedOne`, so a `/v1/retrieve` for
 * that exact string scores 1.0 against the chunk against the fake provider.
 */
async function seedCorpus(opts: {
  tenant: Tenant;
  name: string;
  docs?: number;
  chunksPerDoc?: number;
  chunkText?: string;
}): Promise<{ corpusId: string; documentIds: string[] }> {
  const { tenant, name } = opts;
  const docCount = opts.docs ?? 0;
  const perDoc = opts.chunksPerDoc ?? 0;
  const db = await dbHandle();
  const { chunks, corpora, documents } = await schema();

  const corpusId = (
    await db
      .insert(corpora)
      .values({ org: tenant.org, project: tenant.project, name })
      .returning({ id: corpora.id })
  )[0]!.id;

  const documentIds: string[] = [];
  if (docCount > 0) {
    const rows = await db
      .insert(documents)
      .values(
        Array.from({ length: docCount }, (_, i) => ({
          corpusId,
          org: tenant.org,
          project: tenant.project,
          externalId: `${name}-doc-${i}`,
          text: `${name} document ${i}`,
        })),
      )
      .returning({ id: documents.id });
    documentIds.push(...rows.map((r) => r.id));
  }

  if (perDoc > 0 && documentIds.length > 0) {
    const embedding = fakeEmbedOne(opts.chunkText ?? `${name}-chunk`);
    await db.insert(chunks).values(
      documentIds.flatMap((documentId, d) =>
        Array.from({ length: perDoc }, (_, i) => ({
          documentId,
          corpusId,
          org: tenant.org,
          project: tenant.project,
          ordinal: i,
          text: opts.chunkText ?? `${name} d${d} c${i}`,
          embedding,
        })),
      ),
    );
  }

  return { corpusId, documentIds };
}

/** Row counts for one tenant's corpus, read straight from the tables. */
async function countsFor(tenant: Tenant, name: string) {
  const db = await dbHandle();
  const { chunks, corpora, documents } = await schema();

  const corpusRows = await db
    .select({ id: corpora.id })
    .from(corpora)
    .where(
      and(
        eq(corpora.org, tenant.org),
        eq(corpora.project, tenant.project),
        eq(corpora.name, name),
      ),
    );
  if (corpusRows.length === 0) return { corpora: 0, documents: 0, chunks: 0 };
  const corpusId = corpusRows[0]!.id;

  const docRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.corpusId, corpusId));
  const chunkRows = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(eq(chunks.corpusId, corpusId));

  return { corpora: corpusRows.length, documents: docRows.length, chunks: chunkRows.length };
}

describe('tenant isolation against a real Postgres', () => {
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

  // The RAG tables are NOT in the shared per-test truncate list (see
  // `integration-setup.ts`), so wipe them here. `generation_requests` /
  // `generation_jobs` ARE in that list and are already empty per test.
  beforeEach(async () => {
    const db = await dbHandle();
    await db.execute(
      sql`TRUNCATE TABLE corpus_aliases, chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE /v1/corpus/:name — the cross-tenant WIPE
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `corpus-delete.ts` resolves `(org, project, name)` and then cascades
  // chunks → documents → corpora by the resolved id. If the `org` or `project`
  // half of that lookup is dropped, tenant A's delete of a name it does not own
  // resolves to tenant B's row and DESTROYS B's documents and chunks. The stub
  // test could not see that, because its `where()` took no argument.
  //
  // Each case below seeds the name under B ONLY, so the mutation is
  // deterministic: without the predicate the lookup has exactly one candidate —
  // B's — and the delete succeeds where it must 404.
  describe('DELETE /v1/corpus/:name', () => {
    for (const [label, B] of [
      ['cross-ORG', B_ORG],
      ['cross-PROJECT', B_PROJECT],
    ] as const) {
      it(`${label}: deleting a POPULATED corpus owned by another tenant is a 404 that leaves its documents and chunks intact`, async () => {
        await seedCorpus({ tenant: B, name: 'payroll', docs: 2, chunksPerDoc: 3 });
        expect(await countsFor(B, 'payroll')).toEqual({
          corpora: 1,
          documents: 2,
          chunks: 6,
        });

        const res = await app.inject({
          method: 'DELETE',
          url: '/v1/corpus/payroll',
          headers: auth(A),
        });

        // 404, not 403: the status code must not confirm the corpus exists.
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');

        // 🔴 THE ASSERTION THAT MATTERS. Read B's rows back rather than
        // trusting the response body: a delete that reported nothing and wiped
        // everything would satisfy the status assertion above on its own.
        expect(await countsFor(B, 'payroll')).toEqual({
          corpora: 1,
          documents: 2,
          chunks: 6,
        });

        // And B can still reach it — so the 404 above is the predicate, not an
        // empty database.
        const owner = await app.inject({
          method: 'GET',
          url: '/v1/corpora/payroll',
          headers: auth(B),
        });
        expect(owner.statusCode).toBe(200);
        expect(owner.json()).toMatchObject({ documentCount: 2, chunkCount: 6 });
      });
    }

    it('same NAME in two orgs: A deletes exactly its own rows and none of B‑org’s', async () => {
      // Both tenants own a corpus called `shared`, with DIFFERENT contents, so
      // the reported counts alone distinguish which row was resolved.
      await seedCorpus({ tenant: A, name: 'shared', docs: 1, chunksPerDoc: 1 });
      await seedCorpus({ tenant: B_ORG, name: 'shared', docs: 2, chunksPerDoc: 3 });

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/corpus/shared',
        headers: auth(A),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: { chunks: 1, documents: 1, corpora: 1 } });

      expect(await countsFor(A, 'shared')).toEqual({ corpora: 0, documents: 0, chunks: 0 });
      expect(await countsFor(B_ORG, 'shared')).toEqual({
        corpora: 1,
        documents: 2,
        chunks: 6,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /v1/retrieve — the cross-tenant READ
  // ══════════════════════════════════════════════════════════════════════════
  //
  // This is the gap the mocked unit test left widest: `retrieve.test.ts` proved
  // only that the route maps `CorpusNotFoundError` to 404, by telling the
  // mocked service to throw it. Nothing executed `selectCorpusByName`'s WHERE.
  //
  // Here the chunk text is a marker string. If the `org`/`project` predicate is
  // dropped from `retrieve.ts`, tenant A does not get a 404 — it gets 200 and
  // that marker string in the response body, which is the leak itself.
  describe('POST /v1/retrieve', () => {

    // `/v1/retrieve*` is metered (AIS-7) and fail-closed: each org needs a
    // budget row. Scoped to this block — the /v1/budget cases need A WITHOUT one.
    beforeEach(async () => {
      const db = await dbHandle();
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES ('acme', 100::numeric, 100::numeric), ('other', 100::numeric, 100::numeric)
        ON CONFLICT ("org") DO UPDATE SET "remaining_usd" = 100::numeric
      `);
    });
    const QUERY = 'what is the quarterly figure';
    const SECRET = 'B-ONLY: quarterly figure is 41.7M';

    for (const [label, B] of [
      ['cross-ORG', B_ORG],
      ['cross-PROJECT', B_PROJECT],
    ] as const) {
      it(`${label}: a corpus owned by another tenant is a 404 for A while B still retrieves its own chunk`, async () => {
        await seedCorpus({
          tenant: B,
          name: 'ledger',
          docs: 1,
          chunksPerDoc: 1,
          chunkText: SECRET,
        });

        // Positive control FIRST: prove the row is genuinely retrievable for
        // its owner. Without this, an empty database would pass the 404 below.
        const owner = await app.inject({
          method: 'POST',
          url: '/v1/retrieve',
          headers: auth(B),
          payload: { corpus: 'ledger', query: SECRET, topK: 5 },
        });
        expect(owner.statusCode).toBe(200);
        expect(owner.json().chunks.map((c: { text: string }) => c.text)).toEqual([SECRET]);

        const foreign = await app.inject({
          method: 'POST',
          url: '/v1/retrieve',
          headers: auth(A),
          payload: { corpus: 'ledger', query: QUERY, topK: 5 },
        });
        expect(foreign.statusCode).toBe(404);
        // Belt and braces: the marker must not appear ANYWHERE in the response,
        // not merely outside a `chunks` array we happened to read.
        expect(foreign.body).not.toContain('41.7M');
      });
    }

    it('cross-ORG: /v1/retrieve/multi reports the foreign corpus as not_found and returns none of its chunks', async () => {
      await seedCorpus({
        tenant: B_ORG,
        name: 'ledger',
        docs: 1,
        chunksPerDoc: 1,
        chunkText: SECRET,
      });
      // A owns a corpus of its own so the fan-out has a legitimate leg — the
      // call must succeed on A's corpus and stay blind to B's.
      await seedCorpus({ tenant: A, name: 'mine', docs: 1, chunksPerDoc: 1, chunkText: 'A row' });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/retrieve/multi',
        headers: auth(A),
        payload: { corpora: ['mine', 'ledger'], query: QUERY, topK: 5 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        chunks: Array<{ text: string; corpus: string }>;
        corpora: Array<{ corpus: string; matched: number; error?: string }>;
      };
      expect(body.corpora.find((c) => c.corpus === 'ledger')).toMatchObject({
        matched: 0,
        error: 'not_found',
      });
      expect(body.chunks.every((c) => c.corpus === 'mine')).toBe(true);
      expect(res.body).not.toContain('41.7M');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET / PATCH /v1/corpora/:name — the cross-tenant INTROSPECT and RECONFIGURE
  // ══════════════════════════════════════════════════════════════════════════
  describe('/v1/corpora/:name', () => {
    it('cross-ORG: GET of a foreign corpus is 404 and leaks no config', async () => {
      await seedCorpus({ tenant: B_ORG, name: 'private', docs: 1, chunksPerDoc: 2 });

      const owner = await app.inject({
        method: 'GET',
        url: '/v1/corpora/private',
        headers: auth(B_ORG),
      });
      expect(owner.statusCode).toBe(200);

      const foreign = await app.inject({
        method: 'GET',
        url: '/v1/corpora/private',
        headers: auth(A),
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe('CORPUS_NOT_FOUND');
    });

    it('cross-ORG: PATCH of a foreign corpus is 404 and its config is unchanged', async () => {
      await seedCorpus({ tenant: B_ORG, name: 'private', docs: 1, chunksPerDoc: 1 });
      const before = await app.inject({
        method: 'GET',
        url: '/v1/corpora/private',
        headers: auth(B_ORG),
      });
      expect(before.statusCode).toBe(200);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/corpora/private',
        headers: auth(A),
        payload: { chunkSize: 4000, metadata: { tamperedBy: 'acme' } },
      });
      expect(res.statusCode).toBe(404);

      const after = await app.inject({
        method: 'GET',
        url: '/v1/corpora/private',
        headers: auth(B_ORG),
      });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before.json());
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // /v1/generate — the cross-tenant READ and the cross-tenant CANCEL
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `generate.test.ts` "proved" the cross-tenant 404 by handing its mock an
  // empty row array — the predicate never ran. These seed a real request/job
  // pair owned by B and act as A with the REAL id, which is the actual threat
  // model (a leaked or logged request id must still be unusable).
  describe('/v1/generate', () => {
    /** Seed one request + one job for `t`. Returns the request id. */
    async function seedRequest(
      t: Tenant,
      opts: { unitKey: string; output: unknown; createdAt: Date },
    ): Promise<string> {
      const db = await dbHandle();
      const { generationJobs, generationRequests } = await schema();
      const requestId = (
        await db
          .insert(generationRequests)
          .values({
            org: t.org,
            project: t.project,
            status: 'queued',
            totalJobs: 1,
            createdAt: opts.createdAt,
          })
          .returning({ id: generationRequests.id })
      )[0]!.id;
      await db.insert(generationJobs).values({
        generationRequestId: requestId,
        org: t.org,
        project: t.project,
        unitKey: opts.unitKey,
        unitType: t.org,
        effort: 'standard',
        status: 'queued',
        output: opts.output,
        createdAt: opts.createdAt,
      });
      return requestId;
    }

    it('cross-ORG: GET /v1/generate/:requestId with a REAL foreign id is 404, and the owner still reads it', async () => {
      const requestId = await seedRequest(B_ORG, {
        unitKey: 'u-b',
        output: { text: 'B-ONLY generated output' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const owner = await app.inject({
        method: 'GET',
        url: `/v1/generate/${requestId}`,
        headers: auth(B_ORG),
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().units[0].output).toEqual({ text: 'B-ONLY generated output' });

      const foreign = await app.inject({
        method: 'GET',
        url: `/v1/generate/${requestId}`,
        headers: auth(A),
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain('B-ONLY');
    });

    it('cross-ORG: GET /v1/generate/units/:unitKey/latest never returns another tenant’s NEWER job for the same unitKey', async () => {
      // A's job is OLDER. The route orders by `createdAt desc` and takes one,
      // so without the org predicate A would receive B's row — deterministically.
      await seedRequest(A, {
        unitKey: 'u-shared',
        output: { text: 'A output' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await seedRequest(B_ORG, {
        unitKey: 'u-shared',
        output: { text: 'B-ONLY output' },
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/generate/units/u-shared/latest',
        headers: auth(A),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().unit.output).toEqual({ text: 'A output' });
      expect(res.body).not.toContain('B-ONLY');
    });

    it('cross-ORG: POST /v1/generate/:requestId/cancel is a 404 that leaves the foreign request QUEUED', async () => {
      const { generationRequests } = await schema();
      const db = await dbHandle();
      const requestId = await seedRequest(B_ORG, {
        unitKey: 'u-b',
        output: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/generate/${requestId}/cancel`,
        headers: auth(A),
      });
      expect(res.statusCode).toBe(404);

      // 🔴 Read the row back: a cancel is a WRITE, so "404" alone does not
      // prove the write did not happen.
      const rows = await db
        .select({
          status: generationRequests.status,
          cancelledAt: generationRequests.cancelledAt,
        })
        .from(generationRequests)
        .where(eq(generationRequests.id, requestId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'queued', cancelledAt: null });

      // The owner CAN cancel it — so the 404 above is the predicate, not a
      // broken cancel path.
      const owner = await app.inject({
        method: 'POST',
        url: `/v1/generate/${requestId}/cancel`,
        headers: auth(B_ORG),
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json()).toMatchObject({ cancelled: true });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // /v1/budget/:org — the cross-tenant MONEY surface
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Two independent defences guard this route and each is mutated separately
  // below: the `req.params.org !== req.auth.org` equality check (403), and the
  // `eq(budgetState.org, org)` / `eq(usageLogs.org, org)` predicates on the
  // three reads. `src/routes/budget.test.ts` stubs the query chain with a
  // `where()` that takes no argument, so the second defence was untested.
  //
  // Only tenant B is seeded, deliberately: with the predicate present, A falls
  // back to the bootstrap default (100/100, spend 0); without it, A reads B's
  // numbers. That makes the mutation deterministic rather than a coin flip on
  // which row `limit(1)` happens to return.
  describe('/v1/budget/:org', () => {
    async function seedBudgetFor(org: string, limit: string, remaining: string, spend: string) {
      const db = await dbHandle();
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES (${org}, ${limit}::numeric, ${remaining}::numeric)
        ON CONFLICT ("org") DO UPDATE
          SET "limit_usd" = ${limit}::numeric, "remaining_usd" = ${remaining}::numeric
      `);
      await db.execute(sql`
        INSERT INTO "usage_logs" ("org", "project", "actual_cost_usd")
        VALUES (${org}, 'chat', ${spend}::numeric)
      `);
    }

    it('cross-ORG: GET is 403, and A’s OWN read carries none of B’s limit, remaining or spend', async () => {
      await seedBudgetFor(B_ORG.org, '999', '888', '77');

      const forbidden = await app.inject({
        method: 'GET',
        url: `/v1/budget/${B_ORG.org}`,
        headers: auth(A),
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body).not.toContain('999');

      // A has NO budget row, so the bootstrap default is the correct answer.
      // Reading B's 999/888/77 here would mean the query predicate is gone.
      const own = await app.inject({
        method: 'GET',
        url: `/v1/budget/${A.org}`,
        headers: auth(A),
      });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({
        org: A.org,
        limitUsd: 100,
        remainingUsd: 100,
        spentUsd: 0,
      });
    });

    it('cross-ORG: an ADMIN key cannot PUT another org’s cap — 403, and B’s row is unchanged', async () => {
      await seedBudgetFor(B_ORG.org, '999', '888', '0');
      const db = await dbHandle();

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/budget/${B_ORG.org}`,
        headers: auth({ ...A, key: 'admin-a' }),
        payload: { limitUsd: 1, refill: true },
      });
      // Admin is a ROLE, not a wider tenancy: it must not reach another org.
      expect(res.statusCode).toBe(403);

      // Read the row back — a PUT is a write, so the status code alone does
      // not prove B's cap survived.
      const rows = await db.execute(sql`
        SELECT "limit_usd"::text AS limit_usd, "remaining_usd"::text AS remaining_usd
        FROM "budget_state" WHERE "org" = ${B_ORG.org}
      `);
      expect([...rows]).toEqual([
        { limit_usd: '999.000000000', remaining_usd: '888.000000000' },
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 POST /v1/generate — the cross-tenant DELETE VIA `clientRequestId`
  // ══════════════════════════════════════════════════════════════════════════
  //
  // THIS ONE IS NOT A WEAK TEST. IT IS A REAL DEFECT THIS FILE FOUND.
  //
  // `enqueueGeneration` resolves idempotency in two steps, and only the first
  // was tenant-scoped:
  //
  //   1. `checkIdempotency(db, { org: ctx.org, clientRequestId })` — correctly
  //      carries `eq(generationRequests.org, args.org)`. When the caller's own
  //      org has no row for the key it returns `{ kind: 'new' }`.
  //   2. …at which point the orchestrator "probes once more for a same-key row"
  //      to recover the STALE row's id, so it can delete it inside the insert
  //      transaction. That probe carried NO org predicate:
  //
  //        .from(generationRequests)
  //        .where(eq(generationRequests.clientRequestId, req.clientRequestId))
  //
  //      and its result is fed straight to
  //      `tx.delete(generationRequests).where(eq(generationRequests.id, staleId))`.
  //
  // The partial unique index is `("org","client_request_id")`, so the SAME key
  // legitimately exists in two orgs. Step 1 therefore returns `new` for tenant
  // A precisely when the only row holding that key belongs to tenant B — and
  // step 2 then resolves to B's row and DELETES it. `generation_jobs` is
  // `ON DELETE CASCADE`, so B's completed unit outputs go with it.
  //
  // `clientRequestId` is caller-supplied (`z.string().min(1).max(200)`), never
  // namespaced, and consumers set it to predictable correlation values — an
  // order id, a story id, a date. Any authenticated app key could destroy
  // another tenant's generation batch by guessing one.
  //
  // The row seeded below is FRESH (createdAt = now), so it is not stale by any
  // reading: even the 24h window cannot excuse deleting it.
  describe('POST /v1/generate with a foreign clientRequestId', () => {
    const SHARED_KEY = 'order-2026-0001';

    /** ADR-0003 D5 — an org with no `budget_state` row 402s, so seed A's. */
    async function seedBudget(org: string): Promise<void> {
      const db = await dbHandle();
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES (${org}, 100::numeric, 100::numeric)
        ON CONFLICT ("org") DO UPDATE
          SET "limit_usd" = 100::numeric, "remaining_usd" = 100::numeric
      `);
    }

    /** A live request + job owned by `t`, carrying `clientRequestId`. */
    async function seedKeyedRequest(t: Tenant, clientRequestId: string): Promise<string> {
      const db = await dbHandle();
      const { generationJobs, generationRequests } = await schema();
      const requestId = (
        await db
          .insert(generationRequests)
          .values({
            org: t.org,
            project: t.project,
            clientRequestId,
            status: 'completed',
            totalJobs: 1,
            createdAt: new Date(),
          })
          .returning({ id: generationRequests.id })
      )[0]!.id;
      await db.insert(generationJobs).values({
        generationRequestId: requestId,
        org: t.org,
        project: t.project,
        unitKey: 'u-b',
        unitType: 'text',
        effort: 'standard',
        status: 'completed',
        output: { text: 'B-ONLY finished output' },
        createdAt: new Date(),
      });
      return requestId;
    }

    /** Does that request row — and its cascaded job — still exist? */
    async function stillThere(requestId: string) {
      const db = await dbHandle();
      const { generationJobs, generationRequests } = await schema();
      const reqRows = await db
        .select({ id: generationRequests.id })
        .from(generationRequests)
        .where(eq(generationRequests.id, requestId));
      const jobRows = await db
        .select({ id: generationJobs.id })
        .from(generationJobs)
        .where(eq(generationJobs.generationRequestId, requestId));
      return { requests: reqRows.length, jobs: jobRows.length };
    }

    it('cross-ORG: A enqueueing with B’s clientRequestId does NOT delete B’s request or its jobs', async () => {
      const B = B_ORG;
        const victimId = await seedKeyedRequest(B, SHARED_KEY);
        expect(await stillThere(victimId)).toEqual({ requests: 1, jobs: 1 });
        await seedBudget(A.org);

        const res = await app.inject({
          method: 'POST',
          url: '/v1/generate',
          headers: auth(A),
          payload: {
            clientRequestId: SHARED_KEY,
            units: [
              {
                unitKey: 'a-unit',
                input: { name: 'Ada' },
                specOverride: { promptTemplate: 'Hello {{name}}.' },
              },
            ],
          },
        });

        // A's OWN enqueue must succeed — the key is free in A's scope. A 409
        // here would mean we had over-corrected into a cross-tenant CONFLICT,
        // which leaks B's existence just as surely as the delete destroyed it.
        expect(res.statusCode).toBe(200);
        const created = res.json() as { requestId: string };
        expect(created.requestId).not.toBe(victimId);

        // 🔴 THE ASSERTION THAT MATTERS. Read the victim's rows back. The
        // response above says nothing about them: `staleId` is never returned
        // to the caller, so a successful enqueue and a destroyed neighbour look
        // identical from the wire.
        expect(await stillThere(victimId)).toEqual({ requests: 1, jobs: 1 });

        // …and B can still read its own output, so the row is intact rather
        // than merely present.
        const owner = await app.inject({
          method: 'GET',
          url: `/v1/generate/${victimId}`,
          headers: auth(B),
        });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().units[0].output).toEqual({ text: 'B-ONLY finished output' });
    });

    // ── The SAME-ORG, different-project case is a DIFFERENT ANSWER, and it is
    // the schema's answer, not a bug. `generation_requests` carries a partial
    // unique index on `("org","client_request_id")` — `project` is not in it
    // (`drizzle/0000_baseline.sql:336`), and `checkIdempotency` matches that by
    // scoping on org alone. So a sibling project in the same org legitimately
    // COLLIDES on the key: the correct outcome is a 409 conflict, not a second
    // row and not a delete.
    //
    // ⚠ IT IS ASSERTED HERE ANYWAY, because the destructive half is what
    // matters and the status code does not settle it: a 409 that had already
    // deleted the sibling's row inside the transaction would look identical
    // from the wire. So the row is read back after the 409 too.
    //
    // ⚠ AND IT IS A KNOWN, DELIBERATE ASYMMETRY WORTH KNOWING ABOUT: every
    // other surface in this file treats `(org, project)` as the tenancy unit,
    // while idempotency treats `org` as the unit. Narrowing the index to
    // include `project` would be a migration AND a consumer-visible behaviour
    // change (today's 409 would become a 200), so it is flagged, not changed.
    it('same-ORG different-PROJECT: the key collides by design — 409, and the sibling’s row survives', async () => {
      const victimId = await seedKeyedRequest(B_PROJECT, SHARED_KEY);
      await seedBudget(A.org);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers: auth(A),
        payload: {
          clientRequestId: SHARED_KEY,
          units: [
            {
              unitKey: 'a-unit',
              input: { name: 'Ada' },
              specOverride: { promptTemplate: 'Hello {{name}}.' },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(409);

      // 🔴 A conflict is not a licence to delete. Read the row back.
      expect(await stillThere(victimId)).toEqual({ requests: 1, jobs: 1 });
    });

    // The positive control for the whole mechanism: within ONE tenant the
    // stale-row replacement must keep working. Without this, adding the org
    // predicate could have been "fixed" by deleting the probe altogether and
    // nothing here would have noticed.
    it('same tenant: a STALE own row with the same key is still replaced, not duplicated', async () => {
      const db = await dbHandle();
      const { generationRequests } = await schema();
      await seedBudget(A.org);

      // 25h old ⇒ outside the 24h idempotency window ⇒ `{ kind: 'new' }` plus
      // a stale row to clear.
      const staleId = (
        await db
          .insert(generationRequests)
          .values({
            org: A.org,
            project: A.project,
            clientRequestId: SHARED_KEY,
            status: 'completed',
            totalJobs: 1,
            createdAt: new Date(Date.now() - 25 * 3600 * 1000),
          })
          .returning({ id: generationRequests.id })
      )[0]!.id;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers: auth(A),
        payload: {
          clientRequestId: SHARED_KEY,
          units: [
            {
              unitKey: 'a-unit',
              input: { name: 'Ada' },
              specOverride: { promptTemplate: 'Hello {{name}}.' },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);

      // The stale row is gone and exactly one row holds the key for A —
      // which is also what the partial unique index requires.
      const rows = await db
        .select({ id: generationRequests.id })
        .from(generationRequests)
        .where(
          and(
            eq(generationRequests.org, A.org),
            eq(generationRequests.clientRequestId, SHARED_KEY),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(staleId);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // POST /v1/retrieve via an ALIAS — the SECOND, independent tenant gate
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `lookupCorpus` has two tenant checks, not one. When the by-name read misses
  // it tries `corpus_aliases`, and then RE-CHECKS the resolved target:
  //
  //   corpus_aliases  WHERE org = … AND project = … AND name = …   ← gate 1
  //   corpora         WHERE org = … AND project = … AND id = …     ← gate 2
  //
  // Gate 2 had NO test anywhere in the repo — not a weak one, none — because
  // reaching it needs an alias row whose target lives in another tenant, and the
  // write path (`corpus-alias.ts`) resolves the target in the CALLER's scope so
  // the API cannot create one. That is exactly why gate 2 exists and why it must
  // be tested: it is the defence against a row that arrived some other way — a
  // migration, a restore, a direct SQL fix, a future bulk import.
  //
  // So the second case below writes that row directly. This is the one place in
  // this file where the fixture is deliberately something the API would refuse
  // to produce; the point is that the READ path refuses it anyway.
  describe('POST /v1/retrieve via an alias', () => {

    // `/v1/retrieve*` is metered (AIS-7) and fail-closed: each org needs a
    // budget row. Scoped to this block — the /v1/budget cases need A WITHOUT one.
    beforeEach(async () => {
      const db = await dbHandle();
      await db.execute(sql`
        INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd")
        VALUES ('acme', 100::numeric, 100::numeric), ('other', 100::numeric, 100::numeric)
        ON CONFLICT ("org") DO UPDATE SET "remaining_usd" = 100::numeric
      `);
    });
    const SECRET = 'B-ONLY: alias-reachable secret 41.7M';

    async function makeAlias(tenant: Tenant, name: string, targetCorpusId: string) {
      const db = await dbHandle();
      const { corpusAliases } = await schema();
      await db.insert(corpusAliases).values({
        org: tenant.org,
        project: tenant.project,
        name,
        targetCorpusId,
      });
    }

    // ⚠ MEASURED, AND WORTH KNOWING BEFORE YOU TRUST THIS CASE: over HTTP the
    // two gates are REDUNDANT, and this first case cannot tell them apart.
    // Deleting `eq(corpusAliases.org, ctx.org)` (gate 1) alone leaves this test
    // GREEN — A then finds B's alias row, but gate 2 refuses to load B's corpus
    // by id and the request still 404s. Verified by running exactly that
    // mutation: 18 passed, 0 failed.
    //
    // That redundancy is a good property of the production code and a bad one
    // for a test that means to pin gate 1, so gate 1's mutation coverage lives
    // where it CAN fail: `src/services/rag/retrieve.test.ts` →
    // "the ALIAS lookup is scoped to (org, project)", which goes red on that
    // same deletion. The case below is the end-to-end statement that the leak
    // is closed; the NEXT case is the one that isolates gate 2.
    it('cross-ORG: an alias NAME owned by another tenant is a 404, while its owner still resolves it', async () => {
      const { corpusId } = await seedCorpus({
        tenant: B_ORG,
        name: 'ledger-v3',
        docs: 1,
        chunksPerDoc: 1,
        chunkText: SECRET,
      });
      await makeAlias(B_ORG, 'ledger:latest', corpusId);

      // Positive control: the alias works for its owner, so the 404 below is
      // the predicate rather than a broken alias path.
      const owner = await app.inject({
        method: 'POST',
        url: '/v1/retrieve',
        headers: auth(B_ORG),
        payload: { corpus: 'ledger:latest', query: SECRET, topK: 5 },
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().chunks.map((c: { text: string }) => c.text)).toEqual([SECRET]);

      const foreign = await app.inject({
        method: 'POST',
        url: '/v1/retrieve',
        headers: auth(A),
        payload: { corpus: 'ledger:latest', query: SECRET, topK: 5 },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain('41.7M');
    });

    it('🔴 an alias row of A’s that POINTS AT B’s corpus still does not resolve — the target is re-checked', async () => {
      const { corpusId: bCorpus } = await seedCorpus({
        tenant: B_ORG,
        name: 'ledger-v4',
        docs: 1,
        chunksPerDoc: 1,
        chunkText: SECRET,
      });
      // The row the API would never write. Gate 1 passes here — the alias is
      // A's own — so ONLY gate 2 stands between A and B's chunks.
      await makeAlias(A, 'ledger:latest', bCorpus);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/retrieve',
        headers: auth(A),
        payload: { corpus: 'ledger:latest', query: SECRET, topK: 5 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('41.7M');

      // B is unaffected and still reads its own corpus by name.
      const owner = await app.inject({
        method: 'POST',
        url: '/v1/retrieve',
        headers: auth(B_ORG),
        payload: { corpus: 'ledger-v4', query: SECRET, topK: 5 },
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().chunks.map((c: { text: string }) => c.text)).toEqual([SECRET]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GET /v1/internal/latest-trace — the SAME-ORG, DIFFERENT-PROJECT leak
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `routes/internal.ts` filtered `traces` by `org` ALONE, while its own header
  // comment claimed it returned "the most recent trace row for the caller's
  // {org, project}". `traces` carries BOTH halves via `scopingColumns()`
  // (`src/db/schema/index.ts`), so a key scoped to one project could read a
  // sibling project's trace row out of the same org. An absent rule is the
  // widest rule.
  //
  // ⚠ Why this one hid: every other case in this file is reachable cross-ORG,
  // and cross-ORG could NEVER expose this bug — the org half was always there.
  // Only B_PROJECT (same org `acme`, different project) can, which is exactly
  // the tenant a cross-org-only suite never uses.
  //
  // The route is `order by created_at desc limit 1`, so making the FOREIGN row
  // the NEWER one turns "would it leak" into a deterministic answer rather than
  // a coin flip over which row `limit(1)` happens to return: drop the project
  // predicate and A receives B_PROJECT's row every single time. Nothing here is
  // timing-dependent — both `createdAt` values are fixed literals five months
  // apart, forced at insert time.
  describe('GET /v1/internal/latest-trace', () => {
    /**
     * Seed one trace owned by `t`, stamped with `unitKey` inside the `metadata`
     * JSONB — there is no `unit_key` column on `traces`, which is why the route
     * matches on `metadata->>'unitKey'`.
     *
     * `traces` is in `truncateEachTest` (`src/test/integration-database.ts`), so
     * each case here starts with an empty table.
     */
    async function seedTrace(
      t: Tenant,
      opts: { unitKey: string; label: string; createdAt: Date },
    ): Promise<string> {
      const db = await dbHandle();
      const { traces } = await schema();
      const rows = await db
        .insert(traces)
        .values({
          org: t.org,
          project: t.project,
          status: 'completed',
          label: opts.label,
          model: 'mock/model',
          actualCostUsd: '0.000100',
          metadata: { unitKey: opts.unitKey },
          createdAt: opts.createdAt,
        })
        .returning({ id: traces.id });
      return rows[0]!.id;
    }

    const latest = (t: Tenant, unitKey: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/internal/latest-trace?unitKey=${encodeURIComponent(unitKey)}`,
        headers: auth(t),
      });

    it('🔴 same-ORG different-PROJECT: A gets its OWN trace id, never the sibling project’s NEWER row for the same unitKey', async () => {
      const UNIT = 'unit-shared-across-projects';

      // A's row is OLDER by five months, so `order by created_at desc limit 1`
      // prefers B_PROJECT's row whenever the project predicate is missing.
      const aTraceId = await seedTrace(A, {
        unitKey: UNIT,
        label: 'A-trace',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const bTraceId = await seedTrace(B_PROJECT, {
        unitKey: UNIT,
        label: 'B-PROJECT-ONLY-trace',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      // Two DISTINCT rows, or the assertion below proves nothing.
      expect(aTraceId).not.toBe(bTraceId);

      const res = await latest(A, UNIT);
      expect(res.statusCode).toBe(200);
      expect(res.json().traceId).toBe(aTraceId);
      expect(res.json().traceId).not.toBe(bTraceId);
      expect(res.body).not.toContain('B-PROJECT-ONLY');

      // Positive control: B_PROJECT's row IS reachable — by its owner. Without
      // this, the case above would pass just as happily against a database that
      // never received the sibling row at all.
      const owner = await latest(B_PROJECT, UNIT);
      expect(owner.statusCode).toBe(200);
      expect(owner.json().traceId).toBe(bTraceId);
      expect(owner.json().label).toBe('B-PROJECT-ONLY-trace');
    });

    for (const [label, B] of [
      ['cross-ORG', B_ORG],
      ['same-ORG different-PROJECT', B_PROJECT],
    ] as const) {
      it(`${label}: a unitKey that exists ONLY in the other tenant is a 404 for A, and its owner still reads it`, async () => {
        const UNIT = `unit-only-in-${B.org}-${B.project}`;
        const bTraceId = await seedTrace(B, {
          unitKey: UNIT,
          label: 'B-ONLY-trace',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        });

        const foreign = await latest(A, UNIT);
        // 404, never 403: a foreign row must be indistinguishable from a
        // missing one, or the status code itself leaks existence.
        expect(foreign.statusCode).toBe(404);
        expect(foreign.body).not.toContain(bTraceId);
        expect(foreign.body).not.toContain('B-ONLY');

        const owner = await latest(B, UNIT);
        expect(owner.statusCode).toBe(200);
        expect(owner.json().traceId).toBe(bTraceId);
      });
    }
  });
});
