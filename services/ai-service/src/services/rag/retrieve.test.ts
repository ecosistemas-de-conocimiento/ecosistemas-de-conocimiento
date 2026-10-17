// Unit tests for `RetrieveService`.
//
// The DB is a hand-rolled stub: `select().from(table).where(p).limit()` returns
// a pre-seeded corpus row (or empty), and `db.execute(sql\`...\`)` returns the
// pre-seeded candidate rows for the vector search. The embedder is a spy that
// returns a deterministic vector and asserts the corpus's embedding model
// flows through unchanged.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// It used to read `where: () => ({ limit: … })` — a function with NO parameter.
// Whatever predicate the production code built was DISCARDED at the door, so
// every case in this file agreed with any WHERE clause at all, INCLUDING NONE.
// `lookupCorpus` carries the only thing standing between two tenants' corpora —
// `and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project), …)` — and
// deleting those terms left this file green. That exact class of mistake
// shipped a cross-tenant corpus wipe past a green suite.
//
// `where()` now hands its predicate to a `WhereRecorder`, which serialises it
// with drizzle's own dialect and lets the tests assert on the emitted SQL text
// and the bound values. Two consequences worth knowing:
//   * `from()` takes the TABLE too, so the stub can tell the alias lookup from
//     the corpus lookup, and can tell the alias path's two `corpora` reads apart
//     by their predicates (by-`name` vs by-`id`). That is what finally lets this
//     file exercise `lookupCorpus`'s SECOND, independent tenant gate — the
//     alias-target re-check, which no test here previously reached.
//   * a dropped `eq(...)` term surfaces as a missing column or a missing bound
//     param, in milliseconds, with no database.
//
// 🔴 …AND THE OTHER MUTATION: DELETING THE `.where()` CALL ENTIRELY.
// Recording the predicate only catches the `.where()` that is left in place and
// emptied. Deleting the call reached no recorder at all, and this file's stub
// gave it a SECOND disguise: `limit` lived only inside the `where()` result, so
// `selectCorpusColumns().limit(1)` blew up with
// `TypeError: this.selectCorpusColumns(...).limit is not a function` — 41 of 41
// cases red with a message about the STUB's shape, naming no tenant leak. A red
// that points at the wrong thing is worse than a green one: it invites the next
// person to re-shape the stub and ship the dropped filter.
//
// The `from()` result now carries its own guarded `limit`/`then`, so a chain
// that never calls `where()` settles through `WhereRecorder.guard` and lands in
// the recorded list as `<NO PREDICATE>` — where `expectEveryQueryScopedTo` and
// `expectNoUnfilteredQuery` reject it BY NAME.
//
// ⚠ A mock still cannot PROVE isolation — it only shows which predicate was
// BUILT, never that Postgres honoured it. The full-strength proof (seed rows as
// tenant B, act as tenant A, read B's rows back) lives in
// `src/routes/tenant-isolation.integration.test.ts` against a real database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CorpusNotFoundError, RERANK_DEGRADED_MESSAGE, RetrieveService } from './retrieve.js';
import type { Embedder, RerankDegradedWarning, RetrieveLogger } from './retrieve.js';
import type { Reranker } from '../ai/rerank/rerank-client.js';
import { NO_PREDICATE, WhereRecorder, type RecordedWhere } from '../../test/where-recorder.js';

interface DbState {
  corpus: Record<string, unknown> | null;
  /**
   * Rows the `corpus_aliases` lookup returns. Non-empty ⇒ the requested name is
   * an ALIAS, which sends `lookupCorpus` down its second tenant gate. Optional
   * because only the alias cases care; every other case leaves it empty and the
   * alias branch is never reached.
   */
  aliasRows?: { targetCorpusId: string }[];
  /** The corpus row the alias-TARGET re-check returns (null ⇒ out of scope). */
  aliasTarget?: Record<string, unknown> | null;
  executeRows: Record<string, unknown>[];
  executeCalls: unknown[];
}

/**
 * One recorder for the whole file, cleared in `beforeEach` so a test only ever
 * sees the predicates its OWN call built. It lives outside `DbState` so the
 * existing state literals below stay untouched.
 */
const wheres = new WhereRecorder();
beforeEach(() => {
  wheres.reset();
});

/** The table a drizzle `from(...)` was handed, under the name drizzle uses. */
function tableName(table: unknown): string {
  const name = (table as Record<symbol, unknown> | null)?.[Symbol.for('drizzle:Name')];
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * Which rows a recorded lookup resolves to.
 *
 * `lookupCorpus` reads `corpora` TWICE on the alias path: once by `name` (the
 * direct hit that misses) and once by `id` (the alias target). Both go through
 * the same `selectCorpusColumns()` builder, so the ONLY thing that tells them
 * apart is the predicate — which the stub can now see. Dispatching on it here
 * is deliberate: a call-counter would mis-route the tests that reuse one `db`
 * across two `retrieve()` calls.
 */
function rowsFor(state: DbState, recorded: RecordedWhere): unknown[] {
  if (recorded.table === 'corpus_aliases') return state.aliasRows ?? [];
  if (recorded.table !== 'corpora') return [];
  // 🔴 AN UNFILTERED READ RETURNS ROWS, NOT NOTHING.
  // `SELECT … FROM corpora LIMIT 1` with no WHERE hands back an arbitrary row —
  // another tenant's included. Modelling that as `[]` would make production
  // throw `CorpusNotFoundError` before any assertion ran, so a deleted
  // `.where()` would surface as "corpus not found": red, but red about the
  // FIXTURE rather than about the tenancy hole. Handing back whatever corpus
  // this fixture holds lets the call finish and lets the assertion NAME the
  // missing predicate.
  if (recorded.sql === NO_PREDICATE) {
    return [state.corpus ?? state.aliasTarget].filter((r) => r != null);
  }
  if (recorded.sql.includes('"corpora"."id" =')) {
    return state.aliasTarget ? [state.aliasTarget] : [];
  }
  return state.corpus ? [state.corpus] : [];
}

function makeDb(state: DbState): import('../../db/client.js').Db {
  const chain = {
    select: () => ({
      // 🔴 `from` TAKES the table and `where` TAKES the predicate. Both
      // parameters are the point: without the table we cannot tell the alias
      // lookup from the corpus lookup, and without the predicate we cannot tell
      // a tenant-scoped query from a bare one.
      from: (table: unknown) => {
        const name = tableName(table);
        // 🔴 ONE guard per `from()`, i.e. per chain instance — that is what
        // lets `settle()` distinguish "this chain was filtered" from "this
        // chain was never filtered". See `WhereRecorder.guard`.
        const guard = wheres.guard(name);
        /**
         * The chain settling with NO `where()` ever called: a whole-table
         * SELECT. `settle` records it as `<NO PREDICATE>` under this table's
         * name, and `rowsFor` answers it the way an unfiltered read answers —
         * with rows, not with nothing (see its `NO_PREDICATE` branch).
         *
         * ⚠ Before this existed, deleting a `.where(...)` from `retrieve.ts`
         * did not fail the tenant assertions — it failed with
         * `TypeError: this.selectCorpusColumns(...).limit is not a function`,
         * because `limit` lived only INSIDE the `where()` result. An accidental
         * red with a misleading message is not a gate: the next person reads
         * "the stub is out of date", re-shapes the stub, and the dropped tenant
         * filter ships.
         */
        const unfiltered = () =>
          Promise.resolve(
            guard.settle(rowsFor(state, { table: name, sql: NO_PREDICATE, params: [] })),
          );
        return {
          where: (predicate: unknown) => {
            const recorded = guard.where(predicate);
            return {
              limit: () => Promise.resolve(guard.settle(rowsFor(state, recorded))),
            };
          },
          // Both terminals of the UNFILTERED shape. `limit` is the one the real
          // mutation hits (`selectCorpusColumns().limit(1)`); `then` covers an
          // awaited chain that never calls either.
          limit: unfiltered,
          then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
            unfiltered().then(resolve as (v: unknown[]) => void, reject),
        };
      },
    }),
    execute: vi.fn(async (query: unknown) => {
      state.executeCalls.push(query);
      return state.executeRows;
    }),
  };
  return chain as unknown as import('../../db/client.js').Db;
}

function makeEmbedder(opts?: {
  fail?: Error;
  vec?: number[];
}): Embedder {
  return vi.fn(async ({ model, input }: { model: string; input: string | string[] }) => {
    if (opts?.fail) throw opts.fail;
    const vec = opts?.vec ?? [0.1, 0.2, 0.3];
    return {
      embeddings: [vec],
      model,
      usage: { inputTokens: Array.isArray(input) ? input.length * 4 : 4, estimatedCostUsd: 0 },
    };
  }) as unknown as Embedder;
}

const ORG = 'org-1';
const PROJECT = 'proj-1';
const CORPUS_NAME = 'docs';
const CORPUS_ID = '00000000-0000-4000-8000-000000000001';
const SEED_CORPUS = {
  id: CORPUS_ID,
  org: ORG,
  project: PROJECT,
  name: CORPUS_NAME,
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDim: 1024,
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
};

describe('RetrieveService.retrieve', () => {
  it('returns chunks ordered by cosine score on the happy path', async () => {
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.92 },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'beta', metadata: null, score: 0.71 },
        { id: 'c3', document_id: 'd2', ordinal: 0, text: 'gamma', metadata: { tag: 'g' }, score: 0.5 },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const embedder = makeEmbedder();
    const svc = new RetrieveService({ db, embedder });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'hello?' },
      { org: ORG, project: PROJECT },
    );

    expect(out.chunks).toHaveLength(3);
    expect(out.chunks[0]).toMatchObject({
      chunkId: 'c1',
      documentId: 'd1',
      ordinal: 0,
      text: 'alpha',
      score: 0.92,
    });
    expect(out.chunks[2]?.metadata).toEqual({ tag: 'g' });
    // Embedder called with the corpus's configured model — NOT a hardcoded one.
    expect(embedder).toHaveBeenCalledWith({
      model: 'openai/text-embedding-3-small',
      input: 'hello?',
    });
    // 🔴 The corpus that fed those chunks was looked up under the CALLER's
    // tenancy, not merely under its name. The old parameterless `where()` could
    // not see this at all: it would have agreed with a bare `eq(corpora.name,
    // …)` that reaches straight into another tenant's corpus.
    //
    // EVERY, not "at least one": this path reads `corpora` exactly once and
    // that read must be scoped, so there is no reason to accept a second,
    // unscoped read alongside it. `expectScopedTo` would.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  it('defaults topK to 10 when not provided', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const svc = new RetrieveService({ db, embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q' },
      { org: ORG, project: PROJECT },
    );
    // Exactly one execute call; the inline SQL fragment's `LIMIT $param`
    // takes its value from the default topK (10), not MMR-pool-doubled.
    expect(state.executeCalls).toHaveLength(1);
    const call = state.executeCalls[0] as { queryChunks?: unknown[] };
    // Drizzle sql template stores queryChunks (StringChunk + Param objects).
    const flat = JSON.stringify(call);
    expect(flat).toContain('LIMIT');
    // 10 is the default and must appear as a param value somewhere in the SQL.
    expect(flat).toContain('10');
  });

  it('reranks via MMR when mmr lambda is provided (result differs from raw top-K)', async () => {
    // Three near-duplicates and one diverse chunk. Pure cosine would return
    // the three near-duplicates first; MMR with lambda=0.5 should swap the
    // diverse one into the top-K.
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'similar A', metadata: null, score: 0.95, embedding: '[1,0,0]' },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'similar B', metadata: null, score: 0.94, embedding: '[1,0,0]' },
        { id: 'c3', document_id: 'd1', ordinal: 2, text: 'similar C', metadata: null, score: 0.93, embedding: '[1,0,0]' },
        { id: 'c4', document_id: 'd2', ordinal: 0, text: 'diverse',   metadata: null, score: 0.6,  embedding: '[0,1,0]' },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const svc = new RetrieveService({
      db,
      embedder: makeEmbedder({ vec: [1, 0, 0] }),
    });

    const rawTopK = (
      await svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q', topK: 2 },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);
    expect(rawTopK).toEqual(['c1', 'c2']);

    const withMmr = (
      await svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q', topK: 2, mmr: 0.5 },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);
    // MMR should keep c1 (highest relevance) and prefer the diverse c4
    // over near-duplicate c2.
    expect(withMmr[0]).toBe('c1');
    expect(withMmr).not.toEqual(rawTopK);
    expect(withMmr).toContain('c4');
  });

  // ---------------------------------------------------------------------------
  // Metadata filter (plan/open-retrieve-metadata-filter.md §4/§7). The query
  // builder must emit the `metadata @> $::jsonb` containment clause ONLY when a
  // non-empty filter is present, bound (never interpolated), and in BOTH the
  // MMR and non-MMR SQL branches. The no-filter path must stay byte-identical.
  // ---------------------------------------------------------------------------

  /**
   * Flatten a captured drizzle `sql` template (recursing into nested `sql`
   * fragments, which appear as inner `SQL` objects with their own
   * `queryChunks`) into its raw SQL text + the ordered bound params. A
   * `StringChunk` carries `value: string[]`; a `Param` carries a non-array
   * `value` (the bound value); an `SQL` fragment carries `queryChunks`.
   */
  function inspectSql(call: unknown): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const walk = (node: unknown): string => {
      // Bound values appear as bare param nodes (string/number/etc.) embedded
      // between StringChunks; capture them and render a `$` placeholder so the
      // value never lands in the inspected SQL text.
      if (node === null || typeof node !== 'object') {
        params.push(node);
        return '$';
      }
      const n = node as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(n.queryChunks)) {
        return n.queryChunks.map(walk).join('');
      }
      if (Array.isArray(n.value)) {
        return (n.value as string[]).join(''); // StringChunk
      }
      if (n.value !== undefined) {
        params.push(n.value); // Param wrapper
        return '$';
      }
      return '';
    };
    return { sql: walk(call), params };
  }

  it('emits NO metadata clause when filter is absent (byte-identical to today)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve({ corpus: CORPUS_NAME, query: 'q' }, { org: ORG, project: PROJECT });
    const { sql } = inspectSql(state.executeCalls[0]);
    // No containment predicate at all (the SELECT still projects "metadata",
    // but the WHERE has no `@>` clause).
    expect(sql).not.toContain('@>');
    // The WHERE remains corpus-only.
    expect(sql).toContain('"corpus_id" = ');
  });

  it('treats an empty filter ({}) as no filter (no containment clause)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', filter: {} },
      { org: ORG, project: PROJECT },
    );
    expect(inspectSql(state.executeCalls[0]).sql).not.toContain('@>');
  });

  it('emits a bound jsonb containment clause before ORDER BY when filter is present', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', filter: { sessionId: 'x' } },
      { org: ORG, project: PROJECT },
    );
    const { sql, params } = inspectSql(state.executeCalls[0]);
    expect(sql).toContain('"metadata" @> ');
    expect(sql).toContain('::jsonb');
    // Clause is pre-ranking: containment appears before the ORDER BY distance sort.
    expect(sql.indexOf('@>')).toBeLessThan(sql.indexOf('ORDER BY'));
    // Filter is BOUND as a JSON string param, never interpolated into SQL text.
    expect(params).toContain(JSON.stringify({ sessionId: 'x' }));
    expect(sql).not.toContain('sessionId');
  });

  it('emits the containment clause in the MMR branch too', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', mmr: 0.5, filter: { tag: 'a' } },
      { org: ORG, project: PROJECT },
    );
    const { sql } = inspectSql(state.executeCalls[0]);
    // MMR branch is the one that also SELECTs the raw embedding text.
    expect(sql).toContain('"embedding"::text');
    expect(sql).toContain('"metadata" @> ');
    expect(sql.indexOf('@>')).toBeLessThan(sql.indexOf('ORDER BY'));
  });

  // ---------------------------------------------------------------------------
  // Cross-encoder rerank rung (plan §1). Runs AFTER retrieval over a deepened
  // pool, before the final slice. Injecting a reranker FORCES availability
  // (bypasses the RERANK_ENABLED/RERANK_URL env gate) so these tests need no env.
  // ---------------------------------------------------------------------------

  /** A deterministic stub `Reranker` that scores documents by a text→score map. */
  function makeReranker(scoreByText: Record<string, number>): Reranker {
    return vi.fn(
      async ({ documents, model, topN }: { documents: string[]; model: string; topN?: number }) => {
        const results = documents
          .map((doc, index) => ({ index, relevanceScore: scoreByText[doc] ?? 0 }))
          .sort((a, b) => b.relevanceScore - a.relevanceScore);
        return {
          results: typeof topN === 'number' ? results.slice(0, topN) : results,
          model,
          usage: { estimatedCostUsd: 0 },
        };
      },
    ) as unknown as Reranker;
  }

  const RERANK_ROWS = [
    { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.92 },
    { id: 'c2', document_id: 'd1', ordinal: 1, text: 'beta', metadata: null, score: 0.71 },
    { id: 'c3', document_id: 'd2', ordinal: 0, text: 'gamma', metadata: null, score: 0.5 },
  ];

  it('re-orders by rerankScore and mirrors it into score (denseScore preserved)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const reranker = makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 });
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );

    // beta (0.9) > gamma (0.5) > alpha (0.1) — a completely different order
    // from the cosine order (alpha, beta, gamma).
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2', 'c3', 'c1']);
    expect(out.chunks[0]).toMatchObject({ chunkId: 'c2', rerankScore: 0.9, score: 0.9 });
    // The cosine value survives as denseScore for consumers that still want it.
    expect(out.chunks[0]?.denseScore).toBe(0.71);
    expect(reranker).toHaveBeenCalledOnce();
  });

  it('rerank wins over MMR when both are requested', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const reranker = makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 });
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true, mmr: 0.5 },
      { org: ORG, project: PROJECT },
    );
    // Rerank order + rerankScore present ⇒ rerank ran, MMR did not.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2', 'c3', 'c1']);
    expect(out.chunks[0]?.rerankScore).toBe(0.9);
    expect(reranker).toHaveBeenCalledOnce();
  });

  it('deepens the candidate pool for rerank (LIMIT = min(topK*4, 50), not topK)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const svc = new RetrieveService({
      db: makeDb(state),
      embedder: makeEmbedder(),
      reranker: makeReranker({}),
    });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', topK: 3, rerank: true },
      { org: ORG, project: PROJECT },
    );
    // topK=3 ⇒ poolDepth = min(12, 50) = 12; the fetch LIMIT must reflect the
    // deepened pool, not the final topK.
    const flat = JSON.stringify(state.executeCalls[0]);
    expect(flat).toContain('12');
  });

  it('logs ONE `rerank ok` line on success, at info — counts and ids, never text', async () => {
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const base = makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 });
    // The real `callRerank` reports `egress`; this stub stands in for it.
    const reranker = (async (args: Parameters<Reranker>[0]) => ({
      ...(await base(args)),
      egress: { redactions: 3, counts: { curp: 2, rfc: 0, email: 1, phone: 0, address: 0, person: 0 } },
    })) as Reranker;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker, logger });

    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'secret question', rerank: true, topK: 2, rerankModel: 'm1' },
      { org: ORG, project: PROJECT },
    );

    const lines = logger.info.mock.calls.filter((c) => c[1] === RERANK_OK_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({
      corpus: CORPUS_NAME,
      org: ORG,
      project: PROJECT,
      model: 'm1',
      provider: expect.any(String),
      poolSize: 3,
      scored: 2,
      topK: 2,
      piiMinimised: true,
      piiRedactions: 3,
      piiCounts: { curp: 2, email: 1 },
    });
    const line = JSON.stringify(lines[0]![0]);
    for (const text of ['secret question', 'alpha', 'beta', 'gamma']) expect(line).not.toContain(text);
  });

  it('`rerank ok` reports piiMinimised:false when the reranker returned no egress report', async () => {
    // An injected reranker is not `callRerank`: nothing proves a scrub ran, so
    // the line must not claim one.
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const svc = new RetrieveService({
      db: makeDb(state),
      embedder: makeEmbedder(),
      reranker: makeReranker({ beta: 1 }),
      logger,
    });
    await svc.retrieve({ corpus: CORPUS_NAME, query: 'q', rerank: true }, { org: ORG, project: PROJECT });
    const line = logger.info.mock.calls.find((c) => c[1] === RERANK_OK_MESSAGE)?.[0];
    expect(line).toMatchObject({ piiMinimised: false, piiRedactions: null, piiCounts: null });
  });

  it('a warn-only logger still works — `info` is optional on RetrieveLogger', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const logger: RetrieveLogger = { warn: vi.fn() };
    const svc = new RetrieveService({
      db: makeDb(state),
      embedder: makeEmbedder(),
      reranker: makeReranker({ beta: 1 }),
      logger,
    });
    const out = await svc.retrieve({ corpus: CORPUS_NAME, query: 'q', rerank: true }, { org: ORG, project: PROJECT });
    expect(out.legs).toContain('rerank');
  });

  it('a THROWING `info` logger does not turn a successful rerank into a false `error` fallback', async () => {
    // The `rerank ok` line is logged after the reranker returned. If the log
    // call sat inside the rerank `try`, a logger that throws would land in the
    // fail-safe `catch`: the good result discarded, the fused order returned,
    // and a `degraded: error` warning blaming the reranker for a logging fault.
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const warn = vi.fn();
    const logger: RetrieveLogger = {
      warn,
      info: () => {
        throw new Error('log sink down');
      },
    };
    const svc = new RetrieveService({
      db: makeDb(state),
      embedder: makeEmbedder(),
      reranker: makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 }),
      logger,
    });
    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true, topK: 3 },
      { org: ORG, project: PROJECT },
    );
    // The reranked order (beta, gamma, alpha), not the fused one (c1, c2, c3).
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2', 'c3', 'c1']);
    expect(out.chunks.every((c) => typeof c.rerankScore === 'number')).toBe(true);
    expect(out.legs).toContain('rerank');
    expect(warn.mock.calls.filter((c) => c[1] === RERANK_DEGRADED_MESSAGE)).toHaveLength(0);
  });

  it('FAILS SAFE to the fused order when the reranker throws (never 500s)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const warn = vi.fn();
    const logger: RetrieveLogger = { warn };
    const reranker = (async () => {
      throw new Error('rerank sibling down');
    }) as unknown as Reranker;
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker, logger });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );
    // Cosine order preserved, no rerankScore surfaced, and it did NOT throw.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c3']);
    expect(out.chunks.every((c) => c.rerankScore === undefined)).toBe(true);

    // TWO warnings, and they are not duplicates — they answer different
    // questions and the second is the one that generalises.
    //
    //   `rerank degraded…` — WHY it degraded, and WHICH of the four ways
    //                        (`timeout` / `error` / `unavailable` /
    //                        `backfilled`). Routed through
    //                        `ctx.onRerankDegraded` when a caller supplies one,
    //                        and logged here when nobody does.
    //   `retrieval leg…`   — THAT a leg contributed nothing. Fires for every
    //                        leg by the same name, so one grep finds every
    //                        silent leg across dense, lexical, sparse and
    //                        rerank.
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => c[1]);
    expect(messages).toContain(RERANK_DEGRADED_MESSAGE);
    expect(messages).toContain('retrieval leg returned zero rows');

    // And it NAMES the cause. A reranker that threw is an `error`; the budget
    // firing is a `timeout`. Different defects, different owners, so asserting
    // the reason is strictly stronger than asserting the message text.
    const degraded = warn.mock.calls.find((c) => c[1] === RERANK_DEGRADED_MESSAGE)?.[0] as
      | RerankDegradedWarning
      | undefined;
    expect(degraded?.reason).toBe('error');
    expect(degraded?.scored).toBe(0);
    expect(degraded?.detail).toBe('rerank sibling down');

    // And the degradation is on the RESPONSE, not only in the logs — a
    // consumer reading `legs` sees rerank is absent without access to stderr.
    expect(out.legs).not.toContain('rerank');
  });

  it('rerank is a NO-OP when no reranker is wired and the env gate is off', async () => {
    // No reranker injected ⇒ the real client is the default, and with
    // RERANK_ENABLED unset the request field degrades to a silent no-op: the
    // reranker is never consulted and the order is byte-identical to dense.
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c3']);
    expect(out.chunks.every((c) => c.rerankScore === undefined)).toBe(true);
    // Pool was NOT deepened (no-op path uses topK as the fetch limit).
    const flat = JSON.stringify(state.executeCalls[0]);
    expect(flat).toContain('LIMIT');
  });

  it('throws CorpusNotFoundError when (org, project, name) is missing', async () => {
    const state: DbState = { corpus: null, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const svc = new RetrieveService({ db, embedder: makeEmbedder() });
    await expect(
      svc.retrieve(
        { corpus: 'nope', query: 'q' },
        { org: ORG, project: PROJECT },
      ),
    ).rejects.toBeInstanceOf(CorpusNotFoundError);
    // A miss falls through to the ALIAS lookup, so this case is the one place
    // the old file touched `corpus_aliases` — and it could not see that the
    // query was scoped. Both reads must carry the caller's tenancy: an
    // unscoped alias lookup would resolve another tenant's alias and hand back
    // their corpus id. EVERY read of each table, not just one of them: on this
    // path there is exactly one of each and both are tenant-scoped.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectEveryQueryScopedTo('corpus_aliases', { org: ORG, project: PROJECT });
  });

  it('re-throws an embedder failure (does not swallow it)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const embedErr = new Error('upstream down');
    const svc = new RetrieveService({ db, embedder: makeEmbedder({ fail: embedErr }) });
    await expect(
      svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q' },
        { org: ORG, project: PROJECT },
      ),
    ).rejects.toBe(embedErr);
  });

  it('parses pgvector text embeddings off the DB for MMR (chars in, numbers out)', async () => {
    // Verifies the customType driver representation (`[1,2,3]` string) is
    // parsed to a number[] before we compute pairwise cosine. We construct
    // two candidates whose embeddings differ only by parse correctness.
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'A', metadata: null, score: 0.9, embedding: '[1,0,0]' },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'B', metadata: null, score: 0.5, embedding: '[0,1,0]' },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const svc = new RetrieveService({
      db,
      embedder: makeEmbedder({ vec: [1, 0, 0] }),
    });
    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', topK: 2, mmr: 0.5 },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
  });
});

// ---------------------------------------------------------------------------
// 🔴 Tenant scope of `lookupCorpus`
// ---------------------------------------------------------------------------
//
// `lookupCorpus` is the single door between a caller and a corpus. It has TWO
// tenant gates, not one:
//
//   1. the direct `corpora` read, `and(eq(org), eq(project), eq(name))`; and
//   2. when the name is not a corpus, the alias path — `and(eq(org),
//      eq(project), eq(name))` on `corpus_aliases`, followed by an INDEPENDENT
//      re-check `and(eq(org), eq(project), eq(id))` on the resolved target.
//
// Gate 2's re-check is the one worth spelling out: the alias row already told
// us the target id, so it is tempting to load the target by id alone. That
// would be a cross-tenant read the moment an alias ever pointed outside its own
// scope (a bad backfill, a restore, a future admin move). The cases below fail
// if ANY of those `eq(...org...)` / `eq(...project...)` terms is deleted.
// ---------------------------------------------------------------------------

describe('RetrieveService.retrieve — tenant scope of the corpus lookup', () => {
  it('🔴 the corpus lookup is scoped to (org, project) — not merely to the name', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve({ corpus: CORPUS_NAME, query: 'q' }, { org: ORG, project: PROJECT });

    const lookups = wheres.for('corpora');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    // Column by column, so dropping any ONE of the three is a distinct failure
    // rather than a single opaque "the SQL changed".
    expect(lookup.sql).toContain('"corpora"."org" =');
    expect(lookup.sql).toContain('"corpora"."project" =');
    expect(lookup.sql).toContain('"corpora"."name" =');
    // …and the values are the CALLER's scope, in that order. A predicate that
    // named the right columns but bound a constant, or another column, would
    // pass the checks above and fail here.
    expect(lookup.params).toEqual([ORG, PROJECT, CORPUS_NAME]);
    // Catches the OTHER mutation: not "the predicate lost a term" but "the
    // `.where()` call was deleted". That one reaches the recorder only because
    // the stub's terminals settle through `WhereRecorder.guard`.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();
  });

  it('🔴 the ALIAS lookup is scoped to (org, project) — an alias is per-tenant, not global', async () => {
    const state: DbState = {
      corpus: null, // the name is not a corpus…
      aliasRows: [{ targetCorpusId: CORPUS_ID }], // …it is an alias…
      aliasTarget: SEED_CORPUS, // …pointing at a corpus in the caller's scope.
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.9 },
      ],
      executeCalls: [],
    };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    const out = await svc.retrieve(
      { corpus: 'policies:latest', query: 'q' },
      { org: ORG, project: PROJECT },
    );
    // 🔴 FIRST, before anything flow-dependent. A deleted `.where()` anywhere on
    // this path changes which rows come back, so a chunk-order assertion would
    // fail first and blame the fixture. This one names the unfiltered query.
    wheres.expectNoUnfilteredQuery();

    // Proves the alias path actually RESOLVED. Without this the assertions
    // below could be inspecting a query that never mattered.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1']);

    const aliasLookups = wheres.for('corpus_aliases');
    expect(aliasLookups).toHaveLength(1);
    const alias = aliasLookups[0]!;
    expect(alias.sql).toContain('"corpus_aliases"."org" =');
    expect(alias.sql).toContain('"corpus_aliases"."project" =');
    expect(alias.sql).toContain('"corpus_aliases"."name" =');
    expect(alias.params).toEqual([ORG, PROJECT, 'policies:latest']);
    // Both `corpora` reads on this path (by-name miss, by-id target re-check)
    // carry the tuple, so nothing here needs the weaker "at least one" form.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectEveryQueryScopedTo('corpus_aliases', { org: ORG, project: PROJECT });
  });

  it('🔴 the alias TARGET is re-checked against (org, project) — resolving by id alone would cross tenants', async () => {
    const state: DbState = {
      corpus: null,
      aliasRows: [{ targetCorpusId: CORPUS_ID }],
      aliasTarget: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.9 },
      ],
      executeCalls: [],
    };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve({ corpus: 'policies:latest', query: 'q' }, { org: ORG, project: PROJECT });

    // 🔴 FIRST, before anything flow-dependent: names the unfiltered query
    // rather than letting a changed row set blame the fixture.
    wheres.expectNoUnfilteredQuery();

    // Two `corpora` reads happen here: the by-name miss, then the by-id target
    // re-check. BOTH must be tenant-scoped, and this says so outright — it is
    // the assertion that notices the re-check losing its tenant terms, and the
    // one that notices either `.where()` call being deleted outright.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectEveryQueryScopedTo('corpus_aliases', { org: ORG, project: PROJECT });

    // The filter below is NOT a workaround for a weak assertion (the two lines
    // above already cover every read). It picks the by-id re-check out so its
    // exact bound values can be named, which `expectEveryQueryScopedTo` does
    // not check: it verifies org+project, not that the third term is the
    // resolved target id.
    const byId = wheres
      .for('corpora')
      .filter((c) => c.sql.includes('"corpora"."id" ='));
    expect(
      byId,
      'the alias target was not re-read by id — either the alias path did not ' +
        'run, or the re-check lost its predicate entirely',
    ).toHaveLength(1);
    const target = byId[0]!;
    expect(target.sql).toContain('"corpora"."org" =');
    expect(target.sql).toContain('"corpora"."project" =');
    expect(target.params).toEqual([ORG, PROJECT, CORPUS_ID]);
    wheres.expectNoUnfilteredQuery();
  });
});
