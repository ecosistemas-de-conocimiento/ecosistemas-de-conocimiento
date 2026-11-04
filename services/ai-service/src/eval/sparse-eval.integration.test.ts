// THE SPARSE GATE — dense + `tsvector` vs dense + learned-sparse.
//
// WHY THIS FILE EXISTS
// --------------------
// `SPARSE_ENABLED=true` does not ADD a leg, it REPLACES one: `retrieve.ts`
// picks `sparseSearch` OR `lexicalSearch`, never both. Flipping it on therefore
// trades a working `tsvector` leg for a learned-sparse one, and until now
// nothing in this repo measured that trade — the eval harness had no way to
// populate `chunks.sparse_embedding`, so "hybrid" in the eval has only ever
// meant dense + `tsvector`.
//
// This file runs the same golden set over the same content twice, once with
// each second leg, through the REAL ingest + retrieve machinery, offline.
//
// 🔴 WHAT A GREEN RUN HERE DOES *NOT* MEAN. The sparse vectors come from
// `fixtureSparseEmbedder`, a hashed-token stub — not bge-m3. It models the one
// structural property the sparse leg is adopted for (it keeps the numerals and
// literal codes the dense bi-encoder discards) and nothing else: no term
// expansion, no corpus-level saturation, no multilingual behaviour. So this is
// a valid A/B of the sparse WIRING and of exact-term sharpening. It is NOT
// evidence about production bge-m3 sparse quality, and a stage/prod flip still
// owes a real-sibling measurement.
//
// THE GUARD THAT MAKES THE NUMBERS MEAN ANYTHING
// ----------------------------------------------
// Every failure mode of the sparse leg is SILENT. A NULL `sparse_embedding`
// column is excluded by `WHERE sparse_embedding IS NOT NULL`, a dead sibling is
// caught and turned into `[]`, and RRF over the one surviving leg reproduces
// the dense ranking exactly — with no exception and a passing number. So before
// asserting anything about quality this file proves the setup actually
// happened: the column is populated for every chunk in the sparse corpus and
// for NO chunk in the control corpus, the live response reports
// `legs: ['dense','sparse']`, and the collecting logger stayed empty.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import type { RetrieveLogger } from '../services/rag/retrieve.js';
import { fixtureSparseEmbedder } from './fixture-sparse-embedder.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import { formatComparison, runConfig } from './runner.js';
import type { ConfigReport } from './types.js';

const ORG = 'eval-sparse-org';
const PROJECT = 'eval-sparse-project';
const TOP_K = 8;

// 🔴 NO ABSOLUTE FLOORS HERE, ON PURPOSE (no stored-number gates,
// floors included). This file used to hold passRate 0.85 / MRR 0.80 /
// exact-identifier 0.80. The baseline that matters is the run with the sparse
// leg disabled — DENSE ONLY over the same corpus — because a sparse leg that
// goes silent collapses hybrid exactly onto it. Quoted from the
// measurement this replaces (37 structural chunks, 43 items, topK=8):
// dense only 35/43 = .814 pass, MRR 0.822, exact-identifier 14/21 =
// .667; hybrid+sparse 42/43 = .977, MRR 0.915, exact-identifier 20/21 = .952.
// The gate below asserts the relation, measured in the same run, strictly.

function collectingLogger(): { logger: RetrieveLogger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  return {
    warnings,
    logger: {
      warn(obj: unknown, msg?: string) {
        warnings.push({ obj, msg });
      },
    },
  };
}

describe(`sparse-leg eval — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  /** Control: sparse NEVER injected, so hybrid runs dense + `tsvector`. */
  let lexical: Harness;
  /** Sparse injected at ingest AND at query, so hybrid runs dense + sparse. */
  let sparse: Harness;
  const reports: Record<string, ConfigReport> = {};
  const sparseWarnings: unknown[] = [];
  let lexicalLegs: string[] = [];
  let sparseLegs: string[] = [];
  let populated = { lexicalCorpus: -1, sparseCorpus: -1 };

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    await resetEvalCorpus(db, ORG, PROJECT);

    lexical = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-sparse-off',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
    });

    const collected = collectingLogger();
    sparse = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-sparse-on',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
      // Injecting this is the whole point of the file: it forces the sparse
      // path on at ingest (populating `chunks.sparse_embedding`) and at query.
      sparseEmbedder: fixtureSparseEmbedder,
      logger: collected.logger,
    });
    sparseWarnings.push(...collected.warnings);

    const countPopulated = async (corpusId: string): Promise<number> => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM "chunks"
        WHERE "corpus_id" = ${corpusId}::uuid AND "sparse_embedding" IS NOT NULL
      `);
      const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) as
        | { n?: number }
        | undefined;
      return Number(first?.n ?? -1);
    };
    populated = {
      lexicalCorpus: await countPopulated(lexical.corpusId),
      sparseCorpus: await countPopulated(sparse.corpusId),
    };

    const ctx = { org: ORG, project: PROJECT };
    const probe = GOLDEN_SET[0]!;
    lexicalLegs = (
      await lexical.service.retrieve(
        { corpus: 'eval-sparse-off', query: probe.query, topK: TOP_K, mode: 'hybrid' },
        ctx,
      )
    ).legs;
    sparseLegs = (
      await sparse.service.retrieve(
        { corpus: 'eval-sparse-on', query: probe.query, topK: TOP_K, mode: 'hybrid' },
        ctx,
      )
    ).legs;

    // Dense-only over the sparse corpus: the number hybrid collapses ONTO when
    // the second leg goes silent. It is the yardstick that tells a working
    // sparse leg from a dead one.
    reports['dense only'] = await runConfig({
      service: sparse.service,
      items: GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-sparse-on' })),
      config: { name: 'dense only', topK: TOP_K, mode: 'dense' },
      ctx,
      resolveDocId: sparse.resolveDocId,
    });
    reports['hybrid+tsvector'] = await runConfig({
      service: lexical.service,
      items: GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-sparse-off' })),
      config: { name: 'hybrid+tsvector', topK: TOP_K, mode: 'hybrid' },
      ctx,
      resolveDocId: lexical.resolveDocId,
    });
    reports['hybrid+sparse'] = await runConfig({
      service: sparse.service,
      items: GOLDEN_SET.map((i) => ({ ...i, corpus: 'eval-sparse-on' })),
      config: { name: 'hybrid+sparse', topK: TOP_K, mode: 'hybrid' },
      ctx,
      resolveDocId: sparse.resolveDocId,
    });
  }, 180_000);

  afterAll(async () => {
    console.log(
      `\nsparse gate — ${sparse?.chunkCount ?? '?'} chunks, ` +
        `${populated.sparseCorpus} with sparse_embedding, ` +
        `${GOLDEN_SET.length} items, topK=${TOP_K}\n` +
        formatComparison(Object.values(reports)),
    );
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  // ── 0. The setup actually happened ───────────────────────────────────────
  // Without these four, every assertion below is satisfied by a dead sparse
  // leg producing the dense ranking.

  it('populates sparse_embedding for every chunk when a sparse embedder is injected', () => {
    expect(sparse.chunkCount).toBeGreaterThan(0);
    expect(populated.sparseCorpus).toBe(sparse.chunkCount);
  });

  it('leaves sparse_embedding NULL when no sparse embedder is injected', () => {
    // The control half. If this ever becomes non-zero the two corpora stopped
    // differing and the A/B compares a config against itself.
    expect(lexical.chunkCount).toBeGreaterThan(0);
    expect(populated.lexicalCorpus).toBe(0);
  });

  it('reports the sparse leg on the wire, and the tsvector leg for the control', () => {
    expect(sparseLegs).toEqual(['dense', 'sparse']);
    expect(lexicalLegs).toEqual(['dense', 'lexical']);
  });

  it('runs the sparse leg without a single silent-degradation warning', () => {
    expect(sparseWarnings).toEqual([]);
  });

  // ── 1. Correctness floor ─────────────────────────────────────────────────

  it('never surfaces superseded content on the sparse leg', () => {
    const r = reports['hybrid+sparse']!;
    const offenders = r.items
      .filter((i) => i.forbiddenHits > 0)
      .map((i) => `${i.itemId}: ${i.failures.join(' | ')}`);
    expect(offenders, `sparse surfaced superseded content:\n${offenders.join('\n')}`).toEqual([]);
    expect(r.totalForbiddenHits).toBe(0);
  });

  // ── 2. The leg is worth its place — absolutely, and against both rivals ──

  it('beats the same run with the sparse leg disabled (dense only), strictly', () => {
    // A sparse leg that has gone silent scores EXACTLY dense-only, so `>` (not
    // `>=`) is what catches it. The exact-identifier slice is the reason a
    // lexical leg exists at all.
    const dense = reports['dense only']!;
    const r = reports['hybrid+sparse']!;
    expect(r.passRate, 'sparse passRate vs dense only').toBeGreaterThan(dense.passRate);
    expect(r.mrr, 'sparse MRR vs dense only').toBeGreaterThan(dense.mrr);
    expect(dense.byTag['exact-identifier'], 'no exact-identifier slice (dense)').toBeDefined();
    expect(r.byTag['exact-identifier'], 'no exact-identifier slice (sparse)').toBeDefined();
    expect(
      r.byTag['exact-identifier']!.passRate,
      'sparse exact-identifier vs dense only',
    ).toBeGreaterThan(dense.byTag['exact-identifier']!.passRate);
  });

  it('does not regress against the tsvector leg it replaces', () => {
    // The decision this file exists to inform: `SPARSE_ENABLED=true` trades the
    // tsvector leg away, so the replacement must at least hold the line.
    const tsv = reports['hybrid+tsvector']!;
    const spr = reports['hybrid+sparse']!;
    expect(spr.passRate, 'sparse vs tsvector overall').toBeGreaterThanOrEqual(tsv.passRate);
    expect(
      spr.byTag['exact-identifier']!.passRate,
      'sparse vs tsvector exact-identifier',
    ).toBeGreaterThanOrEqual(tsv.byTag['exact-identifier']!.passRate);
  });
});
