// HTTP integration tests for POST /v1/corpus/:name/alias against a real
// Postgres, including end-to-end retrieval through an alias.
//
// Wiring (see vitest.integration.config.ts + integration-setup.ts):
//   - DATABASE_URL / REDIS_URL rebound to TEST_* by the setup file.
//   - Migrations applied (incl. 0011_corpus_aliases); RAG tables are NOT in the
//     shared truncate list, so we wipe corpus_aliases + chunks/documents/corpora
//     ourselves in beforeEach.
//   - NODE_ENV=test ⇒ in-memory mock queue; no Redis writes.
//
// The retrieve path is exercised with a stub embedder so the test never calls
// OpenRouter: we inject a fixed query vector by mounting a RetrieveService with
// a mock embedder directly (the route uses the default embedder, so for the
// retrieve-through-alias assertions we call the service, not the HTTP route).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

process.env.API_KEYS = JSON.stringify({
  'admin-acme-chat': { org: 'acme', project: 'chat', role: 'admin' },
  'admin-other-chat': { org: 'other', project: 'chat', role: 'admin' },
  'app-acme-chat': { org: 'acme', project: 'chat', role: 'app' },
});

import type { FastifyInstance } from 'fastify';

// A deterministic embedder: returns the unit vector e0 ([1,0,0,...]) for any
// input. Combined with chunk embeddings that are also e0, every chunk scores 1.
const stubEmbedder = async () => {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return { embeddings: [v], model: 'stub', usage: { inputTokens: 0, estimatedCostUsd: 0 } };
};

describe('POST /v1/corpus/:name/alias (integration)', () => {
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
      sql`TRUNCATE TABLE corpus_aliases, chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
  });

  // Seed a corpus with one doc + one chunk whose embedding is e0. Returns
  // { corpusId, chunkText }.
  async function seedCorpus(opts: {
    org: string;
    project: string;
    name: string;
    chunkText: string;
  }): Promise<{ corpusId: string }> {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const corpusInsert = await db
      .insert(corpora)
      .values({ org: opts.org, project: opts.project, name: opts.name })
      .returning({ id: corpora.id });
    const corpusId = corpusInsert[0]!.id;
    const docInsert = await db
      .insert(documents)
      .values({ corpusId, org: opts.org, project: opts.project, text: 'body' })
      .returning({ id: documents.id });
    const e0 = new Array(1024).fill(0);
    e0[0] = 1;
    await db.insert(chunks).values({
      documentId: docInsert[0]!.id,
      corpusId,
      org: opts.org,
      project: opts.project,
      ordinal: 0,
      text: opts.chunkText,
      embedding: e0,
    });
    return { corpusId };
  }

  it('creates an alias (201), retrieve via alias returns the target chunks', async () => {
    const { db } = await import('../db/client.js');
    const { RetrieveService } = await import('../services/rag/retrieve.js');

    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'from-A' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'A' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ alias: 'X', target: 'A', created: true });

    // Retrieve via the alias name "X" — should return A's chunk.
    const svc = new RetrieveService({ db, embedder: stubEmbedder as never });
    const out = await svc.retrieve(
      { corpus: 'X', query: 'anything', topK: 10 },
      { org: 'acme', project: 'chat' },
    );
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]!.text).toBe('from-A');
  });

  it('repoints an alias (200), retrieve via alias now returns the new target', async () => {
    const { db } = await import('../db/client.js');
    const { RetrieveService } = await import('../services/rag/retrieve.js');

    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'from-A' });
    await seedCorpus({ org: 'acme', project: 'chat', name: 'B', chunkText: 'from-B' });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'A' },
    });
    expect(first.statusCode).toBe(201);

    const svc = new RetrieveService({ db, embedder: stubEmbedder as never });
    const before = await svc.retrieve(
      { corpus: 'X', query: 'q', topK: 10 },
      { org: 'acme', project: 'chat' },
    );
    expect(before.chunks[0]!.text).toBe('from-A');

    // Repoint X → B.
    const repoint = await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'B' },
    });
    expect(repoint.statusCode).toBe(200);
    expect(repoint.json()).toMatchObject({ alias: 'X', target: 'B', created: false });

    const after = await svc.retrieve(
      { corpus: 'X', query: 'q', topK: 10 },
      { org: 'acme', project: 'chat' },
    );
    expect(after.chunks).toHaveLength(1);
    expect(after.chunks[0]!.text).toBe('from-B');
  });

  it('cross-org isolation: cannot alias to a target in another org (404)', async () => {
    // Target lives under org=other; acme admin attempts to alias to it.
    await seedCorpus({ org: 'other', project: 'chat', name: 'foreign', chunkText: 'x' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'foreign' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TARGET_CORPUS_NOT_FOUND');

    // No alias row leaked into acme's scope.
    const { db } = await import('../db/client.js');
    const { corpusAliases } = await import('../db/schema/index.js');
    const rows = await db
      .select({ id: corpusAliases.id })
      .from(corpusAliases)
      .where(and(eq(corpusAliases.org, 'acme'), eq(corpusAliases.name, 'X')));
    expect(rows).toHaveLength(0);
  });

  it('409 when the alias name collides with a real corpus', async () => {
    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'a' });
    await seedCorpus({ org: 'acme', project: 'chat', name: 'realname', chunkText: 'r' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpus/realname/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'A' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALIAS_NAME_CONFLICT');
  });

  it('deleting the target corpus removes the alias; retrieve via alias 404s', async () => {
    const { db } = await import('../db/client.js');
    const { RetrieveService, CorpusNotFoundError } = await import('../services/rag/retrieve.js');

    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'from-A' });
    await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'A' },
    });

    // Delete the target via the HTTP DELETE route — FK cascade drops the alias.
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/A',
      headers: { authorization: 'Bearer admin-acme-chat' },
    });
    expect(del.statusCode).toBe(200);

    const { corpusAliases } = await import('../db/schema/index.js');
    const aliasRows = await db
      .select({ id: corpusAliases.id })
      .from(corpusAliases)
      .where(eq(corpusAliases.name, 'X'));
    expect(aliasRows).toHaveLength(0);

    const svc = new RetrieveService({ db, embedder: stubEmbedder as never });
    await expect(
      svc.retrieve({ corpus: 'X', query: 'q', topK: 10 }, { org: 'acme', project: 'chat' }),
    ).rejects.toBeInstanceOf(CorpusNotFoundError);
  });

  it('403 for an app-role token (admin gating)', async () => {
    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'a' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpus/X/alias',
      headers: { authorization: 'Bearer app-acme-chat' },
      payload: { target: 'A' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 when target equals the alias name', async () => {
    await seedCorpus({ org: 'acme', project: 'chat', name: 'A', chunkText: 'a' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpus/A/alias',
      headers: { authorization: 'Bearer admin-acme-chat' },
      payload: { target: 'A' },
    });
    expect(res.statusCode).toBe(400);
  });
});
