// Unit tests for the learned-sparse (bge-m3) lexical leg of a hybrid retrieve.
//
// The sparse leg is the OPT-IN alternative to the `tsvector` leg: when a sparse
// embedder is injected (which also forces sparse availability, bypassing the
// SPARSE_ENABLED env gate), `mode: 'hybrid'` fuses the dense leg with the sparse
// leg instead of the `tsvector` leg. These tests assert the emitted SQL, that
// the response shape is unchanged (sparse score surfaces as `lexicalScore`), the
// fail-safe degradation, and — critically — that WITHOUT injection the tsvector
// leg is byte-identical to before (the gate is off by default).
//
// The DB is stubbed at the `execute` boundary so the SQL text can be inspected.
//
// 🔴 THE CORPUS LOOKUP IS STUBBED TOO — AND USED TO BE INVISIBLE.
// The sparse leg is filtered by nothing but `"corpus_id" = $1`, exactly like the
// dense and tsvector legs. What keeps that from reading another tenant's chunks
// is the ONE `lookupCorpus` read that resolved the id, carrying
// `and(eq(corpora.org, ctx.org), eq(corpora.project, ctx.project),
// eq(corpora.name, name))`. This file stubbed that read as
// `where: () => ({ limit: … })` — a function taking NO parameter — so the
// predicate was DISCARDED at the door and every case agreed with any WHERE
// clause at all, INCLUDING NONE.
//
// `where()` now TAKES its predicate and records it (`from()` takes the table so
// the record is labelled), in BOTH stub sites in this file. A dropped `eq(...)`
// term surfaces as a missing column or a missing bound param.
//
// 🔴 AND THE MUTATION THAT DELETES THE `.where()` CALL, NOT ITS TERMS.
// Recording a predicate only sees a `where()` that RAN. Deleting the call
// reached no recorder — and this stub disguised it further: `limit` lived only
// inside the `where()` result, so `selectCorpusColumns().limit(1)` threw
// `TypeError: this.selectCorpusColumns(...).limit is not a function`. The file
// went red about the STUB's shape, naming no tenant leak, which invites the
// next person to re-shape the stub and ship the dropped filter. The `from()`
// result now carries its own guarded `limit`/`then` (see
// `WhereRecorder.guard`), so an unfiltered corpus lookup is recorded as
// `<NO PREDICATE>` and the scope assertions reject it by name.
//
// ⚠ A mock cannot PROVE isolation — it shows which predicate was BUILT, never
// that Postgres honoured it. The real proof is
// `src/routes/tenant-isolation.integration.test.ts`, against a live database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SparseEmbedder } from '../ai/embeddings/sparse-embed.js';
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

/**
 * The `select().from(corpora).where(p).limit(1)` corpus lookup, recording.
 *
 * Shared by BOTH stub sites in this file so neither can quietly regress to a
 * parameterless `where()` — nor to a `where()`-less chain, which is the other
 * half of the same defect.
 */
function recordingSelect() {
  return () => ({
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
        // 🔴 The UNFILTERED terminals. `limit` is where the real mutation lands
        // (`selectCorpusColumns().limit(1)` once `.where()` is gone); `then`
        // covers an awaited chain that calls neither. Without these two, a
        // deleted `.where()` is a TypeError about the stub rather than a
        // recorded whole-table read.
        limit: rows,
        then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
          rows().then(resolve, reject),
      };
    },
  });
}

function makeDb(results: Array<Record<string, unknown>[]>) {
  const calls: Recorded[] = [];
  let i = 0;
  const db = {
    select: recordingSelect(),
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

/** A sparse embedder stub — one sparse vector for the query. */
const sparseEmbedder: SparseEmbedder = async ({ model }) => ({
  model,
  dense: [[0.1, 0.2, 0.3]],
  sparse: [{ indices: [4, 15], values: [0.9, 0.5] }],
});

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

describe('RetrieveService — sparse lexical leg (opt-in)', () => {
  it('replaces the tsvector leg with a sparsevec max-inner-product leg when a sparse embedder is injected', async () => {
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    await svc.retrieve({ corpus: 'docs', query: 'section 16', mode: 'hybrid' }, ctx);

    expect(calls).toHaveLength(2);
    const denseSql = calls[0]!.sql;
    const lexicalSql = calls[1]!.sql;

    // Dense leg is unchanged — cosine `<=>`.
    expect(denseSql).toContain('<=>');

    // Lexical leg is now the SPARSE leg: sparsevec max-inner-product, NULL-guarded.
    expect(lexicalSql).toContain('sparse_embedding');
    expect(lexicalSql).toContain('<#>');
    expect(lexicalSql).toContain('::sparsevec');
    expect(lexicalSql).toContain('IS NOT NULL');
    // And it must NOT touch the tsvector machinery at all.
    expect(lexicalSql).not.toContain('text_search');
    expect(lexicalSql).not.toContain('tsquery');
    expect(lexicalSql).not.toContain('regconfig');

    // The bound sparsevec literal carries the 1-based, sorted query vector.
    expect(calls[1]!.params).toContain('{5:0.9,16:0.5}/250002');

    // 🔴 Both legs read `chunks` by corpus id alone. What makes that safe is the
    // corpus lookup that produced the id — and it ran under the CALLER's
    // tenancy. The old parameterless `where()` could not see this at all.
    //
    // EVERY read, not "at least one": this file reaches `corpora` exactly once
    // per retrieve and that read must be scoped, so the weaker form would only
    // let a second, unscoped lookup in unnoticed.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  it('surfaces the sparse inner-product score as lexicalScore, fused via RRF', async () => {
    // dense: a, b   sparse(lexical): a  → `a` is found by both legs.
    const { db } = makeDb([
      [row('a', { score: 0.8 }), row('b', { score: 0.7 })],
      [row('a', { score: 3.2 })],
    ]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 3 }, ctx);

    const a = out.chunks.find((c) => c.chunkId === 'a')!;
    expect(a.denseScore).toBe(0.8);
    // Inner-product score flows through the same `lexicalScore` field the
    // tsvector leg used — response shape is unchanged.
    expect(a.lexicalScore).toBe(3.2);
    expect(a.ranks).toEqual({ dense: 1, lexical: 1 });
  });

  it('FAILS SAFE to dense-only when the sparse embedder throws (no extra query)', async () => {
    const throwing: SparseEmbedder = async () => {
      throw new Error('bge-m3 sibling down');
    };
    const { db, calls } = makeDb([[row('a'), row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder: throwing });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 2 }, ctx);
    // Only the dense leg ran; the sparse leg degraded to [] before any SQL.
    expect(calls).toHaveLength(1);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });

  it('FAILS SAFE to dense-only when the sparsevec DB query itself errors (dim drift / timeout)', async () => {
    // MED #2: the query embed SUCCEEDS but the DB-side sparsevec query throws
    // (e.g. a SPARSE_DIM/column-width mismatch or a statement timeout). Because
    // `sparseSearch` runs inside a `Promise.all` with the dense leg, a bare throw
    // would reject the WHOLE hybrid retrieve (500). The extended catch must swallow
    // it and degrade to dense-only instead.
    const denseRows = [row('a'), row('b')];
    const db = {
      select: recordingSelect(),
      execute: vi.fn(async (q: unknown) => {
        const acc = { text: [] as string[], params: [] as unknown[] };
        flattenSql(q, acc);
        if (acc.text.join('').includes('sparse_embedding')) {
          throw new Error('sparsevec: different sparsevec dimensions 250002 and 300000');
        }
        return denseRows;
      }),
    } as unknown as import('../../db/client.js').Db;

    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    // Resolves (does NOT throw) with the dense candidates only.
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid', topK: 2 }, ctx);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['a', 'b']);
    // This case builds its own `db` literal rather than using `makeDb`. Assert
    // here too, so that second stub site cannot regress to a parameterless
    // `where()` — or to a `where()`-less chain — and quietly stop seeing the
    // tenant predicate.
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
  });

  it('degrades to dense-only when the query has an empty sparse vector', async () => {
    const emptySparse: SparseEmbedder = async ({ model }) => ({
      model,
      dense: [[0.1]],
      sparse: [{ indices: [], values: [] }],
    });
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder: emptySparse });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    // `{}/dim` short-circuits — no sparse SQL emitted.
    expect(calls).toHaveLength(1);
  });

  it('WITHOUT an injected sparse embedder, hybrid still uses the tsvector leg (gate off by default)', async () => {
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder }); // no sparseEmbedder
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(calls).toHaveLength(2);
    // The lexical leg is the tsvector leg — unchanged from before this feature.
    expect(calls[1]!.sql).toContain('text_search');
    expect(calls[1]!.sql).toContain('tsquery');
    expect(calls[1]!.sql).not.toContain('sparse_embedding');
  });

  it('dense mode never touches the sparse column even with an injected embedder', async () => {
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toContain('sparse_embedding');
  });
});

// ---------------------------------------------------------------------------
// 🔴 Tenant scope of the corpus lookup
// ---------------------------------------------------------------------------
//
// The sparse leg widens what a leaked corpus id costs: `sparse_embedding` rows
// carry the same chunk text as the dense index, and the leg's only filter is
// `"corpus_id" = $1`. So the tenant boundary for this whole feature is one
// `lookupCorpus` read. Delete either tenant term from it and the sparse leg
// happily scans another org's corpus — which is precisely what this file could
// not see before.
//
// This file never reaches the alias branch of `lookupCorpus`: the stub answers
// the direct by-name read with a row every time, so `corpus_aliases` and its
// target re-check are unreachable here. They are covered in `retrieve.test.ts`,
// which can drive the miss path.
// ---------------------------------------------------------------------------

describe('RetrieveService — tenant scope of the corpus lookup (sparse)', () => {
  it('🔴 the corpus lookup is scoped to (org, project) — not merely to the name', async () => {
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);

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

  it('🔴 the sparse leg carries its OWN tenant term as well as the corpus id', async () => {
    // ⚠ THIS CASE INVERTED, deliberately — it was the tripwire, and it fired.
    // It used to assert `not.toContain('"org"')` and said in its own comment
    // that adding an org filter should go red so someone re-read the reasoning
    // and decided which guard was the real one. The isolation review decided:
    // BOTH are. The corpus lookup stays the primary boundary; the chunk-layer
    // predicate stops a future caller that passes a raw corpus id — rather
    // than `corpusRow.id` from the scoped `lookupCorpus` — from losing tenancy
    // with nothing to fail.
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);

    const lexicalSql = calls[1]!.sql;
    expect(lexicalSql).toContain('sparse_embedding');
    expect(lexicalSql).toContain('"corpus_id" = ');
    expect(lexicalSql).toContain('"org" =');
    expect(lexicalSql).toContain('"project" =');
    // Bound to the CALLER's scope — a predicate naming the columns but binding
    // a constant would pass the checks above.
    expect(calls[1]!.params).toContain(ORG);
    expect(calls[1]!.params).toContain(PROJECT);
    // The lookup is still the primary boundary, and still happens once.
    expect(wheres.for('corpora')).toHaveLength(1);
    wheres.expectEveryQueryScopedTo('corpora', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();
  });
});
