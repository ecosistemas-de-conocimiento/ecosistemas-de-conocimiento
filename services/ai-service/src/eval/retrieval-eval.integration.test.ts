// THE GATE.
//
// Runs the `gs-ai-2026-07` golden set against a real Postgres under four
// retrieval configurations and asserts the properties that must hold for the
// service to be safe to ship. Costs nothing: the embedder is deterministic and
// offline (`fixture-embedder.ts`), so this runs in CI on every change.
//
// It asserts three different KINDS of thing, and the distinction matters:
//
//   1. ABSOLUTE CORRECTNESS FLOORS — zero superseded citations, ever, under
//      every config. Not a metric to be traded off. If this fails, nothing
//      else in the report is worth reading.
//   2. RELATIVE IMPROVEMENTS — hybrid must beat dense on the exact-identifier
//      slice. Stated as a comparison rather than a threshold, because the
//      absolute value depends on the fixture embedder and would be a
//      meaningless number to hard-code.
//   3. NON-REGRESSION — hybrid must not lose ground on the topical slice.
//      This is the assertion that catches fusion done badly, and it is the one
//      most likely to fire on a future rung.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { buildHarness, resetEvalCorpus, type Harness } from './harness.js';
import { GOLDEN_SET, GOLDEN_SET_VERSION } from './fixtures/golden-set.js';
import {
  FIXTURE_CHUNK_CONFIG,
  FIXTURE_DOCS,
  FIXTURE_TEXT_SEARCH_CONFIG,
} from './fixtures/structured-corpus.js';
import { formatComparison, runConfig } from './runner.js';
import type { ConfigReport } from './types.js';

const ORG = 'eval-org';
const PROJECT = 'eval-project';
const TOP_K = 8;

describe(`retrieval eval — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  /** recursive-char corpus — the pre-upgrade baseline. */
  let baseline: Harness;
  /** structural (section-boundary) corpus — the post-upgrade chunking. */
  let structural: Harness;
  const reports: Record<string, ConfigReport> = {};

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    await resetEvalCorpus(db, ORG, PROJECT);

    baseline = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-recursive',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'recursive-char',
      // Scaled down from the 800-token production default. The fixture
      // documents are two orders of magnitude shorter than a real one, and at
      // 800 tokens each lands in a SINGLE chunk — which would make the
      // baseline look artificially strong (every query trivially "retrieves"
      // the whole document) while hiding the actual pathology. At 128 tokens
      // the windows straddle section boundaries the same way an 800-token
      // window straddles them in a real 200-section document, which is the
      // behaviour being compared against.
      chunkSize: 128,
      chunkOverlap: 16,
    });
    structural = await buildHarness({
      db,
      org: ORG,
      project: PROJECT,
      corpus: 'eval-structural',
      docs: FIXTURE_DOCS,
      textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
      chunkStrategy: 'structural',
      // Patterns come from the FIXTURE, exactly as a consumer's would come
      // from its own `chunkConfig`. The service ships none.
      chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
    });

    // The golden set names one corpus; point each run at the corpus under test.
    const itemsFor = (corpus: string) => GOLDEN_SET.map((i) => ({ ...i, corpus }));

    // A. Today's service, today's chunking, and — critically — asOf IGNORED.
    //    This is the true "before": what a consumer gets right now.
    reports['A. baseline (dense, recursive, no validity)'] = await runConfig({
      service: baseline.service,
      items: itemsFor('eval-recursive').map(({ asOf: _asOf, ...rest }) => rest),
      config: { name: 'A dense/recursive/no-asOf', topK: TOP_K, mode: 'dense' },
      ctx: { org: ORG, project: PROJECT },
      resolveDocId: baseline.resolveDocId,
    });

    // B. Add the validity filter only. Isolates what correctness floor #1 buys.
    reports['B. + validity'] = await runConfig({
      service: baseline.service,
      items: itemsFor('eval-recursive'),
      config: { name: 'B +validity', topK: TOP_K, mode: 'dense' },
      ctx: { org: ORG, project: PROJECT },
      resolveDocId: baseline.resolveDocId,
    });

    // C. Add structural chunking. Isolates correctness floor #2.
    reports['C. + structural chunking'] = await runConfig({
      service: structural.service,
      items: itemsFor('eval-structural'),
      config: { name: 'C +structural', topK: TOP_K, mode: 'dense' },
      ctx: { org: ORG, project: PROJECT },
      resolveDocId: structural.resolveDocId,
    });

    // D. Add hybrid BM25 + RRF. Rung 1.
    reports['D. + hybrid RRF'] = await runConfig({
      service: structural.service,
      items: itemsFor('eval-structural'),
      config: { name: 'D +hybrid', topK: TOP_K, mode: 'hybrid' },
      ctx: { org: ORG, project: PROJECT },
      resolveDocId: structural.resolveDocId,
    });
  }, 120_000);

  afterAll(async () => {
    // Print the comparison table regardless of pass/fail — a failing run's
    // numbers are the most useful thing on the screen.

    console.log(
      `\ncorpus: ${baseline?.chunkCount ?? '?'} chunks (recursive) / ` +
        `${structural?.chunkCount ?? '?'} chunks (structural), ` +
        `${GOLDEN_SET.length} golden items, topK=${TOP_K}\n` +
        formatComparison(Object.values(reports)),
    );
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  });

  it('ingests the fixture corpus under both chunking strategies', () => {
    expect(baseline.chunkCount).toBeGreaterThan(0);
    expect(structural.chunkCount).toBeGreaterThan(0);
    // Section-level chunking necessarily produces MORE, smaller chunks than
    // 800-token packing over the same text. If it doesn't, the patterns didn't
    // match and the chunker silently fell back.
    expect(structural.chunkCount).toBeGreaterThan(baseline.chunkCount);
  });

  it('has a golden set of the intended size and shape', () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(40);
    const ids = GOLDEN_SET.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of GOLDEN_SET) {
      expect(item.tags?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // ── 1. Correctness floor: no superseded citations ────────────────────────

  it('BASELINE LEAKS superseded content — this is the bug being fixed', () => {
    const a = reports['A. baseline (dense, recursive, no validity)']!;
    // Documents the pre-existing failure. If this ever stops being true the
    // fixture stopped modelling the hazard and the other assertions are
    // vacuous.
    expect(a.totalForbiddenHits).toBeGreaterThan(0);
  });

  it('never returns superseded content once validity filtering is on', () => {
    for (const key of ['B. + validity', 'C. + structural chunking', 'D. + hybrid RRF']) {
      const r = reports[key]!;
      const offenders = r.items
        .filter((i) => i.forbiddenHits > 0)
        .map((i) => `${i.itemId}: ${i.failures.join(' | ')}`);
      expect(
        offenders,
        `${key} surfaced superseded content:\n${offenders.join('\n')}`,
      ).toEqual([]);
      expect(r.totalForbiddenHits).toBe(0);
    }
  });

  it('still RETRIEVES the superseded edition for an explicitly historical query', () => {
    // The filter must be a point-in-time filter, not a "hide old things"
    // filter. Items tagged `point-in-time` ask questions as of a date when the
    // older edition WAS in force, and the superseded edition is then the
    // CORRECT answer.
    //
    // Asserted as recall, not pass rate, and asserted from config B onward:
    // "the filter let the old edition through" is what the filter is
    // responsible for. Whether the old edition's top-ranked chunk also
    // *grounds a citation* depends on where the chunker cut, which is config
    // C's job — and under B's arbitrary token window it routinely does not
    // (a window can and does slice a sentence in half, leaving rank 1 holding
    // the tail of one provision and the head of the next). Asserting a rank-1
    // property here would be testing the chunker under the config that has
    // not fixed the chunker yet.
    for (const key of ['B. + validity', 'C. + structural chunking', 'D. + hybrid RRF']) {
      const r = reports[key]!;
      const missed = r.items
        .filter((i) => i.tags.includes('point-in-time') && i.recallAtK === 0)
        .map((i) => i.itemId);
      expect(missed, `${key} failed to retrieve the superseded edition for: ${missed.join(', ')}`)
        .toEqual([]);
    }
  });

  it('fully passes the point-in-time slice once the chunker cuts on boundaries', () => {
    // The strict form of the assertion above, from config C on — where a
    // retrieved chunk IS one addressable unit and can therefore ground the
    // citation, not merely contain part of it.
    for (const key of ['C. + structural chunking', 'D. + hybrid RRF']) {
      const slice = reports[key]!.byTag['point-in-time'];
      expect(slice, `${key} has no point-in-time slice`).toBeDefined();
      expect(slice!.passRate, `${key} point-in-time`).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('passes every validity item under the full configuration', () => {
    const d = reports['D. + hybrid RRF']!;
    const failed = d.items
      .filter((i) => i.tags.includes('validity') && !i.pass)
      .map((i) => `${i.itemId}: ${i.failures.join(' | ')}`);
    expect(failed, `validity failures:\n${failed.join('\n')}`).toEqual([]);
  });

  // ── 2. Rung 1 must earn its place ────────────────────────────────────────

  it('hybrid beats dense on exact-identifier queries', () => {
    const dense = reports['C. + structural chunking']!.byTag['exact-identifier']!;
    const hybrid = reports['D. + hybrid RRF']!.byTag['exact-identifier']!;
    expect(hybrid.passRate).toBeGreaterThan(dense.passRate);
  });

  it('hybrid does not regress topical queries', () => {
    const dense = reports['C. + structural chunking']!.byTag['topical']!;
    const hybrid = reports['D. + hybrid RRF']!.byTag['topical']!;
    expect(hybrid.passRate).toBeGreaterThanOrEqual(dense.passRate);
  });

  it('improves end to end from baseline to the full configuration', () => {
    const a = reports['A. baseline (dense, recursive, no validity)']!;
    const d = reports['D. + hybrid RRF']!;
    expect(d.passRate).toBeGreaterThan(a.passRate);
    expect(d.mrr).toBeGreaterThan(a.mrr);
  });

  // ── 3. Structural chunking put the boundaries where citations need them ──

  it('structural chunking improves the structural slice', () => {
    const recursive = reports['B. + validity']!.byTag['structural']!;
    const structuralSlice = reports['C. + structural chunking']!.byTag['structural']!;
    expect(structuralSlice.passRate).toBeGreaterThanOrEqual(recursive.passRate);
  });
});
