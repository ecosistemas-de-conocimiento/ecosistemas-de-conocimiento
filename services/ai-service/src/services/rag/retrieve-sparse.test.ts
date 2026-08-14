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

import { describe, expect, it, vi } from 'vitest';

import type { SparseEmbedder } from '../ai/embeddings/sparse-embed.js';
import { RetrieveService, type Embedder } from './retrieve.js';

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

function makeDb(results: Array<Record<string, unknown>[]>) {
  const calls: Recorded[] = [];
  let i = 0;
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([SEED_CORPUS]) }) }),
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
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([SEED_CORPUS]) }) }),
      }),
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
