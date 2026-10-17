// Rerank ON/OFF A/B through the REAL rerank client.
//
// WHAT IS DIFFERENT FROM `rerank-eval.integration.test.ts`
// --------------------------------------------------------
// That file injects `fixtureReranker`, a plain function, which replaces the
// HTTP client outright. It measures the rerank RUNG (pool, re-sort, slice,
// fail-safe) and nothing about the transport.
//
// This file drives `realReranker` — literally `callRerank` — so the request
// envelope, the response parsing, the abort signal and the fail-safe all run
// for real. Against a stub HTTP server by default; against a real
// `rerank-service` when `EVAL_REAL_RERANKER=1` and `RERANK_URL` point at one.
// The two paths share one code path here on purpose: the gated run is an
// ADDRESS change, not a different test — NOTHING here is skipped either way.
//
// The transport's own properties — the request envelope, a forced inversion
// that separates a working reranker from a dead one, the fail-safe on an HTTP
// error — live in `rerank-wire.integration.test.ts`, which always runs against
// the stub because those assertions cannot be made against a real service (you
// cannot ask it what it received, or make it score by position). This file is
// the QUALITY half: the same A/B, measured wherever it is pointed.
//
// 🔴 WHAT IS UNVERIFIED. So far nobody has run this against a real
// `rerank-service`. The image is ~6 GB and is not in this repo's
// `docker-compose.yml`, so the numbers below come from the stub and prove the
// WIRING, not cross-encoder quality. The real run belongs to whoever has the
// model server reachable — the inference-box lane — and its result is what the
// A2 decision should actually be read against.
//
// ⚠ COST/DRIFT, when the gate IS on: the self-hosted sibling has no per-call
// bill, but it is CPU-bound (measured ~1.56 s for a small candidate set on a
// busy build server) and its output moves with the served model build. Treat a
// gated number as dated evidence, not as a regression threshold.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
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
import { formatComparison, runConfig } from './runner.js';
import { startStubRerankServer, type StubRerankServer } from './stub-rerank-server.js';
import type { ConfigReport } from './types.js';

const ORG = 'eval-realrr-org';
const PROJECT = 'eval-realrr-project';
const TOP_K = 8;

/** True when this run is pointed at a real `rerank-service` rather than the stub. */
const GATED = isRealRerankerEvalEnabled();

// 🔴 NO ABSOLUTE FLOORS HERE, ON PURPOSE. This file used to compare the reranked
// run against stored numbers (passRate 0.85, MRR 0.80, exact-identifier 0.80).
// They sat BELOW the same run with the rung disabled — hybrid alone scored pass
// 42/43 = 0.977, MRR 0.915, exact-identifier 20/21 = 0.952 (quoted from the
// stub measurement this comment replaces) — so a reranker scoring
// every document 0 left the fused order untouched and passed every gate.
// MEASURED: `fixtureRerankScore` forced to `return 0` was green here.
//
// The only baseline that cannot go stale is the one measured in the same run:
// the SAME corpus and items with the rung switched off. The rerank rung swallows
// every failure and returns the fused order, so `>=` against hybrid is satisfied
// exactly by a reranker that never ran. The relation has to be STRICT: a working
// rung must beat the disabled run, and a tie fails.

describe(`real-reranker eval — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  let harness: Harness;
  let stub: StubRerankServer | null = null;
  let previousRerankUrl: string | undefined;
  let endpoint = '';
  const reports: Record<string, ConfigReport> = {};

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));

    if (GATED) {
      // The gated path deliberately does NOT fall back to the stub. A run asked
      // for real evidence; producing stub numbers under that flag would be the
      // exact failure this repo keeps writing down — a green signal that
      // measured something else.
      const url = realRerankUrl();
      if (!url) {
        throw new Error(
          'EVAL_REAL_RERANKER=1 but RERANK_URL is unset — point it at a running rerank-service.',
        );
      }
      endpoint = url;
    } else {
      stub = await startStubRerankServer('overlap');
      endpoint = stub.url;
      previousRerankUrl = setEvalRerankUrl(endpoint);
    }

    await resetEvalCorpus(db, ORG, PROJECT);
    harness = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-realrr',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
      // The REAL client, not a function stub. Injecting it still forces rerank
      // availability (bypassing `RERANK_ENABLED`), which is the only thing the
      // injection is doing here — the transport underneath is production code.
      reranker: realReranker,
    });

    const items = GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-realrr' }));
    const ctx = { org: ORG, project: PROJECT };

    reports['hybrid'] = await runConfig({
      service: harness.service,
      items,
      config: { name: 'hybrid', topK: TOP_K, mode: 'hybrid' },
      ctx,
      resolveDocId: harness.resolveDocId,
    });
    reports['hybrid+rerank'] = await runConfig({
      service: harness.service,
      items,
      config: {
        name: 'hybrid+rerank',
        topK: TOP_K,
        mode: 'hybrid',
        rerank: true,
        rerankModel: REAL_RERANK_MODEL,
      },
      ctx,
      resolveDocId: harness.resolveDocId,
    });
  }, 300_000);

  afterAll(async () => {
    console.log(
      `\nreal-reranker A/B — endpoint ${endpoint} (${GATED ? 'REAL rerank-service' : 'local stub'}), ` +
        `${harness?.chunkCount ?? '?'} chunks, ${GOLDEN_SET.length} items, topK=${TOP_K}\n` +
        formatComparison(Object.values(reports)),
    );
    if (stub) {
      setEvalRerankUrl(previousRerankUrl);
      await stub.close();
    }
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  // ── 1. The A/B ran against a live endpoint ──────────────────────────────
  //
  // The transport itself — request envelope, response parsing, the fail-safe,
  // and the forced inversion that tells a working reranker from a dead one —
  // is proved in `rerank-wire.integration.test.ts`, which always runs against
  // the stub. This file measures QUALITY against whatever endpoint is
  // configured, so its job here is to show that an endpoint answered at all.

  it('gets a live rerank score back from the configured endpoint', async () => {
    const item = GOLDEN_SET[0]!;
    const { chunks } = await harness.service.retrieve(
      {
        corpus: 'eval-realrr',
        query: item.query,
        topK: TOP_K,
        mode: 'hybrid',
        rerank: true,
        rerankModel: REAL_RERANK_MODEL,
      },
      { org: ORG, project: PROJECT },
    );
    expect(chunks.length).toBeGreaterThan(0);
    const scores = chunks.map((c) => c.rerankScore);
    expect(scores.every((s) => typeof s === 'number')).toBe(true);
    // `score` mirrors `rerankScore` on a reranked result, and the list is sorted.
    expect(chunks[0]!.score).toBe(chunks[0]!.rerankScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  // ── 2. Rerank stays safe, and is worth its place ─────────────────────────

  it('rerank preserves the forbidden-content floor', () => {
    expect(reports['hybrid+rerank']!.totalForbiddenHits).toBe(0);
  });

  it('rerank beats the same run with the rung disabled (strictly)', () => {
    const hybrid = reports['hybrid']!;
    const reranked = reports['hybrid+rerank']!;
    expect(reranked.passRate, 'reranked passRate vs hybrid').toBeGreaterThan(hybrid.passRate);
    expect(reranked.mrr, 'reranked MRR vs hybrid').toBeGreaterThan(hybrid.mrr);
    const hybridId = hybrid.byTag['exact-identifier'];
    const rerankedId = reranked.byTag['exact-identifier'];
    expect(hybridId, 'no exact-identifier slice (hybrid)').toBeDefined();
    expect(rerankedId, 'no exact-identifier slice (reranked)').toBeDefined();
    expect(rerankedId!.passRate, 'reranked exact-identifier vs hybrid').toBeGreaterThan(
      hybridId!.passRate,
    );
  });
});
