// HTTP integration tests for DELETE /v1/corpus/:name/documents/:externalId
// against a real Postgres. Proves the per-document delete removes ONLY the
// target document's chunks + row and leaves the corpus and SIBLING documents
// intact — the property that distinguishes it from the whole-corpus delete.
//
// Wiring matches corpus.integration.test.ts (TEST_* DB rebound by
// integration-setup.ts; RAG tables wiped per-test below, not in the shared
// truncate list). The per-document DELETE route is APP-ROLE, scoped to the
// caller's (org, project): an app key on acme/chat deletes its OWN documents;
// a doc in another org OR another project is a 404 no-op that leaves the row
// intact. Keys: app on acme/chat (primary), app on other/chat (cross-org
// seeding), app on acme/other (cross-project seeding), admin on acme/chat
// (backward-compat — admin authenticates like any key here).

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

const ones = (() => {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
})();

describe('DELETE /v1/corpus/:name/documents/:externalId (integration)', () => {
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
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
  });

  // Seed one corpus with two documents (doc-1: 2 chunks, doc-2: 1 chunk).
  async function seedTwoDocs() {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const corpusInsert = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'org-7' })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;
    const docInsert = await db
      .insert(documents)
      .values([
        { corpusId, org: 'acme', project: 'chat', externalId: 'doc-1', text: 'doc-1 body' },
        { corpusId, org: 'acme', project: 'chat', externalId: 'doc-2', text: 'doc-2 body' },
      ])
      .returning({ id: documents.id, externalId: documents.externalId });
    const docA = docInsert.find((d) => d.externalId === 'doc-1')!.id;
    const docB = docInsert.find((d) => d.externalId === 'doc-2')!.id;
    await db.insert(chunks).values([
      { documentId: docA, corpusId, org: 'acme', project: 'chat', ordinal: 0, text: 'a-0', embedding: ones },
      { documentId: docA, corpusId, org: 'acme', project: 'chat', ordinal: 1, text: 'a-1', embedding: ones },
      { documentId: docB, corpusId, org: 'acme', project: 'chat', ordinal: 0, text: 'b-0', embedding: ones },
    ]);
    return { corpusId, docA, docB };
  }

  it('deletes only the target doc + its chunks; corpus and sibling survive', async () => {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const { corpusId, docA, docB } = await seedTwoDocs();

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { chunks: 2, documents: 1 } });

    // doc-1 gone (row + chunks).
    expect(await db.select().from(documents).where(eq(documents.id, docA))).toHaveLength(0);
    expect(await db.select().from(chunks).where(eq(chunks.documentId, docA))).toHaveLength(0);
    // doc-2 (sibling) intact, with its chunk.
    expect(await db.select().from(documents).where(eq(documents.id, docB))).toHaveLength(1);
    expect(await db.select().from(chunks).where(eq(chunks.documentId, docB))).toHaveLength(1);
    // corpus row intact.
    expect(await db.select().from(corpora).where(eq(corpora.id, corpusId))).toHaveLength(1);
  });

  it('returns 404 DOCUMENT_NOT_FOUND when the corpus exists but the externalId does not', async () => {
    await seedTwoDocs();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-999',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('returns 404 CORPUS_NOT_FOUND when the corpus does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-nope/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
  });

  it('re-issuing DELETE after success returns 404 DOCUMENT_NOT_FOUND', async () => {
    await seedTwoDocs();
    const first = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('cross-ORG isolation: an app key on org A cannot delete a doc in org B (404, row intact)', async () => {
    const { db } = await import('../db/client.js');
    const { corpora, documents } = await import('../db/schema/index.js');
    const corpusInsert = await db
      .insert(corpora)
      .values({ org: 'other', project: 'chat', name: 'org-99' })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;
    const docInsert = await db
      .insert(documents)
      .values({ corpusId, org: 'other', project: 'chat', externalId: 'doc-1', text: 'foreign' })
      .returning({ id: documents.id });
    const docId = docInsert[0]!.id;

    // acme/chat app key targets org B's corpus name → scoped (org, project,
    // name) lookup misses → 404 no-op, and the foreign doc must remain intact.
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-99/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    expect(await db.select({ id: documents.id }).from(documents).where(eq(documents.id, docId))).toHaveLength(1);
  });

  it('cross-PROJECT isolation: an app key on project A cannot delete a same-org doc in project B (404, row intact)', async () => {
    const { db } = await import('../db/client.js');
    const { corpora, documents } = await import('../db/schema/index.js');
    // Seed under org=acme but a DIFFERENT project (acme/other).
    const corpusInsert = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'other', name: 'proj-b-corpus' })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;
    const docInsert = await db
      .insert(documents)
      .values({ corpusId, org: 'acme', project: 'other', externalId: 'doc-1', text: 'sibling-project' })
      .returning({ id: documents.id });
    const docId = docInsert[0]!.id;

    // acme/chat app key targets acme/other's corpus → project mismatch → 404
    // no-op, foreign-project doc intact.
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/proj-b-corpus/documents/doc-1',
      headers: { authorization: 'Bearer app-acme-chat' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    expect(await db.select({ id: documents.id }).from(documents).where(eq(documents.id, docId))).toHaveLength(1);
  });

  it('returns 401 with no bearer token (still an authenticated surface)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-1',
    });
    expect(res.statusCode).toBe(401);
  });

  it('backward compat: an admin key still deletes its own doc (authenticates like any key)', async () => {
    const { db } = await import('../db/client.js');
    const { documents } = await import('../db/schema/index.js');
    const { docA } = await seedTwoDocs();

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/org-7/documents/doc-1',
      headers: { authorization: 'Bearer admin-acme-chat' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { chunks: 2, documents: 1 } });
    // The admin key's own doc IS deleted (admin authenticates like any key).
    expect(
      await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, docA))),
    ).toHaveLength(0);
  });
});
