// The rerank fail-safe must be LOUD — this is the gate on that.
//
// WHY THIS FILE EXISTS
// --------------------
// Rerank is fail-safe by design: every error and every timeout returns the
// fused order, and the response is byte-identical to `rerank: false` minus
// `rerankScore`. Lane F's sabotage S4 proved what that costs — pointed at a
// rerank server returning 500, `passRate`, `MRR`, the `exact-identifier` floor
// and the `reranked >= hybrid` comparison all stayed GREEN. No quality metric
// can tell a working reranker from a dead one.
//
// 🔴 And it is not a hypothetical. Measured on a real CPU
// `rerank-service`: a 40-candidate pool of 800-token chunks takes ~99 s against
// a 5 s `RERANK_TIMEOUT_MS`. So on content of that shape the timeout path is not
// an edge case, it is EVERY call. A feature that fails on every call while
// reporting success is not a degradation, it is a feature that does not exist.
//
// So `retrieve` now reports WHY the rung contributed nothing, through
// `ctx.onRerankDegraded` — the same caller-decides disposition `onSilentLeg`
// uses. This file proves each reason is reachable, is named correctly, and does
// NOT fire when rerank works.
//
// HOW THE TIMEOUT IS PROVED, AND WHY IT IS NOT A RACE
// ---------------------------------------------------
// Fleet rule: a timing-dependent SETUP is acceptable only if the test proves the
// setup actually happened; a timing-dependent ASSERTION never is. Force the
// condition, never widen a window.
//
// Both halves here are forced, not raced:
//   - Ungated, the stub is in `slow` mode and NEVER answers. There is no
//     response to race — the abort is the only way the call can end.
//   - Gated (`EVAL_REAL_RERANKER=1`), the endpoint is a real `rerank-service`.
//     Measured, this corpus's own 32-candidate pool takes 7.47 s
//     there (median of 3) and the service's single fastest call of ANY shape is
//     2.97 s. Against `TIMEOUT_MS` below that is a 7.5x margin at minimum.
// And the assertion is on the CAUSE (`reason === 'timeout'`), not on "a warning
// appeared": a refused connection or a 503 surfaces as `'error'`, so this test
// goes RED rather than green if the endpoint was never really reached.
//
// ⚠ What the gated half CANNOT prove, measured rather than assumed: uvicorn
// emits NO access-log line for a request the client aborts (verified with a
// completed request as the positive control), so the container's own log cannot
// witness the aborted call. The evidence that a real endpoint was reached is
// client-side — `'timeout'` rather than `'error'` — plus the budget being far
// below any response the service can produce.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { RerankDegradedWarning } from '../services/rag/retrieve.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import {
  REAL_RERANK_MODEL,
  isRealRerankerEvalEnabled,
  realReranker,
  realRerankUrl,
  setEvalRerankUrl,
} from './real-reranker.js';
import { startStubRerankServer, type StubRerankServer } from './stub-rerank-server.js';

const ORG = 'eval-rrdeg-org';
const PROJECT = 'eval-rrdeg-project';
const CORPUS = 'eval-rrdeg';
/** A second scope whose service has NO reranker at all — the `unavailable` case. */
const BARE_ORG = 'eval-rrdeg-bare-org';
const BARE_PROJECT = 'eval-rrdeg-bare-project';
const BARE_CORPUS = 'eval-rrdeg-bare';
const TOP_K = 8;
/**
 * The forced-timeout budget. Chosen so BOTH halves are forced, not raced: the
 * stub never answers at all, and the real service's fastest measured call of any
 * shape is 2.97 s — 3x this, with this corpus's own pool measured at 7.47 s. Big
 * enough that a gated request is unambiguously sent and being worked on, rather
 * than aborted before it left.
 */
const TIMEOUT_MS = 1_000;

/** True when the timeout half is pointed at a real `rerank-service`. */
const GATED = isRealRerankerEvalEnabled();

/**
 * The real endpoint, captured at MODULE LOAD and not inside the test.
 *
 * 🔴 This ordering is load-bearing and it bit me: `beforeAll` overwrites
 * `env.RERANK_URL` with the stub's address, and `realRerankUrl()` reads that
 * same field — so calling it from inside the test returns the STUB, and the
 * gated timeout test quietly ran against a fast local server and reported no
 * timeout. It failed rather than passing, which is the test doing its job, but
 * read the address once here where nothing has moved it yet.
 */
const REAL_ENDPOINT = realRerankUrl();

/**
 * Point `RERANK_TIMEOUT_MS` at `ms` for this process, returning the previous
 * value. Writes to the parsed `env` object for exactly the reason
 * `setEvalRerankUrl` documents: `env` is built once at module load, the budget
 * under test is per-call, and `applyRerank` reads `env.RERANK_TIMEOUT_MS` at
 * call time. One narrow, restored write, here, where it is visible.
 */
function setRerankTimeout(ms: number): number {
  const mutable = env as { RERANK_TIMEOUT_MS: number };
  const previous = mutable.RERANK_TIMEOUT_MS;
  mutable.RERANK_TIMEOUT_MS = ms;
  return previous;
}

describe(`rerank degraded warnings — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  let harness: Harness;
  let bare: Harness;
  let stub: StubRerankServer;
  let previousRerankUrl: string | undefined;
  let previousTimeout = 0;
  const QUERY = GOLDEN_SET[0]!.query;

  /** Retrieve with rerank on, collecting every degraded warning this call emits. */
  const askCollecting = async (
    opts: { org?: string; project?: string; corpus?: string } = {},
  ) => {
    const warnings: RerankDegradedWarning[] = [];
    const { chunks } = await (opts.corpus === BARE_CORPUS ? bare : harness).service.retrieve(
      {
        corpus: opts.corpus ?? CORPUS,
        query: QUERY,
        topK: TOP_K,
        mode: 'hybrid',
        rerank: true,
        rerankModel: REAL_RERANK_MODEL,
      },
      {
        org: opts.org ?? ORG,
        project: opts.project ?? PROJECT,
        onRerankDegraded: (w) => warnings.push(w),
      },
    );
    return { chunks, warnings };
  };

  /** The un-reranked ordering, for proving a fallback really fell back. */
  const fusedOrder = async () =>
    (
      await harness.service.retrieve(
        { corpus: CORPUS, query: QUERY, topK: TOP_K, mode: 'hybrid' },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    stub = await startStubRerankServer('overlap');
    previousRerankUrl = setEvalRerankUrl(stub.url);
    previousTimeout = setRerankTimeout(30_000);

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
      reranker: realReranker,
    });

    // No `reranker` injected, so `rerankAvailable` falls back to the
    // `RERANK_ENABLED` + `RERANK_URL` production gate, which is off in tests.
    await resetEvalCorpus(db, BARE_ORG, BARE_PROJECT);
    bare = await buildHarness({
      db,
      org: BARE_ORG,
      project: BARE_PROJECT,
      corpus: BARE_CORPUS,
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
    });
  }, 180_000);

  afterAll(async () => {
    setRerankTimeout(previousTimeout);
    setEvalRerankUrl(previousRerankUrl);
    await stub.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  // ── The control: a working rerank must stay QUIET ────────────────────────
  //
  // Listed first because it is the half that makes the rest mean anything. A
  // warning that fires on every call is exactly as useless as one that never
  // fires, and this is the assertion that rules that out.

  it('emits NOTHING when the rerank succeeds', async () => {
    const { chunks, warnings } = await askCollecting();
    expect(warnings).toEqual([]);
    // Prove the rerank actually ran, so "no warning" is not "nothing happened".
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => typeof c.rerankScore === 'number')).toBe(true);
  });

  // ── timeout ──────────────────────────────────────────────────────────────

  it('names the TIMEOUT when the budget fires, against a real slow endpoint', async () => {
    const fused = await fusedOrder();
    // Forced, per the header: `slow` never answers; the gated endpoint's
    // fastest measured call is 2.97 s. Either way 50 ms cannot be beaten.
    const endpoint = GATED ? REAL_ENDPOINT : stub.url;
    expect(endpoint, 'EVAL_REAL_RERANKER=1 needs RERANK_URL set').toBeTruthy();
    if (!GATED) stub.setMode('slow');
    const restoreUrl = setEvalRerankUrl(endpoint);
    setRerankTimeout(TIMEOUT_MS);

    let observed: { chunks: Awaited<ReturnType<typeof askCollecting>>['chunks']; warnings: RerankDegradedWarning[] };
    try {
      observed = await askCollecting();
    } finally {
      setRerankTimeout(30_000);
      setEvalRerankUrl(restoreUrl);
      if (!GATED) stub.setMode('overlap');
    }

    // The CAUSE, not merely that something warned. A refused connection or a
    // 503 would land here as 'error' and fail, which is the point.
    expect(observed.warnings.length).toBe(1);
    const w = observed.warnings[0]!;
    expect(w.reason).toBe('timeout');
    expect(w.timeoutMs).toBe(TIMEOUT_MS);
    expect(w.scored).toBe(0);
    expect(w.model).toBe(REAL_RERANK_MODEL);
    expect(w.corpus).toBe(CORPUS);
    expect(w.org).toBe(ORG);
    expect(w.poolSize).toBeGreaterThan(TOP_K);
    // …and that the fallback it describes is the one that actually happened.
    expect(observed.chunks.map((c) => c.chunkId)).toEqual(fused);
    expect(observed.chunks.every((c) => c.rerankScore === undefined)).toBe(true);
  }, 120_000);

  // ── error ────────────────────────────────────────────────────────────────
  //
  // This is also the control on `timeout`: if the timer's `timedOut` flag were
  // wrong — stuck true, or inferred from the AbortError rather than set by the
  // timer — this case would report 'timeout' and go red.

  it('names the ERROR, not a timeout, when the server refuses', async () => {
    stub.setMode('error');
    const { chunks, warnings } = await askCollecting().finally(() => stub.setMode('overlap'));

    expect(warnings.length).toBe(1);
    expect(warnings[0]!.reason).toBe('error');
    expect(warnings[0]!.scored).toBe(0);
    expect(warnings[0]!.detail).toBeTruthy();
    expect(chunks.every((c) => c.rerankScore === undefined)).toBe(true);
  });

  // ── backfilled ───────────────────────────────────────────────────────────

  it('names the BACKFILL when the reranker scores fewer than topK', async () => {
    stub.setMode('partial');
    const { chunks, warnings } = await askCollecting().finally(() => stub.setMode('overlap'));

    expect(warnings.length).toBe(1);
    expect(warnings[0]!.reason).toBe('backfilled');
    // The stub scores exactly two documents, so the partial count is exact.
    expect(warnings[0]!.scored).toBe(2);
    expect(chunks.length).toBe(TOP_K);
    expect(chunks.filter((c) => c.rerankScore !== undefined).length).toBe(2);
  });

  // ── unavailable ──────────────────────────────────────────────────────────

  it('names UNAVAILABLE when rerank is asked for but nothing is configured', async () => {
    const { chunks, warnings } = await askCollecting({
      org: BARE_ORG,
      project: BARE_PROJECT,
      corpus: BARE_CORPUS,
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]!.reason).toBe('unavailable');
    expect(warnings[0]!.corpus).toBe(BARE_CORPUS);
    // The query still succeeds — `unavailable` is a report, not a failure.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.rerankScore === undefined)).toBe(true);
  });
});
