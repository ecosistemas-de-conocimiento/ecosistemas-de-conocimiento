// 🔴 THE HALF-POPULATED-CORPUS RANKING BIAS, REPRODUCED AGAINST A REAL POSTGRES.
//
// ── The defect this file pins ───────────────────────────────────────────────
// `rrfFuse` (src/services/rag/retrieve.ts) breaks an exact RRF score tie with a
// chain of tiers. That chain used to LEAD with a leg-count tier:
//
//     const af = legsFound.get(a.id) ?? 0;   // FIRST tier, ahead of every score
//     if (af !== bf) return bf - af;         // "found by both legs > found by one"
//
// It reads like the most meaningful step in the chain. It is the only BIASED
// one. Being found by two legs is not a property of the chunk — it is a
// property of whether the second leg was ELIGIBLE to see it, and both lexical
// legs filter on a NULLABLE column that ingest backfills:
//
//   * `sparseSearch` carries `AND "sparse_embedding" IS NOT NULL`;
//   * `lexicalSearch` matches nothing on a NULL `text_search`.
//
// `chunks.sparse_embedding` is written by the ingest worker ONLY when
// `SPARSE_ENABLED=true` (see `src/workers/ingest.worker.ts` §5b, and the column
// doc in `src/db/schema/index.ts`). So on any corpus where the sparse gate was
// flipped on AFTER content already existed, "found by both legs" degenerates
// into "ingested after the flip" — and with the leg count at the TOP of the
// chain, recency outranked relevance on every exact score tie. A chunk the
// dense leg ranked #1 lost to a chunk the dense leg ranked #3, purely because
// the older row predated the backfill.
//
// The fix is ORDER, not removal: the leg-count tier now sits BELOW `denseScore`
// and `lexicalScore`. Cosine similarity is eligible for every chunk
// (`chunks.embedding` is NOT NULL), so relevance settles the tie before
// eligibility ever gets a vote.
//
// ── Why this test exists, and why it is an INTEGRATION test ─────────────────
// The bias lives in the interaction between a SQL predicate (`IS NOT NULL`) and
// a JS sort. A unit test with a stubbed `execute` would have to hand-write the
// leg row sets, which means hand-writing the very asymmetry under test — it
// would assert that the sort does what the fixture already assumed. Only a real
// Postgres holding real NULLs proves that a half-populated corpus produces the
// asymmetric legs in the first place.
//
// ── The three things this file is built to guarantee ────────────────────────
//  1. EVERY CONDITION IS FORCED. Nothing here waits, polls, or depends on a
//     window. The pre-flip rows are written with `sparse_embedding` left NULL
//     and the post-flip rows are written with the ingest worker's own
//     parameterised `::sparsevec` UPDATE. The half-populated state is then READ
//     BACK and asserted (`the seeded corpus is genuinely half-populated`), so a
//     setup that silently stopped happening fails loudly instead of quietly
//     making the repro vacuous.
//  2. THE TIE IS EXACT, AND THE TEST SAYS SO. If the two RRF scores were merely
//     close, the sort would settle them on `score` and never reach the
//     tie-break — the test would pass while proving nothing. So the equality of
//     the two scores is itself an assertion, pinned to the exact dyadic value
//     (see the arithmetic below). A future change that stops the tie from being
//     a tie turns this file RED rather than green-and-hollow.
//  3. THE ONLY TIER THAT CAN SAVE THE OLDER CHUNK IS `denseScore`. The ordinals
//     are deliberately set so `ordinal` would order the pair the WRONG way, and
//     the older chunk has no `lexicalScore` at all (it is not in the sparse
//     leg), so `lexicalScore` would order it the wrong way too. Deleting the
//     `denseScore` tier, or demoting it below either of the other two, fails
//     this test.
//
// ── The arithmetic (this is the whole trick) ────────────────────────────────
// RRF: `score(d) = Σ_legs 1 / (k + rank_leg(d))`, with `rank` from
// `competitionRanks` (modified competition ranking — a tie block shares the LAST
// rank of the group). We drive `k` from the request (`rrfK: 1`, inside the
// contract's `min(1).max(1000)`):
//
//   pre-flip  #1 (`pre-top`)   dense rank 1, NO sparse row  → 1/2         = 0.5
//   post-flip #1 (`post-tie`)  dense rank 3, sparse rank 3  → 1/4 + 1/4   = 0.5
//
// THE TWO TERMS THAT FORM THE TIE ARE EXACT. 1/2 and 1/4 are exact binary
// fractions, so `0.25 + 0.25` is exactly `0.5` in IEEE-754 with no rounding
// anywhere — a bit-identical tie under `Object.is`, not a nearly-equal pair.
// That is what makes the `toBe(TIED_SCORE)` assertions load-bearing rather than
// approximate. This exactness claim covers THESE TWO ROWS ONLY.
//
// The other three rows exist only to PUT those two ranks where they need to be,
// and they are arranged so neither of them can outrank the pair:
//
//   pre-flip  filler  dense rank 2, no sparse row → 1/3           ≈ 0.33333
//   post-flip filler  dense rank 4, sparse rank 3 → 1/5 + 1/4     ≈ 0.45
//   post-flip filler  dense rank 5, sparse rank 3 → 1/6 + 1/4     ≈ 0.41666…
//
// Those three carry 1/3, 1/5 and 1/6, and NONE of them is an exact binary
// fraction — the rendered 0.45 above is the nearest double, not the real value.
// They do not need to be exact: the test asserts only their ORDER
// (0.5, 0.5, ≈0.45, ≈0.41666, ≈0.33333), never their value. Do not read the
// exactness claim above as covering the whole ladder.
//
// The three post-flip rows share ONE identical sparse vector, so their inner
// products against the query vector are identical and modified competition
// ranking credits all three with rank 3. That is what keeps a post-flip filler
// from collecting a rank-1 sparse contribution and jumping over the tied pair.
//
// Final order under the FIXED chain: pre-top, post-tie, then the fillers.
// Under the OLD chain the first two swap — which is the defect, and the thing
// the sabotage run must reproduce.
//
// ── 🔴 DO NOT RESTORE THE PRODUCTION `rrfK` DEFAULT ─────────────────────────
// `rrfK: 1` is not a cosmetic choice to keep the float arithmetic tidy. Exact
// binary fractions are only HALF the reason. The other half: at the production
// default, the tie-break tier this file tests is MATHEMATICALLY UNREACHABLE.
//
// With RRF parameter `k` and a fused pool of `N` candidates, the worst rank a
// document can hold in a leg is `N`. So a TWO-leg document scores at least
// `2/(k+N)`, and a ONE-leg document scores at most `1/(k+1)`. Those two ranges
// are disjoint whenever `2/(k+N) > 1/(k+1)`, which reduces to `N < k + 2`.
//
// The production defaults sit squarely inside that disjoint region. `topK`
// defaults to 10, the hybrid pool is `min(topK * 5, 100)` = 50, and
// `DEFAULT_RRF_K` is 60 (`DEFAULT_TOP_K`, `HYBRID_POOL_MULTIPLIER`,
// `HYBRID_POOL_CAP`, `DEFAULT_RRF_K` in `src/services/rag/retrieve.ts`).
// `50 < 62`, so a one-leg score (max `1/61` ≈ 0.016393) can NEVER equal a
// two-leg score (min `2/110` ≈ 0.018182). No exact tie between documents with
// different leg counts can exist at all. The ranges only start to overlap at
// `topK >= 13` (pool 65 >= 62).
//
// ⚠ So deleting `rrfK: 1` "because the production default is more realistic"
// does not make this test more realistic. It makes it VACUOUS: the sort settles
// every pair on `score`, the tie-break chain is never entered, and the run stays
// GREEN while exercising nothing. That is not hypothetical — mutating the
// leg-count tier into a `throw` and running the whole repo (1822 unit + 224
// integration tests) produced ZERO throws, because no other test reaches it
// either. This file is the only thing standing on that tier.
//
// If you want this scenario at a production-shaped `k`, you must ALSO raise
// `topK` past 12 — and then re-derive the entire ladder above, because none of
// the five score values survives the change.
//
// ── Wiring ─────────────────────────────────────────────────────────────────
// Mirrors `retrieve.integration.test.ts`: TEST_* DB rebound by
// `integration-setup.ts`, RAG tables wiped per-test here, and BOTH embedders
// injected as offline deterministic stubs — zero network. Injecting a
// `sparseEmbedder` also FORCES sparse availability, bypassing the
// `SPARSE_ENABLED` + `SPARSE_EMBED_URL` production gate (see the doc comment on
// `RetrieveServiceOptions.sparseEmbedder`), which is precisely the "gate flipped
// on" half of the scenario.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { RetrieveService, type Embedder, type RetrieveLogger } from './retrieve.js';
import type { SparseEmbedder } from '../ai/embeddings/sparse-embed.js';

const ORG = 'acme';
const PROJECT = 'chat';
const CORPUS = 'half-populated-it';

/**
 * 🔴 LOAD-BEARING. NOT interchangeable with `DEFAULT_RRF_K` (60). Two reasons,
 * both spelled out in the header:
 *   1. At `k = 1` the two terms that form the tie are `1/4` and `1/4` — exact
 *      binary fractions, so `0.25 + 0.25 === 0.5` holds under `Object.is`.
 *   2. At the production default the tie CANNOT EXIST. With pool 50 and k 60, a
 *      two-leg score is at least `2/110` and a one-leg score at most `1/61`:
 *      disjoint ranges, so the tie-break tier is never reached. Restoring the
 *      default makes this test VACUOUS, not more realistic.
 * Contract-legal (`src/contract/rag.ts`: int, min 1, max 1000).
 */
const RRF_K = 1;

/** The exact RRF score both sides of the tie must land on. Dyadic, so exact. */
const TIED_SCORE = 0.5;

/**
 * bge-m3 vocab width — must match `env.SPARSE_DIM` and the
 * `chunks.sparse_embedding` `sparsevec(N)` column, or the `::sparsevec` cast
 * throws. `env.ts` has a boot guard pinning the two together; this constant is
 * the test-side mirror.
 */
const SPARSE_DIM = 250002;

/**
 * The ONE sparse vector every post-flip chunk gets. A single hot token
 * (1-based sparsevec index 11) with weight 0.25. Identical across the three
 * rows, so their inner products against the query vector are identical — an
 * exact 3-way tie on the sparse leg, which modified competition ranking credits
 * at rank 3 for all three. 0.25 is exact in float4, so "identical" here means
 * bit-identical, not approximately equal.
 */
const CHUNK_SPARSE_LITERAL = `{11:0.25}/${SPARSE_DIM}`;

/**
 * A 1024-dim dense vector whose cosine similarity against the query vector
 * `hot(0)` is `w / sqrt(w² + 1)` — strictly increasing in `w`. Handing each
 * chunk a distinct `w` therefore pins its dense RANK exactly, with the gaps far
 * too wide (0.981 / 0.970 / 0.949 / 0.894 / 0.707) for float noise to reorder
 * them.
 */
function denseVec(w: number): number[] {
  const v = new Array(1024).fill(0);
  v[0] = w;
  v[1] = 1;
  return v;
}

/** The query vector: the first basis vector, so cosine reduces to the formula above. */
function queryVec(): number[] {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

/** Offline dense embedder — always returns the query vector. No network. */
const embedder = (async ({ model }: { model: string }) => ({
  embeddings: [queryVec()],
  model,
  usage: { inputTokens: 1, estimatedCostUsd: 0 },
})) as unknown as Embedder;

/**
 * Offline sparse embedder. Emits token id 10 (0-based) with weight 1, which
 * `toSparsevecLiteral` shifts to 1-based index 11 — the same index every
 * post-flip chunk carries, so the inner product is `1 * 0.25 = 0.25` for each.
 * Injecting this at all is what forces the sparse leg on.
 */
const sparseEmbedder: SparseEmbedder = async ({ model }) => ({
  model,
  dense: [],
  sparse: [{ indices: [10], values: [1] }],
});

/**
 * Collects every warning the service emits. A silently degrading sparse leg
 * (`sparseSearch` swallows ALL failures and returns [] by design) would
 * otherwise look like a passing dense-only run; asserting this stays empty
 * turns that into a failure.
 */
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

/**
 * The five seeded chunks, in the order the test asserts them.
 *
 * `sparse` says which side of the gate flip the row was ingested on:
 *   - `false` → pre-flip. `sparse_embedding` stays NULL, exactly as the ingest
 *     worker leaves it with `SPARSE_ENABLED=false`, so `sparseSearch`'s
 *     `IS NOT NULL` predicate excludes the row. DENSE-ONLY, one leg.
 *   - `true`  → post-flip. `sparse_embedding` written with the worker's own
 *     UPDATE. BOTH legs.
 *
 * `ordinal` is set ADVERSARIALLY: `pre-top` (the row that must win) carries the
 * HIGHEST ordinal and `post-tie` the lowest, so the `ordinal` tier — which sits
 * below the leg count in both the old and the new chain — would order the pair
 * the WRONG way if the `denseScore` tier ever stopped deciding first.
 */
const SEED = [
  { text: 'pre-top', w: 5, sparse: false, ordinal: 5 },
  { text: 'pre-filler', w: 4, sparse: false, ordinal: 6 },
  { text: 'post-tie', w: 3, sparse: true, ordinal: 0 },
  { text: 'post-filler-a', w: 2, sparse: true, ordinal: 1 },
  { text: 'post-filler-b', w: 1, sparse: true, ordinal: 2 },
] as const;

describe('RetrieveService on a HALF-POPULATED corpus (integration)', () => {
  afterAll(async () => {
    const { closeDb } = await import('../../db/client.js');
    await closeDb().catch(() => undefined);
  });

  beforeEach(async () => {
    const { db } = await import('../../db/client.js');
    await db.execute(sql`TRUNCATE TABLE chunks, documents, corpora RESTART IDENTITY CASCADE`);
  });

  /**
   * Two ingest waves either side of a sparse-gate flip.
   *
   * Wave 1 (`SPARSE_ENABLED=false`): insert chunks, write NO sparse vector.
   * Flip.
   * Wave 2 (`SPARSE_ENABLED=true`): insert chunks, then run the SAME
   * parameterised `SET "sparse_embedding" = $lit::sparsevec` statement the
   * ingest worker runs in its §5b block.
   *
   * The state is WRITTEN, never waited for — there is no backfill job in the
   * loop, no timer, and no ordering assumption beyond the two awaited
   * statements. `assertHalfPopulated` then reads the result back.
   */
  async function seedAcrossTheFlip() {
    const { db } = await import('../../db/client.js');
    const { chunks, corpora, documents } = await import('../../db/schema/index.js');

    const corpusId = (
      await db
        .insert(corpora)
        .values({ org: ORG, project: PROJECT, name: CORPUS })
        .returning({ id: corpora.id })
    )[0]!.id;

    // One document per chunk keeps `ordinal` free to be set adversarially
    // without colliding on `(document_id, ordinal)`.
    const docs = await db
      .insert(documents)
      .values(
        SEED.map((s) => ({
          corpusId,
          org: ORG,
          project: PROJECT,
          externalId: `doc-${s.text}`,
          text: s.text,
        })),
      )
      .returning({ id: documents.id, externalId: documents.externalId });
    const docFor = (text: string) => docs.find((d) => d.externalId === `doc-${text}`)!.id;

    const inserted = await db
      .insert(chunks)
      .values(
        SEED.map((s) => ({
          documentId: docFor(s.text),
          corpusId,
          org: ORG,
          project: PROJECT,
          ordinal: s.ordinal,
          text: s.text,
          embedding: denseVec(s.w),
        })),
      )
      .returning({ id: chunks.id, text: chunks.text });

    // ── The flip. Post-flip rows only. ───────────────────────────────────────
    for (const s of SEED) {
      if (!s.sparse) continue;
      const chunkId = inserted.find((c) => c.text === s.text)!.id;
      await db.execute(sql`
        UPDATE "chunks"
           SET "sparse_embedding" = ${CHUNK_SPARSE_LITERAL}::sparsevec
         WHERE "id" = ${chunkId}::uuid
      `);
    }

    return { corpusId };
  }

  /**
   * Reads the half-populated state back out of Postgres and asserts it is
   * exactly what the repro depends on. This is the "prove the setup happened"
   * half of the no-timing-dependence rule: if a schema change, a default, or a
   * trigger ever started populating `sparse_embedding` for every row, the
   * corpus would stop being half-populated and the repro below would silently
   * stop reproducing. This turns that into a failure instead.
   */
  async function assertHalfPopulated() {
    const { db } = await import('../../db/client.js');
    const res = await db.execute(sql`
      SELECT "text" AS text, ("sparse_embedding" IS NULL) AS is_null
        FROM "chunks"
       ORDER BY "text"
    `);
    const rows = (res as unknown as Array<{ text: string; is_null: boolean }>).map((r) => ({
      text: String(r.text),
      isNull: Boolean(r.is_null),
    }));
    expect(rows).toEqual([
      { text: 'post-filler-a', isNull: false },
      { text: 'post-filler-b', isNull: false },
      { text: 'post-tie', isNull: false },
      { text: 'pre-filler', isNull: true },
      { text: 'pre-top', isNull: true },
    ]);
  }

  it('the seeded corpus is genuinely half-populated (setup proof)', async () => {
    await seedAcrossTheFlip();
    await assertHalfPopulated();
  });

  it('the OLDER, MORE-SIMILAR chunk wins an EXACT RRF score tie', async () => {
    const { db } = await import('../../db/client.js');
    await seedAcrossTheFlip();
    // Re-proved inside the repro itself, not just in its own test: this test
    // must never be able to pass on a corpus that is not half-populated.
    await assertHalfPopulated();

    const { logger, warnings } = collectingLogger();
    const svc = new RetrieveService({ db, embedder, sparseEmbedder, logger });
    const out = await svc.retrieve(
      { corpus: CORPUS, query: 'x', mode: 'hybrid', rrfK: RRF_K },
      { org: ORG, project: PROJECT },
    );

    // ── Guard: both legs really ran. ─────────────────────────────────────────
    // `sparseSearch` degrades to [] on ANY failure (bad literal, dim drift,
    // timeout) and logs a warning. Without this, a dead sparse leg would leave
    // a dense-only ranking that happens to put `pre-top` first — a green run
    // proving nothing at all.
    expect(warnings).toEqual([]);
    expect(out.legs).toEqual(['dense', 'sparse']);

    const byText = new Map(out.chunks.map((c) => [c.text, c]));
    const preTop = byText.get('pre-top')!;
    const postTie = byText.get('post-tie')!;
    expect(preTop).toBeDefined();
    expect(postTie).toBeDefined();

    // ── Guard: the legs are ASYMMETRIC in the way the defect needs. ──────────
    // The older row is dense-only (one leg); the newer one carries both. This
    // is the eligibility asymmetry the old tie-break tier was reading as if it
    // were evidence of relevance.
    expect(preTop.ranks).toEqual({ dense: 1 });
    expect(preTop.lexicalScore).toBeUndefined();
    expect(postTie.ranks).toEqual({ dense: 3, lexical: 3 });
    expect(postTie.lexicalScore).toBeDefined();

    // ── Guard: the OLDER chunk is the MORE relevant one. ─────────────────────
    // Without this the test would merely be asserting an arbitrary order.
    expect(preTop.denseScore!).toBeGreaterThan(postTie.denseScore!);

    // ── 🔴 THE LOAD-BEARING ASSERTION: the tie is EXACT. ─────────────────────
    // `toBe` compares with `Object.is`, so this is bit-identity, not
    // approximate equality. If a future change makes these two scores merely
    // close, the sort settles them on `score` and never reaches the tie-break —
    // the repro would go green while testing nothing. It fails here instead.
    expect(preTop.score).toBe(TIED_SCORE); // 1/2
    expect(postTie.score).toBe(TIED_SCORE); // 1/4 + 1/4
    expect(preTop.score).toBe(postTie.score);

    // ── The defect. ─────────────────────────────────────────────────────────
    // With the leg-count tier leading the chain, `post-tie` (two legs) beat
    // `pre-top` (one leg) despite being strictly less similar — "ingested after
    // the sparse flip" outranking "more relevant". With the tier demoted below
    // `denseScore`, cosine similarity settles it and the older chunk wins.
    const order = out.chunks.map((c) => c.text);
    expect(order.indexOf('pre-top')).toBeLessThan(order.indexOf('post-tie'));

    // The full ladder, pinned. Documents the whole fusion and catches any
    // change that reshuffles the pair by moving the fillers instead.
    expect(order).toEqual([
      'pre-top', // 1/2                = 0.5   ← tie, wins on cosine
      'post-tie', // 1/4 + 1/4          = 0.5   ← tie, loses on cosine
      'post-filler-a', // 1/5 + 1/4     ≈ 0.45    (1/5 is NOT exact in binary)
      'post-filler-b', // 1/6 + 1/4     ≈ 0.41666 (1/6 is NOT exact in binary)
      'pre-filler', // 1/3              ≈ 0.33333 (1/3 is NOT exact in binary)
    ]);
  });
});
