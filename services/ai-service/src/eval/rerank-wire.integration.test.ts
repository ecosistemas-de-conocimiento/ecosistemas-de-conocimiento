// The rerank TRANSPORT gate — the half of the rerank rung that a function stub
// cannot reach.
//
// `rerank-eval.integration.test.ts` injects `fixtureReranker`, a plain
// function, so everything between "the service wants a rerank" and "a score
// comes back" is replaced rather than exercised: the request envelope, the
// response envelope and its field aliases, the caller's re-sort, the fail-safe.
// That is exactly the code a real `rerank-service` run depends on.
//
// This file drives the REAL client (`callRerank`, via `realReranker`) against a
// local stub HTTP server that speaks the documented wire shape. It is NEVER
// gated and NEVER skipped: it costs nothing, needs no sibling, and the path it
// covers is the one the gated real run also executes, so `EVAL_REAL_RERANKER=1`
// changes an address rather than a code path.
//
// 🔴 THE ASSERTION THAT MATTERS is the forced inversion. The rerank rung is
// FAIL-SAFE by design — every failure falls back to the fused order, silently.
// So "reranked scores at least as well as hybrid" is satisfied exactly by a
// reranker that never ran, and no quality number can tell the two apart. Only
// an ordering the server alone could have produced can.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import { REAL_RERANK_MODEL, realReranker, setEvalRerankUrl } from './real-reranker.js';
import { startStubRerankServer, type StubRerankServer } from './stub-rerank-server.js';

const ORG = 'eval-rrwire-org';
const PROJECT = 'eval-rrwire-project';
const CORPUS = 'eval-rrwire';
const TOP_K = 8;

describe(`rerank wire — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  let harness: Harness;
  let stub: StubRerankServer;
  let previousRerankUrl: string | undefined;

  const ask = async (query: string) =>
    harness.service.retrieve(
      {
        corpus: CORPUS,
        query,
        topK: TOP_K,
        mode: 'hybrid',
        rerank: true,
        rerankModel: REAL_RERANK_MODEL,
      },
      { org: ORG, project: PROJECT },
    );

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    stub = await startStubRerankServer('overlap');
    previousRerankUrl = setEvalRerankUrl(stub.url);

    await resetEvalCorpus(db, ORG, PROJECT);
    harness = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: CORPUS,
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
      // The REAL HTTP client, not a function stub. Injecting it only forces
      // rerank availability past the `RERANK_ENABLED` gate; the transport
      // underneath is production code.
      reranker: realReranker,
    });
  }, 120_000);

  afterAll(async () => {
    setEvalRerankUrl(previousRerankUrl);
    await stub.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('sends the documented rerank envelope over HTTP', async () => {
    const before = stub.requests.length;
    await ask(GOLDEN_SET[0]!.query);
    expect(stub.requests.length).toBe(before + 1);

    const sent = stub.requests[before]!;
    expect(sent.model).toBe(REAL_RERANK_MODEL);
    expect(sent.query).toBe(GOLDEN_SET[0]!.query);
    expect(Array.isArray(sent.documents)).toBe(true);
    expect(sent.documents!.length).toBeGreaterThan(0);
    expect(sent.documents!.every((d) => typeof d === 'string')).toBe(true);
    // `top_n` is the caller's final topK.
    expect(sent.top_n).toBe(TOP_K);
  });

  it('makes no rerank call at all when rerank is not requested', async () => {
    const before = stub.requests.length;
    await harness.service.retrieve(
      { corpus: CORPUS, query: GOLDEN_SET[0]!.query, topK: TOP_K, mode: 'hybrid' },
      { org: ORG, project: PROJECT },
    );
    expect(stub.requests.length).toBe(before);
  });

  it('returns the order the SERVER scored, not the fused order', async () => {
    // Forced, not observed: the stub scores by position, so the LAST candidate
    // the service sent must come back FIRST. A fail-safe that swallowed the
    // response would leave the fused order in place and fail here.
    stub.setMode('reverse');
    const before = stub.requests.length;
    const { chunks } = await ask(GOLDEN_SET[0]!.query);
    stub.setMode('overlap');

    expect(stub.requests.length).toBe(before + 1);
    const pool = stub.requests[before]!.documents!;
    // Otherwise the "inversion" would be a no-op on a pool of one.
    expect(pool.length).toBeGreaterThan(TOP_K);
    expect(chunks.map((c) => c.text)).toEqual([...pool].reverse().slice(0, TOP_K));
    expect(chunks.map((c) => c.rerankScore)).toEqual(
      chunks.map((_, i) => pool.length - 1 - i),
    );
  });

  it('surfaces rerankScore, mirrors it onto score, and orders by it', async () => {
    const { chunks } = await ask(GOLDEN_SET[0]!.query);
    expect(chunks.length).toBeGreaterThan(0);
    const scores = chunks.map((c) => c.rerankScore);
    expect(scores.every((s) => typeof s === 'number')).toBe(true);
    expect(chunks[0]!.score).toBe(chunks[0]!.rerankScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it('falls back to the fused order when the server errors, without throwing', async () => {
    // The documented fail-safe. Asserted explicitly so the SILENCE is a tested
    // property rather than an accident — and so the inversion test above is
    // known to be the only thing separating "reranked" from "rerank died".
    const fused = (
      await harness.service.retrieve(
        { corpus: CORPUS, query: GOLDEN_SET[0]!.query, topK: TOP_K, mode: 'hybrid' },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);

    stub.setMode('error');
    const { chunks } = await ask(GOLDEN_SET[0]!.query);
    stub.setMode('overlap');

    expect(chunks.map((c) => c.chunkId)).toEqual(fused);
    expect(chunks.every((c) => c.rerankScore === undefined)).toBe(true);
  });
});
