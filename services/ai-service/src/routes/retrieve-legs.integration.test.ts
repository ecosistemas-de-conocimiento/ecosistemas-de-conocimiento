// 🔴 `legs` ON THE WIRE — the capability check that `retrievalLegs: true` is
// actually keeping.
//
// ── Why this file exists ────────────────────────────────────────────────────
// `src/capabilities.ts` advertises `retrievalLegs: true` under an explicit
// honesty contract: a capability that reports `true` while the feature is
// broken is WORSE than no capability at all, because it converts a loud
// failure (field missing, consumer throws) into a silent one (consumer trusts
// a flag and reads nothing).
//
// That flag was unbacked. An adversarial review rewrote the route handler in
// `src/routes/retrieve.ts` to
//
//     return { chunks: (await service.retrieve(...)).chunks };
//
// — stripping `legs` from the real HTTP surface — and the whole gate stayed
// green: unit 1822 passed, integration 224 passed, `tsc --noEmit` clean, and
// `GET /v1/capabilities` still answered `retrievalLegs: true`.
//
// Why nothing caught it:
//   * Every existing assertion on `legs` is SERVICE-level. `retrieve-legs.test.ts`
//     and `retrieve-half-populated.integration.test.ts` construct
//     `RetrieveService` directly and read its return value. Neither crosses the
//     route, the auth context, or JSON serialisation — the three places the
//     field can be dropped between the service and the consumer.
//   * `src/openapi/response-parse.integration.test.ts` DOES call
//     `POST /v1/retrieve`, but only its 404 path, and `legs` is `optional` in
//     the response schema, so a 200 without it would validate anyway.
//   * `npm run check`'s `contract:check` covers REQUEST types only —
//     `src/contract/wire-manifest.ts` states plainly that response shapes are
//     hand-written. The response schema is documentation, not enforcement.
//
// So this file is the only thing standing between `retrievalLegs: true` and a
// lie. It injects REAL `POST /v1/retrieve` requests against a REAL Postgres and
// asserts on the parsed HTTP BODY.
//
// ── What it pins, and why each case is mutation-detecting ──────────────────
//   1. dense: `legs` is present on the wire, is an ARRAY, and contains 'dense'.
//      → dies if the field is dropped, or serialised as anything but an array.
//   2. hybrid over a BACKFILLED `text_search`: `legs` also names the second leg
//      ('lexical' — `SPARSE_ENABLED` is forced off at the top of this file, so
//      the tsvector leg is the one that runs).
//      → dies if `legs` is hardcoded to `['dense']`.
//   3. hybrid over a NULL `text_search`: `legs` contains 'dense' and NOT the
//      lexical leg, even though the lexical leg was ATTEMPTED.
//      → dies if `legs` is hardcoded to `['dense','lexical']`, and pins the
//        actual contract wording: CONTRIBUTED legs, never requested ones.
//   4. an empty corpus: `legs` is present and EMPTY.
//      → dies if `legs` is a constant of any kind.
// Cases 2 and 3 are the same request shape over the same seed differing ONLY in
// whether the tsvector column was filled, so between them no constant array
// passes.
//
// ⚠ NO assertion here reads `legs.length` or `legs[i]`. `src/services/rag/types.ts`
// declares `legs` a SET whose membership will grow — the declared next change
// fuses dense + tsvector + sparse, making three names a legal response — so
// every assertion below is membership-only and survives that release. Same
// reason the negative in case 3 excludes BOTH lexical names rather than
// asserting an exact array.
//
// ── Wiring ─────────────────────────────────────────────────────────────────
// Mirrors `src/routes/tenant-isolation.integration.test.ts`: TEST_* URLs
// rebound by `integration-setup.ts`, `API_KEYS` rewritten at module top BEFORE
// the dynamic `import('../server.js')`, RAG tables truncated per test here
// (they are NOT in the shared `truncateEachTest` list). The embedder is the
// real `callOpenRouterEmbedding`, pointed at the TEST-ONLY fake provider
// (`test-support/fake-provider/`), whose vectors are `fakeEmbedOne(text)` — so
// these run over local HTTP with ZERO spend.
//
// Nothing here is timing-dependent: no sleeps, no polling, no retries. Every
// precondition (the tsvector column filled / left NULL, the chunk count) is
// FORCED by a write and then READ BACK before the request that depends on it.
//
// ⚠ NO `describe.skipIf` / `.skip` / `.only` in this file, deliberately: the
// integration lane has no skip path (`integration-global-setup.ts` throws
// rather than skipping) and `integration-database.test.ts` fails the unit suite
// if an integration file gates itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeEmbedOne, startFakeProvider } from '../../test-support/fake-provider/server.mjs';
import { eq, sql } from 'drizzle-orm';

// Rewrite env BEFORE any import that pulls `config/env.ts` / `server.ts`.
// Static imports are hoisted above these assignments, which is why
// `buildServer` is pulled in with a dynamic `import()` inside `beforeAll`.
const fake = await startFakeProvider();
Object.assign(process.env, fake.env);
// FORCE the hybrid second leg to be the `tsvector` one rather than leaving it
// to whatever the ambient environment happens to carry. `retrieve.ts` picks
// `sparse` over `lexical` when `SPARSE_ENABLED` AND `SPARSE_EMBED_URL` are both
// set; clearing both makes case 2's leg name deterministic — and it must be,
// because "names its second leg" is the assertion.
process.env.SPARSE_ENABLED = 'false';
delete process.env.SPARSE_EMBED_URL;
process.env.API_KEYS = JSON.stringify({
  'app-legs': { org: 'acme', project: 'chat', role: 'app' },
});

import type { FastifyInstance } from 'fastify';


const TENANT = { org: 'acme', project: 'chat', key: 'app-legs' } as const;
const auth = { authorization: `Bearer ${TENANT.key}` };

/** Both lexical leg names. Case 3 excludes BOTH, so it cannot be fooled by a rename. */
const LEXICAL_LEGS = ['lexical', 'sparse'] as const;

/** Every leg name `RetrievalLeg` allows today (`src/services/rag/types.ts`). */
const KNOWN_LEGS = ['dense', 'lexical', 'sparse', 'rerank'] as const;

async function dbHandle() {
  const { db } = await import('../db/client.js');
  return db;
}

async function schema() {
  return import('../db/schema/index.js');
}

/**
 * Seed one corpus with `texts.length` chunks under one document, all owned by
 * the single tenant this file uses.
 *
 * `text_search` is deliberately left NULL — it is NOT a generated column; the
 * ingest worker fills it (`src/services/rag/corpus-crud.ts`). Whether it is
 * filled is precisely the difference between case 2 and case 3, so it is a
 * separate, explicit step (`backfillTextSearch`) rather than a side effect of
 * seeding.
 */
async function seedCorpus(name: string, texts: string[]): Promise<string> {
  const db = await dbHandle();
  const { chunks, corpora, documents } = await schema();

  const corpusId = (
    await db
      .insert(corpora)
      .values({ org: TENANT.org, project: TENANT.project, name })
      .returning({ id: corpora.id })
  )[0]!.id;

  if (texts.length === 0) return corpusId;

  const documentId = (
    await db
      .insert(documents)
      .values({
        corpusId,
        org: TENANT.org,
        project: TENANT.project,
        externalId: `${name}-doc`,
        text: texts.join('\n'),
      })
      .returning({ id: documents.id })
  )[0]!.id;

  await db.insert(chunks).values(
    texts.map((text, ordinal) => ({
      documentId,
      corpusId,
      org: TENANT.org,
      project: TENANT.project,
      ordinal,
      text,
      embedding: fakeEmbedOne(text),
    })),
  );

  return corpusId;
}

/**
 * Fill `chunks.text_search` the way the ingest worker does — `to_tsvector` with
 * the corpus's configured regconfig, which is `'simple'` by default
 * (`corpora.text_search_config`).
 */
async function backfillTextSearch(corpusId: string): Promise<void> {
  const db = await dbHandle();
  await db.execute(sql`
    UPDATE "chunks"
       SET "text_search" = to_tsvector('simple'::regconfig, "text")
     WHERE "corpus_id" = ${corpusId}::uuid
  `);
}

/** How many of this corpus's chunks have a non-NULL `text_search`. */
async function textSearchFilled(corpusId: string): Promise<{ filled: number; total: number }> {
  const db = await dbHandle();
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT("text_search")::int AS filled
      FROM "chunks"
     WHERE "corpus_id" = ${corpusId}::uuid
  `);
  const row = ([...(rows as unknown as Iterable<Record<string, unknown>>)][0] ?? {}) as {
    total?: number;
    filled?: number;
  };
  return { filled: Number(row.filled ?? 0), total: Number(row.total ?? 0) };
}

type RetrieveBody = {
  chunks: Array<{ text: string; lexicalScore?: number; denseScore?: number }>;
  legs?: unknown;
};

describe('POST /v1/retrieve reports `legs` ON THE WIRE (capability `retrievalLegs`)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildServer } = await import('../server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDb } = await import('../db/client.js');
    await closeDb().catch(() => undefined);
  await fake.close();
  });

  // The RAG tables are NOT in the shared per-test truncate list (see
  // `src/test/integration-database.ts`), so wipe them here.
  beforeEach(async () => {
    const db = await dbHandle();
    await db.execute(
      sql`TRUNCATE TABLE corpus_aliases, chunks, documents, corpora RESTART IDENTITY CASCADE`,
    );
  });

  /** One real HTTP round-trip through auth, the route and JSON serialisation. */
  async function retrieve(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: auth,
      payload,
    });
    return res;
  }

  /**
   * The wire-shape assertion, shared by every case: `legs` is PRESENT as an own
   * property of the response object, is a real ARRAY (not a truthy string, not
   * an object), holds only known leg names, and holds each name at most once.
   *
   * `Array.isArray` rather than a truthiness check on purpose — `legs`
   * legitimately comes back `[]` (case 4), and `[]` is truthy while `undefined`
   * is not, so a truthiness assertion would be simultaneously too weak and too
   * strong.
   */
  function assertLegsOnTheWire(res: { body: string; json: () => unknown }): string[] {
    const body = res.json() as RetrieveBody;
    // Own property, so an inherited/undefined `legs` cannot pass.
    expect(Object.prototype.hasOwnProperty.call(body, 'legs')).toBe(true);
    // …and it survived serialisation as a JSON array, which is what the
    // consumer actually parses.
    expect(res.body).toContain('"legs"');
    expect(Array.isArray(body.legs)).toBe(true);
    const legs = body.legs as unknown[];
    for (const leg of legs) expect(KNOWN_LEGS).toContain(leg);
    expect(new Set(legs).size).toBe(legs.length);
    return legs as string[];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Dense — the plain path, and the one the reviewer's mutation stripped.
  // ══════════════════════════════════════════════════════════════════════════
  it('🔴 dense: the 200 body carries `legs` as an ARRAY naming the dense leg', async () => {
    await seedCorpus('ledger', ['quarterly revenue figure for the northern region']);

    const res = await retrieve({
      corpus: 'ledger',
      query: 'quarterly revenue figure for the northern region',
      topK: 5,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as RetrieveBody;
    // Positive control: the dense leg really did return a row, so 'dense' below
    // is reporting work rather than decorating an empty response.
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]!.denseScore).toBeTypeOf('number');

    const legs = assertLegsOnTheWire(res);
    expect(legs).toContain('dense');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Hybrid with the tsvector column FILLED — the second leg is NAMED.
  // ══════════════════════════════════════════════════════════════════════════
  //
  // This is the case a hardcoded `['dense']` cannot survive.
  it('🔴 hybrid: the body names the SECOND leg alongside dense', async () => {
    const corpusId = await seedCorpus('ledger', [
      'quarterly revenue figure for the northern region',
      'headcount plan for the southern region',
    ]);
    await backfillTextSearch(corpusId);
    // FORCE-and-verify: the lexical leg matches nothing on a NULL `text_search`,
    // so the precondition for this case is read back rather than assumed.
    expect(await textSearchFilled(corpusId)).toEqual({ filled: 2, total: 2 });

    const res = await retrieve({
      corpus: 'ledger',
      query: 'quarterly revenue',
      topK: 5,
      mode: 'hybrid',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as RetrieveBody;
    // Positive control for the SECOND leg specifically: `lexicalScore` is the
    // slot both lexical legs fill, so a row carrying one proves the leg ran.
    expect(body.chunks.some((c) => typeof c.lexicalScore === 'number')).toBe(true);

    const legs = assertLegsOnTheWire(res);
    expect(legs).toContain('dense');
    // `SPARSE_ENABLED` is forced off at the top of this file, so the tsvector
    // leg is the one that runs and 'lexical' is its name. Membership only — no
    // length, no index: `legs` is a SET whose membership is declared to grow.
    expect(legs).toContain('lexical');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Hybrid with the tsvector column NULL — ATTEMPTED is not CONTRIBUTED.
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Same request as case 2 over the same seed; the ONLY difference is that
  // `text_search` was never backfilled, so the lexical leg runs and matches
  // nothing. This is the exact production degradation `legs` was added to make
  // visible, and it is what a hardcoded `['dense','lexical']` dies on.
  it('🔴 hybrid over an un-backfilled tsvector: the lexical leg is ATTEMPTED but NOT named', async () => {
    const corpusId = await seedCorpus('ledger', [
      'quarterly revenue figure for the northern region',
      'headcount plan for the southern region',
    ]);
    // FORCE-and-verify the opposite precondition: nothing filled.
    expect(await textSearchFilled(corpusId)).toEqual({ filled: 0, total: 2 });

    const res = await retrieve({
      corpus: 'ledger',
      query: 'quarterly revenue',
      topK: 5,
      mode: 'hybrid',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as RetrieveBody;
    // The request still succeeds on the dense leg — degrading, not failing, is
    // the contract. Without this the negative below would pass on a 200 that
    // returned nothing at all.
    expect(body.chunks.length).toBeGreaterThan(0);
    // …and no row carries a lexical score, which is the independent evidence
    // that the leg contributed nothing.
    expect(body.chunks.every((c) => c.lexicalScore === undefined)).toBe(true);

    const legs = assertLegsOnTheWire(res);
    expect(legs).toContain('dense');
    // BOTH lexical names are excluded, so renaming the leg cannot quietly
    // satisfy this.
    for (const name of LEXICAL_LEGS) expect(legs).not.toContain(name);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. An EMPTY corpus — `legs` is present and empty, not absent, not defaulted.
  // ══════════════════════════════════════════════════════════════════════════
  it('🔴 a corpus with no chunks answers 200 with an EMPTY `legs` array, still on the wire', async () => {
    const corpusId = await seedCorpus('ledger', []);
    const db = await dbHandle();
    const { chunks } = await schema();
    // Forced precondition, read back: the corpus exists and holds nothing.
    expect(
      await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.corpusId, corpusId)),
    ).toHaveLength(0);

    const res = await retrieve({ corpus: 'ledger', query: 'anything at all', topK: 5 });

    expect(res.statusCode).toBe(200);
    expect((res.json() as RetrieveBody).chunks).toEqual([]);

    const legs = assertLegsOnTheWire(res);
    // No leg returned a row, so no leg is named. Together with cases 1–3 this
    // rules out `legs` being a constant of ANY value: the same endpoint returns
    // ['dense'], ['dense','lexical'] and [] across this file.
    expect(legs).toEqual([]);
  });
});
