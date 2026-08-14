// Integration test for the optional `filter` metadata predicate on retrieve,
// against a real Postgres (plan/open-retrieve-metadata-filter.md §7). Proves
// the jsonb-containment filter is applied PRE-RANKING: a matching filter
// returns the chunk; a non-matching filter returns nothing; and a chunk that
// is *more* vector-similar but fails the filter is excluded even though it
// would have won on cosine score alone (so this is a server-side filter, not
// a post-filter the consumer would have to do).
//
// Wiring mirrors document-delete.integration.test.ts: TEST_* DB rebound by
// integration-setup.ts; RAG tables wiped per-test here (not in the shared
// truncate list). The embedder is INJECTED and deterministic — no OpenRouter
// call — so retrieval ordering is reproducible.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { RetrieveService } from './retrieve.js';
import type { Embedder } from './retrieve.js';

const ORG = 'acme';
const PROJECT = 'chat';
const CORPUS = 'filter-it';

// 1024-dim helper: a unit vector with a single hot dimension. Two chunks with
// the same hot dim are identical (cosine 1); different hot dims are orthogonal
// (cosine 0). Lets us control vector ranking precisely.
function hot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

// Deterministic embedder: the query "A" embeds to the same vector as the
// session-A chunk so A would naturally rank first by cosine.
function makeEmbedder(vec: number[]): Embedder {
  return (async ({ model }: { model: string }) => ({
    embeddings: [vec],
    model,
    usage: { inputTokens: 1, estimatedCostUsd: 0 },
  })) as unknown as Embedder;
}

describe('RetrieveService metadata filter (integration)', () => {
  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const { db } = await import('../../db/client.js');
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
  });

  // Seed one corpus with two docs in different "sessions" plus a no-metadata
  // chunk. The session-B chunk shares the query vector (so it's the MOST
  // similar), the session-A chunk is orthogonal, the null-metadata chunk too.
  async function seed() {
    const { db } = await import('../../db/client.js');
    const { chunks, corpora, documents } = await import('../../db/schema/index.js');

    const corpus = (
      await db
        .insert(corpora)
        .values({ org: ORG, project: PROJECT, name: CORPUS })
        .returning({ id: corpora.id })
    )[0]!.id;

    const docs = await db
      .insert(documents)
      .values([
        { corpusId: corpus, org: ORG, project: PROJECT, externalId: 'doc-a', text: 'a' },
        { corpusId: corpus, org: ORG, project: PROJECT, externalId: 'doc-b', text: 'b' },
        { corpusId: corpus, org: ORG, project: PROJECT, externalId: 'doc-n', text: 'n' },
      ])
      .returning({ id: documents.id, externalId: documents.externalId });
    const idOf = (x: string) => docs.find((d) => d.externalId === x)!.id;

    await db.insert(chunks).values([
      // session A: orthogonal to the query vector (cosine 0).
      { documentId: idOf('doc-a'), corpusId: corpus, org: ORG, project: PROJECT, ordinal: 0,
        text: 'chunk-A', embedding: hot(0), metadata: { sessionId: 'A' } },
      // session B: SAME vector as the query (cosine 1) — most similar.
      { documentId: idOf('doc-b'), corpusId: corpus, org: ORG, project: PROJECT, ordinal: 0,
        text: 'chunk-B', embedding: hot(7), metadata: { sessionId: 'B' } },
      // no metadata at all — must be excluded by any non-empty filter.
      { documentId: idOf('doc-n'), corpusId: corpus, org: ORG, project: PROJECT, ordinal: 0,
        text: 'chunk-N', embedding: hot(7), metadata: null },
    ]);

    return { corpus };
  }

  it('no filter returns chunks across sessions (baseline)', async () => {
    const { db } = await import('../../db/client.js');
    await seed();
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x' },
      { org: ORG, project: PROJECT },
    );
    const sessions = out.chunks.map((c) => c.text).sort();
    expect(sessions).toEqual(['chunk-A', 'chunk-B', 'chunk-N']);
  });

  it('matching filter returns ONLY the matching session, pre-ranking', async () => {
    const { db } = await import('../../db/client.js');
    await seed();
    // Query vector == session B's vector, so B is the most cosine-similar. But
    // we filter to session A: B must NOT appear even though it would win on
    // score, proving the filter is applied before ranking, not after.
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x', filter: { sessionId: 'A' } },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.text)).toEqual(['chunk-A']);
  });

  it('non-matching filter returns no chunks (no error)', async () => {
    const { db } = await import('../../db/client.js');
    await seed();
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x', filter: { sessionId: 'ZZZ' } },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks).toEqual([]);
  });

  it('a non-empty filter excludes NULL-metadata chunks', async () => {
    const { db } = await import('../../db/client.js');
    await seed();
    // Filter on session B — only chunk-B matches; the null-metadata chunk-N
    // (same vector as B) is excluded by the containment predicate.
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x', filter: { sessionId: 'B' } },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.text)).toEqual(['chunk-B']);
  });

  it('empty filter ({}) behaves like no filter', async () => {
    const { db } = await import('../../db/client.js');
    await seed();
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x', filter: {} },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.text).sort()).toEqual(['chunk-A', 'chunk-B', 'chunk-N']);
  });
});
