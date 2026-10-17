// Integration test for the outbound passage-text bound, against a real
// Postgres.
//
// Why this has to be an INTEGRATION test: the anomaly it defends against
// cannot be produced through the ingester at all. An over-long chunk gets into
// `chunks.text` by a route that bypasses chunking — a row written before the
// splitter had limits, a hand-written backfill script, a migration, or a future
// ingester bug. So the test writes one the same way reality does: straight into
// the table. A unit test with a stubbed DB would be asserting against a fixture
// the production code path never sees.
//
// Wiring mirrors retrieve.integration.test.ts: TEST_* DB rebound by
// integration-setup.ts, RAG tables wiped per test, and a deterministic INJECTED
// embedder so no OpenRouter call happens and ranking is reproducible.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { CHARS_PER_TOKEN, DEFAULT_CHUNK_SIZE, maxChunkChars } from './chunk.js';
import { RetrieveService } from './retrieve.js';
import type { Embedder } from './retrieve.js';
import { RetrieveMultiService } from './retrieve-multi.js';

const ORG = 'acme';
const PROJECT = 'chat';
const CORPUS = 'bound-it';

/** 1024-dim unit vector with a single hot dimension (same helper as the sibling test). */
function hot(dim: number): number[] {
  const v = new Array(1024).fill(0);
  v[dim] = 1;
  return v;
}

function makeEmbedder(vec: number[]): Embedder {
  return (async ({ model }: { model: string }) => ({
    embeddings: [vec],
    model,
    usage: { inputTokens: 1, estimatedCostUsd: 0 },
  })) as unknown as Embedder;
}

/** Recognisable, non-repeating text so a truncation point is unambiguous. */
function longText(chars: number): string {
  let s = '';
  let i = 0;
  while (s.length < chars) {
    s += `[${i}]abcdefghijklmnopqrstuvwxyz `;
    i++;
  }
  return s.slice(0, chars);
}

describe('outbound passage bound (integration)', () => {
  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const { db } = await import('../../db/client.js');
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
  });

  /**
   * Seed one corpus holding a NORMAL chunk and an OVER-LONG chunk. Both share
   * the query vector so both are always returned — the test is about the text,
   * not the ranking.
   */
  async function seed(opts: { chunkSize?: number; overLongChars: number; normalChars: number }) {
    const { db } = await import('../../db/client.js');
    const { chunks, corpora, documents } = await import('../../db/schema/index.js');

    const corpusId = (
      await db
        .insert(corpora)
        .values({
          org: ORG,
          project: PROJECT,
          name: CORPUS,
          ...(opts.chunkSize !== undefined ? { chunkSize: opts.chunkSize } : {}),
        })
        .returning({ id: corpora.id })
    )[0]!.id;

    const docs = await db
      .insert(documents)
      .values([
        { corpusId, org: ORG, project: PROJECT, externalId: 'doc-normal', text: 'n' },
        { corpusId, org: ORG, project: PROJECT, externalId: 'doc-long', text: 'l' },
      ])
      .returning({ id: documents.id, externalId: documents.externalId });
    const idOf = (x: string) => docs.find((d) => d.externalId === x)!.id;

    const normalText = longText(opts.normalChars);
    const overLongText = longText(opts.overLongChars);

    const inserted = await db
      .insert(chunks)
      .values([
        {
          documentId: idOf('doc-normal'),
          corpusId,
          org: ORG,
          project: PROJECT,
          ordinal: 0,
          text: normalText,
          embedding: hot(7),
        },
        {
          // The anomaly: written straight into the table, bypassing the
          // chunker entirely — exactly how a legacy or hand-inserted row got
          // there.
          documentId: idOf('doc-long'),
          corpusId,
          org: ORG,
          project: PROJECT,
          ordinal: 3,
          text: overLongText,
          embedding: hot(7),
        },
      ])
      .returning({ id: chunks.id, ordinal: chunks.ordinal });

    return {
      corpusId,
      normalText,
      overLongText,
      longDocId: idOf('doc-long'),
      longChunkId: inserted.find((c) => c.ordinal === 3)!.id,
    };
  }

  it('proves the fixture really is over-long IN THE DATABASE', async () => {
    // Guards the test itself: if the insert silently truncated (a column type
    // change, say), every assertion below would pass vacuously.
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ overLongChars: 9000, normalChars: 500 });
    const rows = await db.execute(
      sql`SELECT length(text) AS len FROM chunks WHERE id = ${seeded.longChunkId}`,
    );
    expect(Number((rows as unknown as Array<{ len: number }>)[0]!.len)).toBe(9000);
  });

  it('truncates an over-long stored chunk to EXACTLY the bound', async () => {
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ overLongChars: 9000, normalChars: 500 });

    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    const bound = maxChunkChars(DEFAULT_CHUNK_SIZE);
    const long = out.chunks.find((c) => c.chunkId === seeded.longChunkId)!;
    expect(long.text).toHaveLength(bound);
    expect(long.text).toBe(seeded.overLongText.slice(0, bound));
  });

  it('returns a normal chunk BYTE-IDENTICAL — no trimming, no normalisation', async () => {
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ overLongChars: 9000, normalChars: 500 });

    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    const normal = out.chunks.find((c) => c.text.length === 500)!;
    expect(normal.text).toBe(seeded.normalText);
  });

  it('a chunk sitting EXACTLY on the bound is untouched', async () => {
    const { db } = await import('../../db/client.js');
    const bound = maxChunkChars(DEFAULT_CHUNK_SIZE);
    const seeded = await seed({ overLongChars: bound, normalChars: 10 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)), logger });
    const out = await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    const atBound = out.chunks.find((c) => c.chunkId === seeded.longChunkId)!;
    expect(atBound.text).toBe(seeded.overLongText);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('WARNS with the doc/chunk identifiers when the clamp fires', async () => {
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ overLongChars: 9000, normalChars: 500 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)), logger });
    await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    // Exactly once — the normal chunk in the same result must not warn.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      corpusId: seeded.corpusId,
      corpus: CORPUS,
      documentId: seeded.longDocId,
      chunkId: seeded.longChunkId,
      ordinal: 3,
      storedChars: 9000,
      maxChars: maxChunkChars(DEFAULT_CHUNK_SIZE),
      overBy: 9000 - maxChunkChars(DEFAULT_CHUNK_SIZE),
    });
    expect(String(msg)).toContain('exceeds the ingestion chunk-size bound');
  });

  it('the bound is PER-CORPUS — a corpus with a bigger chunk_size is not truncated at 3200', async () => {
    // The regression a global constant would cause: this corpus legitimately
    // stores 2000-token chunks, so 5000 chars is inside ITS contract.
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ chunkSize: 2000, overLongChars: 5000, normalChars: 100 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)), logger });
    const out = await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    const big = out.chunks.find((c) => c.chunkId === seeded.longChunkId)!;
    expect(maxChunkChars(2000)).toBe(2000 * CHARS_PER_TOKEN);
    expect(big.text).toBe(seeded.overLongText);
    expect(big.text).toHaveLength(5000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a corpus with a SMALLER chunk_size gets the smaller bound', async () => {
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ chunkSize: 25, overLongChars: 400, normalChars: 20 });

    const svc = new RetrieveService({ db, embedder: makeEmbedder(hot(7)) });
    const out = await svc.retrieve({ corpus: CORPUS, query: 'x' }, { org: ORG, project: PROJECT });

    const clamped = out.chunks.find((c) => c.chunkId === seeded.longChunkId)!;
    expect(clamped.text).toHaveLength(maxChunkChars(25));
    expect(clamped.text).toBe(seeded.overLongText.slice(0, 100));
  });

  it('multi built WITHOUT an injected service still warns — logger is forwarded', async () => {
    // Regression guard: `RetrieveMultiService` builds its own per-corpus
    // `RetrieveService` in production (nothing is injected there). If it drops
    // the logger while doing so, `/v1/retrieve/multi` truncates silently and the
    // anomaly never surfaces — the clamp would be half a feature.
    const { db } = await import('../../db/client.js');
    await seed({ overLongChars: 9000, normalChars: 500 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const multi = new RetrieveMultiService({ db, logger });
    // Reach past the default embedder (which would call OpenRouter) without
    // injecting the service itself — that is the seam under test.
    (multi as unknown as { retrieveService: { embedder: Embedder } }).retrieveService.embedder =
      makeEmbedder(hot(7));

    const out = await multi.retrieveMulti(
      { corpora: [CORPUS], query: 'x' },
      { org: ORG, project: PROJECT },
    );

    expect(out.chunks.some((c) => c.text.length === maxChunkChars(DEFAULT_CHUNK_SIZE))).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![1])).toContain(
      'exceeds the ingestion chunk-size bound',
    );
  });

  it('the generate-with-RAG context fetch clamps AND warns', async () => {
    // `fetchContext` builds its own RetrieveService (nothing is injected on the
    // generate path), so this covers the same "does it forward the logger?"
    // seam as the multi test above, on the other consumer of retrieval. The
    // passage text here reaches a PROMPT rather than a response body, but an
    // over-bound row is just as much an anomaly there.
    const { db } = await import('../../db/client.js');
    const { fetchContext } = await import('../context/fetch.js');
    await seed({ overLongChars: 9000, normalChars: 500 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const out = await fetchContext({
      org: ORG,
      project: PROJECT,
      includeContext: [{ corpus: CORPUS, query: 'x' }],
      db,
      embedder: makeEmbedder(hot(7)),
      logger,
    });

    const texts = out[CORPUS]!;
    expect(texts.some((t) => t.length === maxChunkChars(DEFAULT_CHUNK_SIZE))).toBe(true);
    expect(texts.every((t) => t.length <= maxChunkChars(DEFAULT_CHUNK_SIZE))).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![1])).toContain(
      'exceeds the ingestion chunk-size bound',
    );
  });

  it('/v1/retrieve/multi inherits the bound (it composes RetrieveService)', async () => {
    const { db } = await import('../../db/client.js');
    const seeded = await seed({ overLongChars: 9000, normalChars: 500 });

    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const inner = new RetrieveService({ db, embedder: makeEmbedder(hot(7)), logger });
    const multi = new RetrieveMultiService({ db, retrieveService: inner });
    const out = await multi.retrieveMulti(
      { corpora: [CORPUS], query: 'x' },
      { org: ORG, project: PROJECT },
    );

    const bound = maxChunkChars(DEFAULT_CHUNK_SIZE);
    const long = out.chunks.find((c) => c.chunkId === seeded.longChunkId)!;
    expect(long.text).toHaveLength(bound);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
