// GATED real-embedder eval — the first honest semantic-quality baseline.
//
// The default eval embedder is the offline FNV-1a bag-of-words stub, which
// measures retrieval STRUCTURE but says nothing about real `bge-m3` semantic
// quality (it drops numerals/identifiers and models no synonymy). This test
// runs the REAL embedder over the golden set so a run measures actual
// multilingual embedding quality.
//
// ⚠ GATED — it makes real network calls and costs real money, so it is NEVER
// part of `pnpm test` / CI and does not even run under `pnpm run test:integration`
// unless BOTH are true:
//   - `EVAL_REAL_EMBEDDER=1`  (explicit opt-in)
//   - a real `OPENROUTER_API_KEY` is set (else the embedder throws)
// AND Rodrigo has given an explicit per-run OK (conserve-tokens rule).
// Point `TEST_DATABASE_URL` at a THROWAWAY pgvector DB — never a shared DB.
//
// HONESTY CAVEAT (plan §2.1 / coordination §4): the shipped golden set is
// DOMAIN-NEUTRAL ENGLISH. Real Spanish-domain quality needs a Spanish golden
// set, which is a CONSUMER (a prototype) artifact owned in the consumer repo — this
// run establishes the machinery + an English baseline, not a Spanish number.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import { isRealEmbedderEvalEnabled, REAL_EMBEDDING_MODEL, realEmbedder } from './real-embedder.js';
import { formatComparison, runConfig } from './runner.js';
import type { ConfigReport } from './types.js';

const ORG = 'eval-real-org';
const PROJECT = 'eval-real-project';
const TOP_K = 8;

// The whole suite is skipped unless the explicit gate is on. `describe.skipIf`
// keeps it visible-but-skipped in the report rather than silently absent.
describe.skipIf(!isRealEmbedderEvalEnabled())(
  `REAL-embedder eval (${REAL_EMBEDDING_MODEL}) — ${GOLDEN_SET_VERSION}`,
  () => {
    let db: Db;
    let structural: Harness;
    const reports: Record<string, ConfigReport> = {};

    beforeAll(async () => {
      ({ db } = await import('../db/client.js'));
      await resetEvalCorpus(db, ORG, PROJECT);

      // Structural chunking + the REAL embedder + the real model id so ingest
      // and query embed with the same model.
      structural = await buildHarness({
        db,
        org: ORG,
        project: PROJECT,
        corpus: 'eval-real',
        docs: FIXTURE_DOCS,
        textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
        chunkStrategy: 'structural',
        chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
        embedder: realEmbedder,
        embeddingModel: REAL_EMBEDDING_MODEL,
      });

      const items = GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-real' }));
      const ctx = { org: ORG, project: PROJECT };

      reports['real dense'] = await runConfig({
        service: structural.service,
        items,
        config: { name: 'real dense', topK: TOP_K, mode: 'dense' },
        ctx,
        resolveDocId: structural.resolveDocId,
      });
      reports['real hybrid'] = await runConfig({
        service: structural.service,
        items,
        config: { name: 'real hybrid', topK: TOP_K, mode: 'hybrid' },
        ctx,
        resolveDocId: structural.resolveDocId,
      });
    }, 300_000);

    afterAll(async () => {
      console.log(
        `\nREAL embedder: ${REAL_EMBEDDING_MODEL}, ${structural?.chunkCount ?? '?'} chunks, ` +
          `${GOLDEN_SET.length} golden items, topK=${TOP_K}\n` +
          `⚠ domain-neutral ENGLISH fixtures — NOT a Spanish-domain number.\n` +
          formatComparison(Object.values(reports)),
      );
      const { closeDb } = await import('../db/client.js');
      await closeDb().catch(() => undefined);
    });

    it('produces a real-embedder baseline with no superseded citations', () => {
      for (const r of Object.values(reports)) {
        expect(r.totalForbiddenHits).toBe(0);
      }
    });

    it('retrieves something relevant under the real embedder', () => {
      expect(reports['real dense']!.passRate).toBeGreaterThan(0);
      expect(reports['real hybrid']!.passRate).toBeGreaterThan(0);
    });
  },
);
