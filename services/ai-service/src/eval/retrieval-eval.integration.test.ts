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
//      slice.
//   3. NON-REGRESSION — hybrid must not lose ground on the topical slice.
//      This is the assertion that catches fusion done badly, and it is the one
//      most likely to fire on a future rung.
//   4. ABSOLUTE QUALITY FLOORS — see `FLOORS` below.
//
// ⚠ CORRECTION. Kinds 2 and 3 used to be the ONLY quality
// assertions here, and this header argued that an absolute threshold "depends
// on the fixture embedder and would be a meaningless number to hard-code".
// That argument is wrong, and the way it is wrong is the failure mode this
// file is supposed to prevent.
//
// Every one of those assertions is a COMPARISON between two configs measured
// in the SAME run. A change that degrades dense and hybrid together — a worse
// chunker, a broken stopword list, a fusion bug that costs both legs — keeps
// every comparison true while the service gets worse. Hybrid could fall from
// 0.98 to 0.65 and this gate would stay green, because dense fell too. A gate
// that cannot fail for the thing it protects is not a gate.
//
// The objection was really about PREDICTIVE thresholds: it is true that 0.977
// here does not predict production quality, because the embedder is a stub. A
// FLOOR is a different object. This run is byte-deterministic — fixed corpus,
// fixed golden set, offline hash embedder — so the value is reproducible, and
// a floor set well below it asserts only "nothing large has silently broken".
// That claim is meaningful precisely BECAUSE the fixture is fixed.

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

/**
 * RRF damping for configuration E. The service default is 60.
 *
 * Contract-legal (`src/contract/rag.ts`: int, min 1, max 1000) and chosen for
 * an arithmetic reason, spelled out on config E below: at the default this
 * eval's fusion can never produce a score tie between documents found by
 * different numbers of legs, so the whole tie-break chain under `b.score !==
 * a.score` is dead code for every run in this file. `rrfK = 1` is the smallest
 * legal value and puts the run deep into the overlapping regime.
 */
const LOW_RRF_K = 1;

/**
 * ABSOLUTE QUALITY FLOORS — the half of this gate that a COMPARISON cannot
 * express. See the ⚠ CORRECTION in the header for why they are not the
 * meaningless hard-coded numbers this file used to say they would be.
 *
 * MEASURED on this fixture corpus (19 recursive / 37 structural
 * chunks, 43 golden items, topK=8, offline `fixtureEmbedder`):
 *
 *   config                      pass          recall   MRR     nDCG    prec    stale
 *   A dense/recursive/no-asOf   19/43 = .442  0.628    0.581   0.594   0.203   23
 *   B +validity                 25/43 = .581  0.628    0.605   0.611   0.250   0
 *   C +structural               35/43 = .814  0.907    0.822   0.844   0.343   0
 *   D +hybrid                   42/43 = .977  1.000    0.915   0.936   0.369   0
 *   E +hybrid rrfK=1            42/43 = .977  1.000    0.933   0.950   0.366   0
 *
 *   by tag                      C +structural      D +hybrid          E +hybrid rrfK=1
 *   exact-identifier            14/21 = .667       20/21 = .952       20/21 = .952
 *   topical                     23/24 = .958       24/24 = 1.000      24/24 = 1.000
 *   structural                   4/6  = .667        5/6  = .833        5/6  = .833
 *
 * Each floor sits roughly 0.10–0.15 (two to five golden items) below its
 * measured value. That is deliberate headroom: a fixture edit or a chunker
 * tweak that costs an item or two should NOT turn this red — the comparisons
 * are the instrument for small movements. The floors fire on the class of
 * change the comparisons are blind to: a collapse that takes both sides down
 * together.
 *
 * 🔴 WHEN A FLOOR FAILS, do not lower it to match. Either the change is a
 * regression, or the fixture corpus genuinely moved — in which case re-measure,
 * write the NEW table into this comment, and say in the commit which it was.
 */
const FLOORS = {
  /** Dense + structural chunking, config C. */
  denseStructural: { passRate: 0.70, exactIdentifier: 0.55, topical: 0.85, structural: 0.55 },
  /** Full configuration, config D. */
  hybrid: { passRate: 0.85, mrr: 0.80, recall: 0.90, exactIdentifier: 0.80, topical: 0.90, structural: 0.70 },
} as const;

/**
 * Floors for config E (`rrfK = 1`). Separate from `FLOORS` because E is a
 * deliberately extreme parameterisation, not a shipping configuration — its
 * numbers are a different measurement and merging them would hide that.
 *
 * MEASURED: see the E row in the table above.
 */
const E_FLOORS = { passRate: 0.85, mrr: 0.80, exactIdentifier: 0.80 } as const;

describe(`retrieval eval — ${GOLDEN_SET_VERSION}`, () => {
  let db: Db;
  /** recursive-char corpus — the pre-upgrade baseline. */
  let baseline: Harness;
  /** structural (section-boundary) corpus — the post-upgrade chunking. */
  let structural: Harness;
  const reports: Record<string, ConfigReport> = {};
  /**
   * Per-item ranked chunk ids under the default `rrfK` (config D) and under
   * `LOW_RRF_K` (config E), read back off the REPORTS — so the comparison runs
   * through the whole path a sweep uses: `EvalConfig` → `runConfig` → the wire
   * request → `rrfFuse`. Reading them from a direct `service.retrieve()` call
   * instead would skip the runner, and a runner that silently dropped `rrfK`
   * would still look plumbed. (Measured: it did — see the commit message.)
   */
  const orderings = (): Array<{ itemId: string; defaultK: string[]; lowK: string[] }> => {
    const lowByItem = new Map(
      reports['E. + hybrid RRF (rrfK=1)']!.items.map((i) => [i.itemId, i.retrievedChunkIds]),
    );
    return reports['D. + hybrid RRF']!.items.map((i) => ({
      itemId: i.itemId,
      defaultK: i.retrievedChunkIds,
      lowK: lowByItem.get(i.itemId) ?? [],
    }));
  };

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

    // E. Same fusion, `rrfK` pushed to its legal minimum. See the block comment
    //    on the "fuses correctly in the overlapping-score regime" test for why
    //    this configuration is not a curiosity: it is the only one in this file
    //    that reaches the fusion tie-break chain at all.
    reports['E. + hybrid RRF (rrfK=1)'] = await runConfig({
      service: structural.service,
      items: itemsFor('eval-structural'),
      config: { name: `E +hybrid k=${LOW_RRF_K}`, topK: TOP_K, mode: 'hybrid', rrfK: LOW_RRF_K },
      ctx: { org: ORG, project: PROJECT },
      resolveDocId: structural.resolveDocId,
    });
  }, 180_000);

  afterAll(async () => {
    // Print the comparison table regardless of pass/fail — a failing run's
    // numbers are the most useful thing on the screen.

    console.log(
      `\ncorpus: ${baseline?.chunkCount ?? '?'} chunks (recursive) / ` +
        `${structural?.chunkCount ?? '?'} chunks (structural), ` +
        `${GOLDEN_SET.length} golden items, topK=${TOP_K}\n` +
        formatComparison(Object.values(reports)) +
        `rrfK=${LOW_RRF_K} vs default changed the chunk order for ` +
        `${orderings().filter((o) => o.defaultK.join('|') !== o.lowK.join('|')).length}/` +
        `${orderings().length} queries\n`,
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

  it('has a golden set of the intended shape', () => {
    // Non-empty only — the size of the golden set is a curation decision, not a
    // software fact. The checks below are per-item and hold at any size.
    expect(GOLDEN_SET.length).toBeGreaterThan(0);
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
    for (const key of [
      'B. + validity',
      'C. + structural chunking',
      'D. + hybrid RRF',
      'E. + hybrid RRF (rrfK=1)',
    ]) {
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

  // ── 2b. ABSOLUTE floors — what the comparisons above cannot see ──────────
  //
  // Every assertion in section 2 compares two configs from the SAME run, so a
  // change that degrades both keeps them green. These do not: they pin each
  // config to a number measured on a fixed corpus with a deterministic
  // embedder. Both kinds are kept — a comparison catches "hybrid stopped
  // earning its place" while dense holds, a floor catches "everything fell
  // together", and neither sees the other's failure.

  it('holds the absolute floor for dense + structural chunking (config C)', () => {
    const c = reports['C. + structural chunking']!;
    expect(c.passRate, 'C passRate').toBeGreaterThanOrEqual(FLOORS.denseStructural.passRate);
    expect(c.byTag['exact-identifier']!.passRate, 'C exact-identifier').toBeGreaterThanOrEqual(
      FLOORS.denseStructural.exactIdentifier,
    );
    expect(c.byTag['topical']!.passRate, 'C topical').toBeGreaterThanOrEqual(
      FLOORS.denseStructural.topical,
    );
    expect(c.byTag['structural']!.passRate, 'C structural').toBeGreaterThanOrEqual(
      FLOORS.denseStructural.structural,
    );
  });

  it('holds the absolute floor for the full configuration (config D)', () => {
    const d = reports['D. + hybrid RRF']!;
    expect(d.passRate, 'D passRate').toBeGreaterThanOrEqual(FLOORS.hybrid.passRate);
    expect(d.mrr, 'D MRR').toBeGreaterThanOrEqual(FLOORS.hybrid.mrr);
    expect(d.meanRecallAtK, 'D recall').toBeGreaterThanOrEqual(FLOORS.hybrid.recall);
    expect(d.byTag['exact-identifier']!.passRate, 'D exact-identifier').toBeGreaterThanOrEqual(
      FLOORS.hybrid.exactIdentifier,
    );
    expect(d.byTag['topical']!.passRate, 'D topical').toBeGreaterThanOrEqual(
      FLOORS.hybrid.topical,
    );
    expect(d.byTag['structural']!.passRate, 'D structural').toBeGreaterThanOrEqual(
      FLOORS.hybrid.structural,
    );
  });

  // ── 3. Structural chunking put the boundaries where citations need them ──

  it('structural chunking improves the structural slice', () => {
    const recursive = reports['B. + validity']!.byTag['structural']!;
    const structuralSlice = reports['C. + structural chunking']!.byTag['structural']!;
    expect(structuralSlice.passRate).toBeGreaterThanOrEqual(recursive.passRate);
  });

  // ── 4. The fusion tie-break chain, which this file never used to reach ───
  //
  // 🔴 FINDING, and a correction to the brief that prompted it.
  //
  // THE ASK was: add a `topK`/`rrfK` combination under which the leg-count
  // tie-break tier in `rrfFuse` (`retrieve.ts`, "found by both legs > found by
  // one") can actually fire, so the eval stops being structurally blind to it.
  //
  // THE ANSWER: no such combination exists. Not at this eval's parameters, and
  // not at any parameters, for as long as a hybrid retrieve runs TWO legs. The
  // tier is unreachable by construction, not by arithmetic, and no `rrfK`
  // override can change that. Two separate arguments are in play and it is
  // worth keeping them apart, because only one of them is parameter-dependent:
  //
  //   (i) THE POOL ARITHMETIC (parameter-dependent, and correct). RRF with
  //       damping `k` over a per-leg pool of `N`: a two-leg document scores at
  //       least `2/(k+N)`, a one-leg document at most `1/(k+1)`, and those
  //       ranges are disjoint whenever `N < k+2`. At the service defaults
  //       (`topK=10` ⇒ `N = 10 × HYBRID_POOL_MULTIPLIER = 50`, `k=60`) 50 < 62,
  //       so no cross-leg-count document pair can even tie on total score.
  //       AT THIS EVAL'S PARAMETERS IT IS STRICTER STILL: `topK = 8` ⇒ `N = 40`,
  //       and 40 < 62 with room to spare. So configs A–D never reach ANY step
  //       of the tie-break chain below `b.score !== a.score` — not the leg-count
  //       tier, not the dense-score tier, none of it.
  //
  //   (ii) THE SENTINEL ARGUMENT (parameter-INDEPENDENT, and the operative
  //       one). With exactly two legs, `legsFound === 2` ⟺ both `denseScore`
  //       and `lexicalScore` are set, and `legsFound === 1` ⟺ exactly one is.
  //       The two tiers ABOVE the leg count compare a finite score against the
  //       `-Infinity` an absent one falls back to. So whenever the counts
  //       differ, one of those tiers has already returned. Changing `rrfK`
  //       moves scores around; it cannot make an absent `lexicalScore` present.
  //
  // Argument (ii) is why "add a config that reaches the tier" cannot be done
  // here, and it is the one `retrieve.ts`'s own comment block leads with. The
  // tier becomes live under the declared THREE-leg fusion (dense + tsvector +
  // sparse), where both lexical legs write the same `lexicalScore` slot, so a
  // three-leg and a two-leg document can agree on both scores and still differ
  // on the count. That is a lane-K change and belongs to lane K's eval.
  //
  // WHAT IS REACHABLE, and what config E is for. Argument (i) IS parameter
  // dependent, and this file sat on the safe side of it by accident rather than
  // by design — so the entire tie-break chain, the part of fusion that decides
  // what happens when two chunks score identically, has never executed in this
  // gate. `rrfK = 1` inverts the inequality (`N = 40`, `k = 1`, and 40 ≥ 3), so
  // config E runs deep in the overlapping regime where exact score ties between
  // differing-leg-count documents are possible and the chain is entered. It
  // also, and independently, proves the per-request `rrfK` override is plumbed
  // end to end — contract → runner → `rrfFuse` — which every later sweep
  // depends on and which nothing asserted before.

  it('plumbs the per-request rrfK override all the way into fusion', () => {
    const captured = orderings();
    // Guard first: an ordering that came back empty or short would make the
    // difference below meaningless.
    expect(captured.length).toBe(GOLDEN_SET.length);
    for (const o of captured) {
      expect(o.defaultK.length, `${o.itemId} default-k result count`).toBeGreaterThan(0);
      expect(o.lowK.length, `${o.itemId} low-k result count`).toBe(o.defaultK.length);
    }
    // Then the claim: `rrfK` changed the fused order for at least one query. If
    // the parameter were dropped anywhere along the way — validated off the
    // request, lost in the runner, never passed to `rrfFuse` — every ordering
    // would be identical and config E would be a duplicate of config D wearing
    // a different name.
    const changed = captured.filter((o) => o.defaultK.join('|') !== o.lowK.join('|'));
    expect(changed.length, 'rrfK=1 changed no ordering at all').toBeGreaterThan(0);
  });

  it('holds the absolute floor in the overlapping-score regime (config E)', () => {
    // A tie-break chain that mis-orders under heavy score collision would show
    // up here as a quality drop, and only here — configs A–D cannot reach it.
    const e = reports['E. + hybrid RRF (rrfK=1)']!;
    expect(e.passRate, 'E passRate').toBeGreaterThanOrEqual(E_FLOORS.passRate);
    expect(e.mrr, 'E MRR').toBeGreaterThanOrEqual(E_FLOORS.mrr);
    expect(e.byTag['exact-identifier']!.passRate, 'E exact-identifier').toBeGreaterThanOrEqual(
      E_FLOORS.exactIdentifier,
    );
  });
});
