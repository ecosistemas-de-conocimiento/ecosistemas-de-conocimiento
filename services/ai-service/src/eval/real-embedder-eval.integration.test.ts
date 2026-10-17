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
// set, which is a CONSUMER artifact — this
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
// Opt-in only: it spends real OpenRouter embedding credits, so it is gated behind
// isRealEmbedderEvalEnabled() and is expected to skip in CI.
// skip-reason: opt-in real-embedder eval, gated to avoid spending OpenRouter credits in CI
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

    // ── what IS asserted, and why it is only this much ──────────────────────
    //
    // These three are floors that hold WHATEVER the embedder's quality turns
    // out to be. Nothing below asserts a pass rate; see the block after them.

    it('produces a real-embedder baseline with no superseded citations', () => {
      // The `asOf` filter is SQL, not similarity. A superseded citation here is
      // a broken filter under any embedder, so this is an absolute floor and
      // not a metric to be traded off.
      for (const r of Object.values(reports)) {
        expect(r.totalForbiddenHits).toBe(0);
      }
    });

    it('ran every golden item under both configurations', () => {
      // 🔴 THIS IS HALF OF WHAT REPLACED `passRate > 0`.
      // `toBeGreaterThan(0)` is satisfied by ONE passing item out of any
      // number — including a run that threw after item 1, or a golden set that
      // silently shrank to a single row. Coverage can be asserted exactly,
      // without knowing anything about the embedder.
      expect(GOLDEN_SET.length).toBeGreaterThan(0);
      expect(structural.chunkCount).toBeGreaterThan(0);
      for (const [name, r] of Object.entries(reports)) {
        expect(r.nItems, `${name} did not run every golden item`).toBe(GOLDEN_SET.length);
        expect(r.items.length, `${name} lost per-item results`).toBe(GOLDEN_SET.length);
      }
    });

    it('returns a non-empty result set for every golden item', () => {
      // The other half. Embedder-independent: a nearest-neighbour search over a
      // non-empty corpus always returns SOMETHING, so an empty result set means
      // the query never reached the corpus — a dimension mismatch between the
      // ingest-time and query-time model, an ingest that wrote no rows for this
      // item's corpus, or an `asOf` bound that excluded everything. Each of
      // those is a wiring fault this run exists to catch, and each of them can
      // hide behind a pass rate that is merely low rather than zero.
      for (const [name, r] of Object.entries(reports)) {
        const empty = r.items.filter((i) => i.retrievedDocs.length === 0).map((i) => i.itemId);
        expect(empty, `${name} retrieved nothing at all for: ${empty.join(', ')}`).toEqual([]);
      }
    });

    // ── 🔴 NO PASS-RATE FLOOR IS ASSERTED. READ THIS BEFORE ADDING ONE. ──────
    //
    // `expect(passRate).toBeGreaterThan(0)` stood here and was not a floor: one
    // passing item out of forty-odd satisfies it, and so does a retriever that
    // returns the same document for every query.
    //
    // It has NOT been replaced by a number, because there is no number to
    // justify one with. Searched: nothing in this repo records a
    // real-embedder pass rate — not the plan, not a handoff note, not a
    // comment. That is consistent with a suite gated behind
    // `EVAL_REAL_EMBEDDER=1` precisely so it does not run, but it is an
    // ABSENCE OF EVIDENCE, not proof the suite has never been run. Either way
    // the consequence is the same: a threshold written here today would be a
    // guess wearing a measurement's clothes, which is the one thing a quality
    // gate must not be.
    //
    // ⚠ THE SIBLING GATE'S NUMBERS ARE NOT THIS ONE'S, and it is worth being
    // precise about why. `retrieval-eval.integration.test.ts` runs the SAME
    // golden set over the SAME corpus at the SAME topK, in the `integration`
    // job — but with the offline FNV-1a bag-of-words stub. That stub matches
    // tokens and models no synonymy, which makes it ARTIFICIALLY STRONG on the
    // `exact-identifier` slice — 21 of the set's 43 items, measured:
    // bare section numbers, `SPEC-035`, `metric 8.4` — and artificially weak on
    // the topical one (24 of 43). Its pass rate is therefore neither an upper
    // nor a lower bound on `bge-m3`'s; it is a different measurement. The
    // sibling makes exactly this argument about its own thresholds, and
    // asserts only RELATIVE improvements as a result.
    //
    // ⚠ AND THIS RUN IS NOT A SPANISH-DOMAIN NUMBER either — the shipped golden
    // set is domain-neutral English (see the header). A floor set from it would
    // not transfer to a consumer's corpus.
    //
    // HOW TO ESTABLISH ONE (the only honest route):
    //   1. Run this suite, with Rodrigo's per-run OK, at least three times —
    //      the embedder is a remote service and its output is not guaranteed
    //      byte-identical across runs.
    //   2. Record `nPass/nItems` per config AND the per-tag breakdown that
    //      `formatComparison` already prints. The aggregate alone hides the
    //      case that matters: a config that lifts the total while dropping
    //      `validity` off 100% must not ship.
    //   3. Set the floor below the WORST observed run, and write the date, the
    //      model id and the observed numbers next to it. A floor with no
    //      recorded measurement beside it rots into a number nobody dares move.
    //
    // UNTIL THEN THIS SUITE IS OBSERVATIONAL, NOT A GATE. It already sits
    // outside every blocking path — not in `npm test`, not in CI, and skipped
    // even under `npm run test:integration` unless `EVAL_REAL_EMBEDDER=1` — so
    // labelling it is a matter of saying so here rather than of moving it.
    it('OBSERVATIONAL (no floor): reports the real-embedder pass rate', () => {
      const summary = Object.entries(reports)
        .map(([name, r]) => `${name}: ${r.nPass}/${r.nItems} (${(r.passRate * 100).toFixed(1)}%)`)
        .join('  |  ');
      console.log(
        `\nOBSERVATIONAL — NO PASS-RATE FLOOR IS ASSERTED (${REAL_EMBEDDING_MODEL}):\n  ${summary}\n` +
          '  Record these, with the per-tag table above, before turning any of it into a gate.\n',
      );
      // Asserts only that the number EXISTS and is a rate — i.e. that the run
      // produced a report at all. Deliberately not a quality claim.
      for (const [name, r] of Object.entries(reports)) {
        expect(r.passRate, `${name} produced no pass rate`).toBeGreaterThanOrEqual(0);
        expect(r.passRate, `${name} pass rate is not a rate`).toBeLessThanOrEqual(1);
      }
    });
  },
);
