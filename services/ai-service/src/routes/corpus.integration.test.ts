// HTTP integration tests for DELETE /v1/corpus/:name against a real Postgres.
//
// Wiring expectations (see `vitest.integration.config.ts` + `integration-setup.ts`):
//   - DATABASE_URL / REDIS_URL already rebound to TEST_* by the setup file.
//   - Migrations applied; tables truncated by the integration setup's
//     `beforeEach`. (Note: the shared truncate list does NOT include RAG
//     tables; we wipe them ourselves in `beforeEach` below so a previous
//     test's corpus rows don't leak across cases.)
//   - `NODE_ENV=test` ⇒ the in-memory mock queue is used; no Redis writes.
//
// The corpus DELETE routes are APP-ROLE, scoped to the caller's (org, project).
// We rewrite `API_KEYS` BEFORE importing the server so the suite has:
//   - an APP key on `acme/chat` (the primary caller — deletes its OWN corpus),
//   - an APP key on a foreign ORG (`other/chat`) — never used to delete here,
//     but present to prove distinct tenants exist,
//   - an APP key on a foreign PROJECT (`acme/other`) for cross-project seeding,
//   - an ADMIN key on `acme/chat` to prove admin keys STILL work (backward
//     compat — an admin key authenticates like any app key on these routes).
// The security-critical property (cross-tenant delete is a 404 no-op, never
// touches another tenant's rows) is asserted with the app key below.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls `config/env.ts` / `server.ts`.
process.env.API_KEYS = JSON.stringify({
  'app-acme-chat': { org: 'acme', project: 'chat', role: 'app' },
  'app-other-chat': { org: 'other', project: 'chat', role: 'app' },
  'app-acme-other': { org: 'acme', project: 'other', role: 'app' },
  'admin-acme-chat': { org: 'acme', project: 'chat', role: 'admin' },
});

import type { FastifyInstance } from 'fastify';

describe('DELETE /v1/corpus/:name (integration)', () => {
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

  // RAG tables aren't in the shared `truncateAll` (see `integration-setup.ts`
  // comment). Wipe them per-test so each scenario starts on a clean slate.
  beforeEach(async () => {
    const { db } = await import('../db/client.js');
    await db.execute(
      sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
  });

  it('app-role key deletes its OWN populated corpus (chunks → documents → corpora) atomically', async () => {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');

    // Seed: one corpus, two documents, three chunks across them.
    const corpusInsert = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'pop' })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;

    const docInsert = await db
      .insert(documents)
      .values([
        { corpusId, org: 'acme', project: 'chat', text: 'doc-a body' },
        { corpusId, org: 'acme', project: 'chat', text: 'doc-b body' },
      ])
      .returning({ id: documents.id });
    const docAId = docInsert[0]!.id;
    const docBId = docInsert[1]!.id;

    const ones = new Array(1024).fill(0);
    ones[0] = 1;
    await db.insert(chunks).values([
      {
        documentId: docAId,
        corpusId,
        org: 'acme',
        project: 'chat',
        ordinal: 0,
        text: 'a-0',
        embedding: ones,
      },
      {
        documentId: docAId,
        corpusId,
        org: 'acme',
        project: 'chat',
        ordinal: 1,
        text: 'a-1',
        embedding: ones,
      },
      {
        documentId: docBId,
        corpusId,
        org: 'acme',
        project: 'chat',
        ordinal: 0,
        text: 'b-0',
        embedding: ones,
      },
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/pop',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      deleted: { chunks: 3, documents: 2, corpora: 1 },
    });

    // Verify the cascade landed in the database.
    const corpusRows = await db
      .select()
      .from(corpora)
      .where(eq(corpora.id, corpusId));
    expect(corpusRows).toHaveLength(0);
    const docRows = await db
      .select()
      .from(documents)
      .where(eq(documents.corpusId, corpusId));
    expect(docRows).toHaveLength(0);
    const chunkRows = await db
      .select()
      .from(chunks)
      .where(eq(chunks.corpusId, corpusId));
    expect(chunkRows).toHaveLength(0);
  });

  it('returns 404 on a name that does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/nope',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
  });

  it('returns 401 with no bearer token (still an authenticated surface)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/corpus/whatever' });
    expect(res.statusCode).toBe(401);
  });

  it('backward compat: an admin key still deletes its own corpus (authenticates like any key)', async () => {
    const { db } = await import('../db/client.js');
    const { corpora } = await import('../db/schema/index.js');
    await db.insert(corpora).values({ org: 'acme', project: 'chat', name: 'admin-owned' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/admin-owned',
      headers: { authorization: 'Bearer admin-acme-chat' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { chunks: 0, documents: 0, corpora: 1 } });
  });

  it('re-issuing DELETE after success returns 404', async () => {
    const { db } = await import('../db/client.js');
    const { corpora } = await import('../db/schema/index.js');
    await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'temp' });

    const first = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/temp',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      deleted: { chunks: 0, documents: 0, corpora: 1 },
    });

    const second = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/temp',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('CORPUS_NOT_FOUND');
  });

  it('cross-ORG isolation: an app key on org A cannot delete a corpus in org B (404, row intact)', async () => {
    const { db } = await import('../db/client.js');
    const { corpora } = await import('../db/schema/index.js');
    // Seed under org=other, project=chat.
    await db
      .insert(corpora)
      .values({ org: 'other', project: 'chat', name: 'foreign' });

    // acme/chat app key tries to delete org=other's corpus by name — the
    // service's (org, project, name) lookup misses, so this is a 404 no-op and
    // the foreign row must remain intact. This is the security-critical case:
    // the scoping (not the role) is what prevents the cross-tenant delete.
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/foreign',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');

    const stillThere = await db
      .select({ id: corpora.id })
      .from(corpora)
      .where(
        and(
          eq(corpora.org, 'other'),
          eq(corpora.project, 'chat'),
          eq(corpora.name, 'foreign'),
        ),
      );
    expect(stillThere).toHaveLength(1);
  });

  it('cross-PROJECT isolation: an app key on project A cannot delete a same-org corpus in project B (404, row intact)', async () => {
    const { db } = await import('../db/client.js');
    const { corpora } = await import('../db/schema/index.js');
    // Seed under org=acme but a DIFFERENT project.
    await db
      .insert(corpora)
      .values({ org: 'acme', project: 'other', name: 'sibling-proj' });

    // acme/chat app key tries to delete acme/other's corpus by name — project
    // is part of the scope, so this is a 404 no-op and the row stays intact.
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/sibling-proj',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');

    const stillThere = await db
      .select({ id: corpora.id })
      .from(corpora)
      .where(
        and(
          eq(corpora.org, 'acme'),
          eq(corpora.project, 'other'),
          eq(corpora.name, 'sibling-proj'),
        ),
      );
    expect(stillThere).toHaveLength(1);
  });
});
