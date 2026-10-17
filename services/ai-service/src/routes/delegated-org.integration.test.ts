// ORG DELEGATION, PROVEN AGAINST A REAL POSTGRES.
//
// One API key with `delegateOrgPrefix: 'acme-'` acts as org `acme-<suffix>`
// when it sends `X-AI-Org: <suffix>` (see `src/plugins/auth.ts`). The claim
// under test is that EVERY downstream path follows that effective org, because
// each one reads `req.auth.org` and never the key config. So: two delegated
// orgs under ONE key must be as isolated as two orgs with two keys.
//
// Same shape as `tenant-isolation.integration.test.ts`: seed or create a row
// for one org, act as the other, and assert both the refusal AND that the
// owner still reaches its row (so an empty database cannot pass).
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only` here: the integration lane has no
// skip path, and `integration-database.test.ts` fails the unit suite if an
// integration file gates itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeEmbedOne, startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import { eq, sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls `config/env.ts` / `server.ts`.
const fake = await startFakeProvider();
Object.assign(process.env, fake.env);
process.env.API_KEYS = JSON.stringify({
  'deleg-admin': { org: 'acme', project: 'chat', role: 'admin', delegateOrgPrefix: 'acme-' },
  'deleg-app': { org: 'acme', project: 'chat', role: 'app', delegateOrgPrefix: 'acme-' },
  // A dedicated key whose own org sits INSIDE the delegation prefix. Boot used
  // to refuse this; owner decision 2026-10-16 allows it.
  'sub-a': { org: 'acme-a', project: 'chat', role: 'app' },
});

import type { FastifyInstance } from 'fastify';

const as = (key: string, suffix?: string) => ({
  authorization: `Bearer ${key}`,
  ...(suffix !== undefined ? { 'x-ai-org': suffix } : {}),
});

async function dbHandle() {
  const { db } = await import('../db/client.js');
  return db;
}

describe('org delegation against a real Postgres', () => {
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
    const db = await dbHandle();
    await db.execute(
      sql`TRUNCATE TABLE corpus_aliases, chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
    await db.execute(sql`TRUNCATE TABLE budget_state, usage_logs RESTART IDENTITY CASCADE`);
  });

  it('a corpus created as acme-a is stamped with org acme-a, and acme-b cannot see or retrieve it', async () => {
    const SECRET = 'A-ONLY: the figure is 41.7M';

    const created = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: as('deleg-app', 'a'),
      payload: { name: 'ledger' },
    });
    expect(created.statusCode).toBe(201);

    const db = await dbHandle();
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const rows = await db
      .select({ id: corpora.id, org: corpora.org, project: corpora.project })
      .from(corpora)
      .where(eq(corpora.name, 'ledger'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org: 'acme-a', project: 'chat' });

    // Seed one chunk under acme-a so retrieval has something to leak.
    const corpusId = rows[0]!.id;
    const doc = (
      await db
        .insert(documents)
        .values({ corpusId, org: 'acme-a', project: 'chat', externalId: 'd0', text: SECRET })
        .returning({ id: documents.id })
    )[0]!.id;
    await db.insert(chunks).values({
      documentId: doc,
      corpusId,
      org: 'acme-a',
      project: 'chat',
      ordinal: 0,
      text: SECRET,
      embedding: fakeEmbedOne(SECRET),
    });

    // Positive control: the owner retrieves it.
    const owner = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: as('deleg-app', 'a'),
      payload: { corpus: 'ledger', query: SECRET, topK: 5 },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().chunks.map((c: { text: string }) => c.text)).toEqual([SECRET]);

    // Sibling delegated org, SAME key: 404, nothing leaks.
    const sibling = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: as('deleg-app', 'b'),
      payload: { corpus: 'ledger', query: SECRET, topK: 5 },
    });
    expect(sibling.statusCode).toBe(404);
    expect(sibling.body).not.toContain('41.7M');

    // The key's own org (no header) is a different org too.
    const parent = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: as('deleg-app'),
      payload: { corpus: 'ledger', query: SECRET, topK: 5 },
    });
    expect(parent.statusCode).toBe(404);
    expect(parent.body).not.toContain('41.7M');

    const listB = await app.inject({ method: 'GET', url: '/v1/corpora', headers: as('deleg-app', 'b') });
    expect(listB.statusCode).toBe(200);
    expect(listB.body).not.toContain('ledger');
  });

  it('budget is per delegated org: acme-a sets its cap, acme-b cannot read or write it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/budget/acme-a',
      headers: as('deleg-admin', 'a'),
      payload: { limitUsd: 7, refill: true },
    });
    expect(put.statusCode).toBe(201); // first cap for the org creates the row

    const own = await app.inject({ method: 'GET', url: '/v1/budget/acme-a', headers: as('deleg-app', 'a') });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ org: 'acme-a', limitUsd: 7, remainingUsd: 7 });

    const crossRead = await app.inject({
      method: 'GET',
      url: '/v1/budget/acme-a',
      headers: as('deleg-app', 'b'),
    });
    expect(crossRead.statusCode).toBe(403);

    const crossWrite = await app.inject({
      method: 'PUT',
      url: '/v1/budget/acme-a',
      headers: as('deleg-admin', 'b'),
      payload: { limitUsd: 1, refill: true },
    });
    expect(crossWrite.statusCode).toBe(403);

    const db = await dbHandle();
    const rows = await db.execute(sql`
      SELECT "org", "limit_usd"::text AS limit_usd FROM "budget_state" ORDER BY "org"
    `);
    // Only acme-a has a row; the parent org `acme` was never touched.
    expect([...rows]).toEqual([{ org: 'acme-a', limit_usd: '7.000000000' }]);
  });

  it('a dedicated key inside the prefix shares only its own org: acme-b stays fenced', async () => {
    for (const suffix of ['a', 'b']) {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/corpora',
        headers: as('deleg-app', suffix),
        payload: { name: `ledger-${suffix}` },
      });
      expect(created.statusCode).toBe(201);
    }

    // The dedicated key IS org acme-a, so it sees acme-a's corpus (by design)…
    const list = await app.inject({ method: 'GET', url: '/v1/corpora', headers: as('sub-a') });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('ledger-a');
    // …and nothing of the sibling acme-b, nor of the parent org.
    expect(list.body).not.toContain('ledger-b');

    // It cannot delegate: X-AI-Org on a key without a prefix is still 403.
    const hop = await app.inject({ method: 'GET', url: '/v1/corpora', headers: as('sub-a', 'b') });
    expect(hop.statusCode).toBe(403);
    expect(hop.body).not.toContain('ledger-b');
  });

  it('POST /v1/tenant/provision provisions the DELEGATED org, not the key org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: as('deleg-admin', 'tenant-7'),
      payload: { budget: { limitUsd: 5 } },
    });
    expect(res.statusCode).toBe(200);

    const db = await dbHandle();
    const rows = await db.execute(sql`SELECT "org" FROM "budget_state" ORDER BY "org"`);
    expect([...rows]).toEqual([{ org: 'acme-tenant-7' }]);

    const readiness = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness',
      headers: as('deleg-app', 'tenant-7'),
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.body).toContain('acme-tenant-7');
  });
});
