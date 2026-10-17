// Unit tests for the additive parts of `RetrieveService`: the `asOf` temporal
// predicate, `mode: 'hybrid'` fusion, and — most importantly — the guarantee
// that neither changes anything for a caller who does not pass them.
//
// The DB is stubbed at the `execute` boundary so the SQL text can be inspected.
// The point of asserting on emitted SQL is backward compatibility: a consumer
// pinned to the current contract must produce byte-identical queries, and the
// only way to know that is to look.
//
// 🔴 THE SAME REASONING NOW APPLIES TO THE CORPUS LOOKUP.
// Both legs of a hybrid retrieve are keyed by `corpus_id`, and that id comes
// from ONE `lookupCorpus` read carrying `and(eq(corpora.org, ctx.org),
// eq(corpora.project, ctx.project), eq(corpora.name, name))`. That predicate is
// the only thing standing between two tenants' corpora — and this file used to
// stub it away with `where: () => ({ limit: … })`, a function taking NO
// parameter. Every case below therefore agreed with any WHERE clause at all,
// INCLUDING NONE: delete the two tenant terms and both legs happily fan out
// over another org's chunks while the file stays green.
//
// `where()` now TAKES its predicate and records it (`from()` takes the table so
// the record is labelled), so a dropped `eq(...)` shows up as a missing column
// or a missing bound param.
//
// 🔴 AND THE MUTATION THAT DELETES THE `.where()` CALL, NOT ITS TERMS.
// Recording a predicate only sees a `where()` that RAN. Deleting the call left
// no record — and this stub disguised it further: `limit` lived only inside the
// `where()` result, so `selectCorpusColumns().limit(1)` threw
// `TypeError: this.selectCorpusColumns(...).limit is not a function`. Every
// case went red about the STUB's shape, naming no tenant leak. The `from()`
// result now carries its own guarded `limit`/`then` (see
// `WhereRecorder.guard`), so an unfiltered corpus lookup is recorded as
// `<NO PREDICATE>` and the scope assertions reject it by name.
//
// ⚠ A mock cannot PROVE isolation — it shows which predicate was BUILT, never
// that Postgres honoured it. The real proof is
// `src/routes/tenant-isolation.integration.test.ts`, against a live database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RetrieveService, type Embedder } from './retrieve.js';
import { WhereRecorder } from '../../test/where-recorder.js';

const ORG = 'org-1';
const PROJECT = 'proj-1';
const CORPUS_ID = '00000000-0000-4000-8000-000000000001';

const SEED_CORPUS = {
  id: CORPUS_ID,
  org: ORG,
  project: PROJECT,
  name: 'docs',
  embeddingModel: 'test/embed',
  embeddingDim: 1024,
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
  textSearchConfig: 'spanish',
};

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Flatten a drizzle `sql` template back into readable SQL text plus its bound
 * parameters. A drizzle query is a tree of nested `SQL` objects whose string
 * literals live in `queryChunks[].value[]` and whose everything-else is a bound
 * parameter — so walking it recursively is the only way to see the statement
 * that will actually be sent.
 */
function flattenSql(node: unknown, out: { text: string[]; params: unknown[] }): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const n of node) flattenSql(n, out);
    return;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o['value']) && o['value'].every((v) => typeof v === 'string')) {
      out.text.push((o['value'] as string[]).join(''));
      return;
    }
    if (Array.isArray(o['queryChunks'])) {
      flattenSql(o['queryChunks'], out);
      return;
    }
    return;
  }
  out.params.push(node);
}

/**
 * One recorder for the whole file, cleared in `beforeEach` so a test only ever
 * sees the predicates its OWN `retrieve()` call built.
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

/** Stub db: fixed corpus row, scripted `execute` results, recorded SQL. */
function makeDb(results: Array<Record<string, unknown>[]>) {
  const calls: Recorded[] = [];
  let i = 0;
  const db = {
    select: () => ({
      // 🔴 `from` TAKES the table and `where` TAKES the predicate — the two
      // parameters this stub used to throw away. Without them the corpus
      // lookup is invisible to every assertion in the file.
      from: (table: unknown) => {
        // ONE guard per `from()` — per chain instance — so `settle()` can tell
        // "this chain was filtered" from "this chain never was".
        const guard = wheres.guard(tableName(table));
        const rows = () => Promise.resolve(guard.settle([SEED_CORPUS]));
        return {
          where: (predicate: unknown) => {
            guard.where(predicate);
            return { limit: () => Promise.resolve(guard.settle([SEED_CORPUS])) };
          },
          // 🔴 The UNFILTERED terminals. `limit` is where the real mutation
          // lands (`selectCorpusColumns().limit(1)` once `.where()` is gone);
          // `then` covers an awaited chain that calls neither. Without these
          // two the deleted call is a TypeError about the stub, not a recorded
          // whole-table read.
          limit: rows,
          then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
            rows().then(resolve, reject),
        };
      },
    }),
    execute: vi.fn(async (q: unknown) => {
      const acc = { text: [] as string[], params: [] as unknown[] };
      flattenSql(q, acc);
      calls.push({ sql: acc.text.join(''), params: acc.params });
      return results[i++] ?? [];
    }),
  };
  return { db: db as unknown as import('../../db/client.js').Db, calls };
}

const embedder: Embedder = (async ({ model }: { model: string }) => ({
  embeddings: [[0.1, 0.2, 0.3]],
  model,
  usage: { inputTokens: 1, estimatedCostUsd: 0 },
})) as unknown as Embedder;

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    document_id: `doc-${id}`,
    ordinal: 0,
    text: `text ${id}`,
    metadata: null,
    score: 0.5,
    ...over,
  };
}

const ctx = { org: ORG, project: PROJECT };

describe('RetrieveService — asOf (temporal validity) predicate', () => {
  it('emits NO temporal clause when asOf is absent', async () => {
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toContain('valid_from');
    expect(calls[0]!.sql).not.toContain('valid_to');
  });

  it('emits a half-open interval predicate when asOf is present', async () => {
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', asOf: '2026-01-15T00:00:00Z' }, ctx);
    const sql = calls[0]!.sql;
    // NULL bounds must remain eligible — that is what makes the parameter
    // additive for every corpus that has never set a validity.
    expect(sql).toContain('valid_from" IS NULL');
    expect(sql).toContain('valid_to" IS NULL');
    expect(sql).toContain('<=');
    expect(sql).toContain('>');
    expect(calls[0]!.params).toContain('2026-01-15T00:00:00Z');
  });

  it('applies the temporal predicate to BOTH legs of a hybrid retrieve', async () => {
    // If it were applied to only one leg, a superseded chunk could enter the
    // candidate set through the other and be fused into the results.
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid', asOf: '2026-01-15T00:00:00Z' },
      ctx,
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.sql).toContain('valid_from');
  });

  it('applies the metadata filter to BOTH legs of a hybrid retrieve', async () => {
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', filter: { k: 'v' } }, ctx);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.sql).toContain('@>');
  });
});

describe('RetrieveService — dense mode is unchanged', () => {
  it('runs exactly one query and returns cosine scores as `score`', async () => {
    const { db, calls } = makeDb([[row('a', { score: 0.9 }), row('b', { score: 0.4 })]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', topK: 2 }, ctx);
    expect(calls).toHaveLength(1);
    expect(out.chunks.map((c) => c.score)).toEqual([0.9, 0.4]);
    // `denseScore` mirrors `score` in dense mode so consumers can read one
    // field regardless of mode.
    expect(out.chunks.map((c) => c.denseScore)).toEqual([0.9, 0.4]);
    // `ranks` is hybrid-only telemetry and must not appear.
    expect(out.chunks[0]!.ranks).toBeUndefined();
    expect(out.chunks[0]!.lexicalScore).toBeUndefined();
    // 🔴 Those chunks came out of a corpus resolved under the CALLER's tenancy,
    // not merely under its name. The old parameterless `where()` was blind to
    // this and would have accepted a bare `eq(corpora.name, …)`.
    //
    // EVERY read, not "at least one": this file reaches `corpora` exactly once
    // per retrieve and that read must be scoped, so the weaker form would only
    // let a second, unscoped lookup in unnoticed.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  it('does not touch the lexical index at all', async () => {
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(calls[0]!.sql).not.toContain('text_search');
    expect(calls[0]!.sql).not.toContain('tsquery');
  });
});

describe('RetrieveService — hybrid fusion', () => {
  it('ranks a chunk found by both legs above one found by a single leg', async () => {
    // dense: a, b   lexical: c, a  → `a` is the only chunk both legs agree on.
    const { db } = makeDb([
      [row('a', { score: 0.8 }), row('b', { score: 0.7 })],
      [row('c', { score: 0.9 }), row('a', { score: 0.6 })],
    ]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 3 }, ctx);
    expect(out.chunks[0]!.chunkId).toBe('a');
    expect(out.chunks[0]!.denseScore).toBe(0.8);
    expect(out.chunks[0]!.lexicalScore).toBe(0.6);
    expect(out.chunks[0]!.ranks).toEqual({ dense: 1, lexical: 2 });
  });

  it('surfaces a chunk the dense leg missed entirely', async () => {
    // The whole point of the lexical leg: an exact identifier the embedding
    // has no signal for still reaches the results.
    const { db } = makeDb([[row('a')], [row('exact', { score: 5 })]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'section 16', mode: 'hybrid' }, ctx);
    const ids = out.chunks.map((c) => c.chunkId);
    expect(ids).toContain('exact');
    const exact = out.chunks.find((c) => c.chunkId === 'exact')!;
    expect(exact.denseScore).toBeUndefined();
    expect(exact.lexicalScore).toBe(5);
  });

  it('credits a tie block at its LAST rank, so indecision earns nothing', async () => {
    // This reproduces, in miniature, the situation that decides an
    // exact-identifier query like "section 47" on a corpus of numbered
    // sections:
    //
    //   - the lexical leg ranks the ONE genuine hit first, then ties ~30
    //     chunks that merely contain the stem "section";
    //   - the dense leg is noise (the query has no topical content) and puts
    //     an irrelevant chunk first.
    //
    // Modified competition ranking credits the whole tie block at rank 31, so
    // `noise` collects 1/(60+31) from the lexical leg rather than 1/(60+2),
    // and `solo` — a genuine rank-1 hit with a mediocre dense rank — wins.
    // Under standard competition ranking (all ties at rank 2) `noise` wins,
    // which measured as a 19-point drop on the exact-identifier slice.
    const tieBlock = Array.from({ length: 30 }, (_, i) => row(`tie${i}`, { score: 0.1 }));
    tieBlock[9] = row('noise', { score: 0.1 });
    const denseRows = [
      row('noise', { score: 0.9 }),
      row('d1', { score: 0.88 }),
      row('d2', { score: 0.87 }),
      row('d3', { score: 0.86 }),
      row('solo', { score: 0.85 }),
    ];
    const { db } = makeDb([denseRows, [row('solo', { score: 1.0 }), ...tieBlock]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 5 }, ctx);

    expect(out.chunks[0]!.chunkId).toBe('solo');
    expect(out.chunks[0]!.ranks).toEqual({ dense: 5, lexical: 1 });
    // Every member of the tie block shares the block's LAST position (31).
    const noise = out.chunks.find((c) => c.chunkId === 'noise')!;
    expect(noise.ranks?.lexical).toBe(31);
  });

  it('is deterministic — identical inputs give identical output order', async () => {
    const build = () =>
      makeDb([
        [row('x', { score: 0.5 }), row('y', { score: 0.5 })],
        [row('y', { score: 0.2 }), row('x', { score: 0.2 })],
      ]);
    const runs: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const { db } = build();
      const svc = new RetrieveService({ db, embedder });
      const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 2 }, ctx);
      runs.push(out.chunks.map((c) => c.chunkId));
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it('honours a custom rrfK', async () => {
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid', rrfK: 1, topK: 2 },
      ctx,
    );
    // With k=1 a rank-1 hit scores 1/2; with the default k=60 it would be 1/61.
    expect(out.chunks[0]!.score).toBeCloseTo(0.5, 6);
  });

  it('degrades to the dense leg when the lexical leg returns nothing', async () => {
    // The un-backfilled-corpus case: chunks ingested before migration 0012
    // have a NULL tsvector and match no tsquery.
    const { db } = makeDb([[row('a'), row('b')], []]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 2 }, ctx);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 🔴 Tenant scope of the corpus lookup
// ---------------------------------------------------------------------------
//
// Hybrid retrieve fans out into TWO `execute` legs, both filtered only by
// `"corpus_id" = $1`. Neither leg carries an org or a project — they do not
// need to, PROVIDED the corpus id they share was resolved under the caller's
// tenancy. That makes `lookupCorpus` the whole tenant boundary for this file:
// one dropped `eq(...)` there and both legs read another tenant's chunks.
//
// This file never reaches the alias branch of `lookupCorpus` — the stub answers
// the direct by-name read with a row every time, so the `corpus_aliases` lookup
// and its target re-check are unreachable here. They are covered in
// `retrieve.test.ts`, which can drive the miss path.
// ---------------------------------------------------------------------------

describe('RetrieveService — tenant scope of the corpus lookup', () => {
  it('🔴 the corpus lookup is scoped to (org, project) — not merely to the name', async () => {
    const { db } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);

    const lookups = wheres.for('corpora');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    // Column by column, so a dropped term names itself rather than showing up
    // as one opaque "the SQL changed".
    expect(lookup.sql).toContain('"corpora"."org" =');
    expect(lookup.sql).toContain('"corpora"."project" =');
    expect(lookup.sql).toContain('"corpora"."name" =');
    // Bound to the CALLER's scope, in that order — a predicate naming the right
    // columns but binding a constant would pass the checks above.
    expect(lookup.params).toEqual([ORG, PROJECT, 'docs']);
    // Catches the other mutation — the `.where()` call DELETED rather than
    // emptied. It reaches the recorder only because the stub's terminals settle
    // through `WhereRecorder.guard`.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();
  });

  it('🔴 hybrid resolves the corpus ONCE, under tenancy — and BOTH legs re-fence', async () => {
    // ⚠ THIS CASE INVERTED, deliberately. It used to assert
    // `expect(c.sql).not.toContain('"org"')` — a tripwire whose comment said a
    // future edit adding an org filter should go red so someone re-read the
    // reasoning before deciding which guard was the real one. That happened:
    // the isolation review ruled that the corpus lookup alone is INHERITED
    // isolation, holding only because every caller passes `corpusRow.id` from
    // `lookupCorpus`. One future caller passing a raw id loses it silently.
    //
    // So both guards are now real, and both are asserted here. The lookup is
    // still the primary boundary — that is what the `corpora` assertions
    // below pin — and the chunk-layer predicate is defence in depth behind it.
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);

    // Two legs ran…
    expect(calls).toHaveLength(2);
    // …and BOTH carry the corpus id AND the tenant scope, bound to the caller.
    for (const c of calls) {
      expect(c.sql).toContain('"corpus_id" = ');
      expect(c.sql).toContain('"org" =');
      expect(c.sql).toContain('"project" =');
      expect(c.params).toContain(ORG);
      expect(c.params).toContain(PROJECT);
    }
    // …and the tenant-scoped lookup still happens exactly ONCE. A second,
    // unscoped corpus read added for the lexical leg would fail here.
    expect(wheres.for('corpora')).toHaveLength(1);
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();
  });
});
