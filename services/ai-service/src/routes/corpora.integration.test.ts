// HTTP integration tests for the /v1/corpora control plane against a real
// Postgres. Exercises the actual SQL the mocked unit tests can't: the insert +
// unique-scope conflict, the grouped doc/chunk count queries, alias resolution
// on GET, and the empty-vs-populated model-change guard on PATCH.
//
// Wiring mirrors corpus.integration.test.ts:
//   - DATABASE_URL/REDIS_URL rebound to TEST_* by integration-setup.ts.
//   - RAG tables are NOT in the shared truncate list, so we wipe them per test.
//   - Routes are APP-ROLE, scoped to (org, project) from the bearer token.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls config/env.ts / server.ts.
process.env.API_KEYS = JSON.stringify({
  'app-acme-chat': { org: 'acme', project: 'chat', role: 'app' },
  'app-other-chat': { org: 'other', project: 'chat', role: 'app' },
});

import type { FastifyInstance } from 'fastify';

describe('/v1/corpora control plane (integration)', () => {
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
      sql`TRUNCATE TABLE chunks, documents, corpus_aliases, corpora RESTART IDENTITY CASCADE`,
    );
  });

  const auth = { authorization: 'Bearer app-acme-chat' };

  it('creates a corpus, then rejects a duplicate name with 409', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: auth,
      payload: { name: 'policies', language: 'spanish', chunkSize: 1200 },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body).toMatchObject({
      name: 'policies',
      language: 'spanish',
      chunkSize: 1200,
      documentCount: 0,
      chunkCount: 0,
    });
    expect(body.embeddingDim).toBeGreaterThan(0);

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: auth,
      payload: { name: 'policies' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CORPUS_ALREADY_EXISTS');
  });

  it('rejects an unknown language (regconfig whitelist) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: auth,
      payload: { name: 'x', language: 'es' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only the caller-scoped corpora, with doc/chunk counts', async () => {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');

    // acme/chat: a corpus with 1 doc + 2 chunks.
    const ins = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'mine' })
      .returning({ id: corpora.id });
    const corpusId = ins[0]!.id;
    const doc = await db
      .insert(documents)
      .values({ corpusId, org: 'acme', project: 'chat', text: 'body' })
      .returning({ id: documents.id });
    const ones = new Array(1024).fill(0);
    ones[0] = 1;
    await db.insert(chunks).values([
      { documentId: doc[0]!.id, corpusId, org: 'acme', project: 'chat', ordinal: 0, text: 'c0', embedding: ones },
      { documentId: doc[0]!.id, corpusId, org: 'acme', project: 'chat', ordinal: 1, text: 'c1', embedding: ones },
    ]);
    // other/chat: a corpus that must NOT show up for acme/chat.
    await db.insert(corpora).values({ org: 'other', project: 'chat', name: 'theirs' });

    const res = await app.inject({ method: 'GET', url: '/v1/corpora', headers: auth });
    expect(res.statusCode).toBe(200);
    const { corpora: list } = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'mine', documentCount: 1, chunkCount: 2 });
  });

  it('introspects one corpus, and resolves an alias to its target', async () => {
    const { db } = await import('../db/client.js');
    const { corpora, corpusAliases } = await import('../db/schema/index.js');
    const ins = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'target-corpus' })
      .returning({ id: corpora.id });
    await db
      .insert(corpusAliases)
      .values({ org: 'acme', project: 'chat', name: 'latest', targetCorpusId: ins[0]!.id });

    const direct = await app.inject({
      method: 'GET',
      url: '/v1/corpora/target-corpus',
      headers: auth,
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json().alias).toBeUndefined();

    const viaAlias = await app.inject({ method: 'GET', url: '/v1/corpora/latest', headers: auth });
    expect(viaAlias.statusCode).toBe(200);
    const body = viaAlias.json();
    expect(body.name).toBe('target-corpus');
    expect(body.alias).toEqual({ name: 'latest', target: 'target-corpus' });

    const missing = await app.inject({ method: 'GET', url: '/v1/corpora/nope', headers: auth });
    expect(missing.statusCode).toBe(404);
  });

  it('patches chunking config, and refuses a model change on a non-empty corpus', async () => {
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const ins = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'cfg', embeddingModel: 'baai/bge-m3' })
      .returning({ id: corpora.id });
    const corpusId = ins[0]!.id;

    // A patch of chunking config succeeds and stamps updatedAt.
    const ok = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/cfg',
      headers: auth,
      payload: { chunkSize: 500, language: 'english' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ chunkSize: 500, language: 'english' });
    expect(ok.json().updatedAt).not.toBeNull();

    // Model change while empty is allowed (dim revalidated).
    const emptyModelChange = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/cfg',
      headers: auth,
      payload: { embeddingModel: 'intfloat/multilingual-e5-large' },
    });
    expect(emptyModelChange.statusCode).toBe(200);
    expect(emptyModelChange.json().embeddingModel).toBe('intfloat/multilingual-e5-large');

    // Now populate the corpus and retry a model change → 409.
    const doc = await db
      .insert(documents)
      .values({ corpusId, org: 'acme', project: 'chat', text: 'body' })
      .returning({ id: documents.id });
    const ones = new Array(1024).fill(0);
    ones[0] = 1;
    await db
      .insert(chunks)
      .values({ documentId: doc[0]!.id, corpusId, org: 'acme', project: 'chat', ordinal: 0, text: 'c0', embedding: ones });

    const locked = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/cfg',
      headers: auth,
      payload: { embeddingModel: 'baai/bge-m3' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('EMBEDDING_MODEL_LOCKED');
  });

  it('refuses to SHRINK chunkSize on a non-empty corpus, but allows raising it', async () => {
    // `chunk_size` is the corpus's advertised retrieve bound, not just an
    // ingestion knob: `/v1/retrieve` clamps stored passage text to
    // `chunk_size * 4` chars. Lowering it under existing rows would make
    // retrieval truncate legitimately-ingested content and flag every row as an
    // anomaly. Raising it is harmless — old rows stay under the new bound.
    const { db } = await import('../db/client.js');
    const { chunks, corpora, documents } = await import('../db/schema/index.js');
    const ins = await db
      .insert(corpora)
      .values({ org: 'acme', project: 'chat', name: 'shrink', chunkSize: 800 })
      .returning({ id: corpora.id });
    const corpusId = ins[0]!.id;

    const patch = async (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/v1/corpora/shrink', headers: auth, payload });

    // EMPTY corpus: shrinking is fine, there is nothing to invalidate.
    const whileEmpty = await patch({ chunkSize: 400 });
    expect(whileEmpty.statusCode).toBe(200);
    expect(whileEmpty.json().chunkSize).toBe(400);

    // Populate it.
    const doc = await db
      .insert(documents)
      .values({ corpusId, org: 'acme', project: 'chat', text: 'body' })
      .returning({ id: documents.id });
    const ones = new Array(1024).fill(0);
    ones[0] = 1;
    await db.insert(chunks).values({
      documentId: doc[0]!.id,
      corpusId,
      org: 'acme',
      project: 'chat',
      ordinal: 0,
      text: 'c0',
      embedding: ones,
    });

    // NON-EMPTY: shrinking is refused with a 409.
    const shrink = await patch({ chunkSize: 200 });
    expect(shrink.statusCode).toBe(409);
    expect(shrink.json().error.code).toBe('CHUNK_SIZE_LOCKED');
    expect(shrink.json().error.message).toContain('cannot lower chunkSize');

    // …and nothing was written — the guard runs before the update.
    const after = await app.inject({ method: 'GET', url: '/v1/corpora/shrink', headers: auth });
    expect(after.json().chunkSize).toBe(400);

    // NON-EMPTY: RAISING is still allowed.
    const raise = await patch({ chunkSize: 1600 });
    expect(raise.statusCode).toBe(200);
    expect(raise.json().chunkSize).toBe(1600);

    // NON-EMPTY: re-sending the SAME value is not a shrink, so it passes.
    const same = await patch({ chunkSize: 1600 });
    expect(same.statusCode).toBe(200);
    expect(same.json().chunkSize).toBe(1600);
  });

  it('deletes a corpus (cascade) and 404s on re-issue', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: auth,
      payload: { name: 'to-delete' },
    });
    const first = await app.inject({
      method: 'DELETE',
      url: '/v1/corpora/to-delete',
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().deleted.corpora).toBe(1);

    const second = await app.inject({
      method: 'DELETE',
      url: '/v1/corpora/to-delete',
      headers: auth,
    });
    expect(second.statusCode).toBe(404);

    const { db } = await import('../db/client.js');
    const { corpora } = await import('../db/schema/index.js');
    const rows = await db.select().from(corpora).where(eq(corpora.name, 'to-delete'));
    expect(rows).toHaveLength(0);
  });
});
