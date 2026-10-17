// Offline rerank-rung gate.
//
// Proves the cross-encoder rerank rung wires end-to-end through the REAL
// ingest+retrieve machinery, using the deterministic offline `fixtureReranker`
// (zero network, zero cost — so this runs in the integration suite on every
// change, like the hybrid gate beside it).
//
// It asserts the properties that must hold for rerank to be SAFE to ship, not a
// production-quality number (the fixture reranker models exact-term sharpening,
// not semantic relevance — see `fixture-reranker.ts`):
//
//   1. CORRECTNESS FLOOR PRESERVED — rerank never introduces a superseded
//      citation. A re-ordering rung must not resurrect forbidden content.
//   2. rerankScore is surfaced and drives the order.
//   3. IMPROVEMENT — rerank strictly beats the same run with the rung disabled
//      (hybrid) on pass rate, MRR and the exact-identifier slice. A tie is what
//      a dead reranker produces, so a tie fails.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { fixtureReranker } from './fixture-reranker.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import { formatComparison, runConfig } from './runner.js';
import type { ConfigReport } from './types.js';

const ORG = 'eval-rerank-org';
const PROJECT = 'eval-rerank-project';
const TOP_K = 8;

describe(`rerank eval — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  let harness: Harness;
  const reports: Record<string, ConfigReport> = {};

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    await resetEvalCorpus(db, ORG, PROJECT);

    harness = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-rerank',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
      // Injecting a reranker FORCES rerank availability (bypasses the env gate)
      // so the `rerank: true` config exercises the rung offline.
      reranker: fixtureReranker,
    });

    const items = GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-rerank' }));
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
      config: { name: 'hybrid+rerank', topK: TOP_K, mode: 'hybrid', rerank: true },
      ctx,
      resolveDocId: harness.resolveDocId,
    });
  }, 120_000);

  afterAll(async () => {
    console.log(
      `\nrerank gate — ${harness?.chunkCount ?? '?'} chunks, ${GOLDEN_SET.length} items, topK=${TOP_K}\n` +
        formatComparison(Object.values(reports)),
    );
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('rerank preserves the forbidden-content floor (no superseded citations)', () => {
    expect(reports['hybrid+rerank']!.totalForbiddenHits).toBe(0);
  });

  // 🔴 STRICT `>`, NOT `>=`. The rerank rung swallows every reranker failure and
  // returns the fused order, and a reranker that scores everything equal leaves
  // the fused order in place too. Either way the reranked run TIES hybrid, so
  // `>=` passed with the reranker doing nothing. MEASURED:
  // `fixtureRerankScore` forced to `return 0` was green under `>=`. The
  // baseline is the same run with the rung disabled, measured here, never a
  // stored number.
  it('rerank beats hybrid on overall pass rate and MRR', () => {
    const hybrid = reports['hybrid']!;
    const reranked = reports['hybrid+rerank']!;
    expect(reranked.passRate, 'passRate vs hybrid').toBeGreaterThan(hybrid.passRate);
    expect(reranked.mrr, 'MRR vs hybrid').toBeGreaterThan(hybrid.mrr);
  });

  it('rerank beats hybrid on the exact-identifier slice', () => {
    const hybrid = reports['hybrid']!.byTag['exact-identifier'];
    const reranked = reports['hybrid+rerank']!.byTag['exact-identifier'];
    expect(hybrid, 'no exact-identifier slice (hybrid)').toBeDefined();
    expect(reranked, 'no exact-identifier slice (reranked)').toBeDefined();
    expect(reranked!.passRate).toBeGreaterThan(hybrid!.passRate);
  });

  it('surfaces rerankScore on reranked results', async () => {
    const item = GOLDEN_SET[0]!;
    const { chunks } = await harness.service.retrieve(
      { corpus: 'eval-rerank', query: item.query, topK: TOP_K, mode: 'hybrid', rerank: true },
      { org: ORG, project: PROJECT },
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.rerankScore).toBeTypeOf('number');
    // score mirrors rerankScore when rerank is applied.
    expect(chunks[0]!.score).toBe(chunks[0]!.rerankScore);
  });
});
