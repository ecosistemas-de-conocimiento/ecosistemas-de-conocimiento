// Unit tests for the two things that make retrieval degradation VISIBLE:
// `legs` on the response, and the chunk-layer tenancy fence.
//
// ── Why `legs` exists ───────────────────────────────────────────────────────
// The rerank rung is fail-safe by design: `applyRerank` catches everything and
// returns the fused order. That is correct — a broken reranker must never fail
// a query — but it means a response from a DEAD reranker is byte-identical to
// a `rerank: false` response minus `rerankScore`. No status, no header, no
// field distinguished "rerank ran and agreed with the fused order" from
// "rerank is down". The same hole sits under the lexical legs: `lexicalScore`
// is the slot for BOTH the tsvector leg and the learned-sparse leg, and both
// were labelled `'lexical'`, so an empty sparse column looked exactly like a
// working full-text search that happened to match nothing.
//
// `legs` closes both. It names the legs that CONTRIBUTED rows — never the ones
// that were asked for — so every case below is written as a claim about what
// actually ran, not about what the request said.
//
// ⚠ The rerank case reads `rerankScore` off the RETURNED CHUNKS rather than a
// flag set inside `applyRerank`. That is deliberate and the tests pin it: a
// flag can drift from what the consumer received; the rows cannot.
//
// ── Why the fence tests assert SQL text ─────────────────────────────────────
// `chunks` carries its own NOT NULL `org` and `project`, but all four candidate
// queries filtered on `corpus_id` alone. Isolation was INHERITED from the
// scoped corpus lookup rather than ENFORCED where the rows are read — it held
// only because every caller passes `corpusRow.id` from `lookupCorpus`. These
// tests are what stops a future caller passing a raw corpus id from silently
// losing the fence, so they assert on the statement that will actually be
// sent, per this directory's existing convention.
//
// ⚠ A stub cannot PROVE isolation — it shows which predicate was BUILT, never
// that Postgres honoured it. The live proof is
// `src/routes/tenant-isolation.integration.test.ts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RetrieveService,
  SILENT_LEG_MESSAGE,
  type Embedder,
  type SilentLegWarning,
} from './retrieve.js';
import type { Reranker } from '../ai/rerank/rerank-client.js';
import type { SparseEmbedder } from '../ai/embeddings/sparse-embed.js';
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

/** Flatten a drizzle `sql` template into its text plus bound parameters. */
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

const wheres = new WhereRecorder();
beforeEach(() => {
  wheres.reset();
});

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
      from: (table: unknown) => {
        const guard = wheres.guard(tableName(table));
        const rows = () => Promise.resolve(guard.settle([SEED_CORPUS]));
        return {
          where: (predicate: unknown) => {
            guard.where(predicate);
            return { limit: () => Promise.resolve(guard.settle([SEED_CORPUS])) };
          },
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

const sparseEmbedder: SparseEmbedder = async ({ model }) => ({
  model,
  dense: [[0.1, 0.2, 0.3]],
  sparse: [{ indices: [4, 15], values: [0.9, 0.5] }],
});

/** A reranker that scores every document, highest index first. */
const workingReranker: Reranker = (async ({
  documents,
}: {
  documents: string[];
}) => ({
  results: documents.map((_d, index) => ({ index, relevanceScore: 1 - index * 0.1 })),
})) as unknown as Reranker;

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

/** Captures the zero-row warnings so a test can name the leg that was silent. */
function makeLogger() {
  const warn = vi.fn();
  return {
    logger: { warn },
    /** Leg names carried by every `retrieval leg returned zero rows` warning. */
    silentLegs(): string[] {
      return warn.mock.calls
        .filter((c) => c[1] === 'retrieval leg returned zero rows')
        .map((c) => (c[0] as { leg: string }).leg);
    },
  };
}

const ctx = { org: ORG, project: PROJECT };

describe('RetrieveService — `legs` reports the legs that CONTRIBUTED rows', () => {
  it('dense mode names exactly the dense leg', async () => {
    const { db } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(out.legs).toEqual(['dense']);
  });

  it('names NO leg when the only leg came back empty, and warns naming it', async () => {
    // An empty corpus, a filter that matches nothing, an `asOf` before any
    // content existed — all reach here. The old response was `{chunks: []}`
    // with nothing to say whether retrieval had run at all.
    const { logger, silentLegs } = makeLogger();
    const { db } = makeDb([[]]);
    const svc = new RetrieveService({ db, embedder, logger });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(out.legs).toEqual([]);
    expect(silentLegs()).toEqual(['dense']);
  });

  it('hybrid over tsvector names the lexical leg', async () => {
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(out.legs).toEqual(['dense', 'lexical']);
  });

  it('🔴 hybrid over the SPARSE leg names it `sparse`, not `lexical`', async () => {
    // THE naming split. Both legs still fill `lexicalScore` — that slot is the
    // wire contract and renaming it would break every consumer for no gain —
    // so `legs` is the only thing in the response that can tell a caller which
    // of the two lexical legs produced the score it is reading.
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(out.legs).toEqual(['dense', 'sparse']);
    // The score slot is unchanged — this is what makes `legs` necessary.
    expect(out.chunks.some((c) => c.lexicalScore !== undefined)).toBe(true);
  });

  it('🔴 an EMPTY sparse column is reported as a silent `sparse` leg', async () => {
    // The half-populated-corpus case, at unit scale. `sparseSearch` filters
    // `sparse_embedding IS NOT NULL`, so on a corpus ingested before the
    // sparse embedder was switched on it returns nothing at all — and NULL
    // rows are filtered in SQL, so nothing throws and nothing logged. The
    // response was indistinguishable from a dense-only retrieve.
    const { logger, silentLegs } = makeLogger();
    const { db } = makeDb([[row('a')], []]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder, logger });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(out.legs).toEqual(['dense']);
    // Named as `sparse`. Under the old label this warning would have accused
    // the tsvector leg, which was never asked to run.
    expect(silentLegs()).toEqual(['sparse']);
  });

  it('an empty tsvector leg is reported as `lexical`, not `sparse`', async () => {
    const { logger, silentLegs } = makeLogger();
    const { db } = makeDb([[row('a')], []]);
    const svc = new RetrieveService({ db, embedder, logger });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(out.legs).toEqual(['dense']);
    expect(silentLegs()).toEqual(['lexical']);
  });

  it('names `rerank` when the cross-encoder actually scored rows', async () => {
    const { db } = makeDb([[row('a'), row('b')]]);
    const svc = new RetrieveService({ db, embedder, reranker: workingReranker });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true, topK: 2 }, ctx);
    expect(out.legs).toContain('rerank');
    expect(out.chunks[0]!.rerankScore).toBeDefined();
  });

  it('🔴 OMITS `rerank` when the reranker is down — the response otherwise looks identical', async () => {
    // This is the assertion the deploy canary is built on. `applyRerank` fails
    // safe: on a throw it returns the fused order, producing a 200 that is
    // byte-identical to `rerank: false` minus `rerankScore`. Before `legs`,
    // presence of `rerankScore` was the strongest claim available; now the
    // absence of the leg says it outright.
    const { logger, silentLegs } = makeLogger();
    const down: Reranker = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as Reranker;
    const { db } = makeDb([[row('a'), row('b')]]);
    const svc = new RetrieveService({ db, embedder, reranker: down, logger });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true, topK: 2 }, ctx);

    expect(out.legs).not.toContain('rerank');
    expect(out.legs).toEqual(['dense']);
    // The rows still come back — failing safe is the contract, and `legs` is
    // what stops that being silent.
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks.every((c) => c.rerankScore === undefined)).toBe(true);
    expect(silentLegs()).toContain('rerank');
  });

  it('never names `rerank` on a request that did not ask for it', async () => {
    const { logger, silentLegs } = makeLogger();
    const { db } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder, reranker: workingReranker, logger });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(out.legs).toEqual(['dense']);
    // A leg that was never attempted is not a silent leg — warning about it
    // would train us to ignore the warning.
    expect(silentLegs()).toEqual([]);
  });

  it('reports legs in a stable order — dense, lexical leg, rerank', async () => {
    // A consumer diffing `legs` between two requests should see a SET change,
    // never a shuffle.
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({
      db,
      embedder,
      sparseEmbedder,
      reranker: workingReranker,
    });
    const out = await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid', rerank: true, topK: 2 },
      ctx,
    );
    expect(out.legs).toEqual(['dense', 'sparse', 'rerank']);
  });
});

describe('🔴 chunk-layer tenancy fence — every candidate query scopes to (org, project)', () => {
  /** Assert one recorded statement fences on both scoping columns, bound. */
  function expectFenced(call: Recorded) {
    expect(call.sql).toContain('"org" =');
    expect(call.sql).toContain('"project" =');
    expect(call.params).toContain(ORG);
    expect(call.params).toContain(PROJECT);
  }

  it('the dense leg fences', async () => {
    const { db, calls } = makeDb([[row('a')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);
    expect(calls).toHaveLength(1);
    expectFenced(calls[0]!);
  });

  it('the dense leg fences on the MMR path too', async () => {
    // `vectorSearch` has TWO statements — one with the embedding column and one
    // without — and only the `includeEmbedding` branch runs under MMR. A fence
    // added to one branch and not the other is the exact shape of bug this
    // case exists to catch.
    const { db, calls } = makeDb([[row('a', { embedding: '[0.1,0.2,0.3]' })]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mmr: 0.5 }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('"embedding"::text');
    expectFenced(calls[0]!);
  });

  it('the tsvector lexical leg fences', async () => {
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain('text_search');
    expectFenced(calls[1]!);
  });

  it('the sparse lexical leg fences', async () => {
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder, sparseEmbedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain('sparse_embedding');
    expectFenced(calls[1]!);
  });

  it('keeps the corpus_id predicate — the fence is defence in depth, not a replacement', async () => {
    // The fence is redundant while every caller passes `corpusRow.id`. Dropping
    // `corpus_id` in favour of (org, project) would fan a retrieve out across
    // every corpus the tenant owns, which is a much worse bug than the one
    // being fixed.
    const { db, calls } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });
    await svc.retrieve({ corpus: 'docs', query: 'q', mode: 'hybrid' }, ctx);
    for (const call of calls) {
      expect(call.sql).toContain('"corpus_id" =');
      expect(call.params).toContain(CORPUS_ID);
    }
  });
});

// ── `ctx.onSilentLeg` — WHERE the silent-leg signal goes ────────────────────
//
// "A leg came back empty" means different things on different routes. On
// `/v1/retrieve` it is the point: one corpus was asked one question and a leg
// had nothing to say. On `/v1/retrieve/multi` a corpus matching nothing is
// routine and already reported as `{ corpus, matched: 0 }`, so a five-corpus
// fan-out would log three of these per ordinary request — and a warning that
// fires on ordinary traffic is a warning nobody reads.
//
// So `retrieve` does not decide. It hands the warning to `ctx.onSilentLeg` when
// the caller supplied one, and logs it itself when nobody did. These cases pin
// BOTH halves, plus the one that actually matters: the hook takes the
// silent-leg signal and NOTHING ELSE. The multi-corpus half of the contract —
// what the fan-out does with what it collects — is in `retrieve-multi.test.ts`.

describe('RetrieveService — ctx.onSilentLeg redirects the silent-leg signal', () => {
  it('logs the warning itself when no hook is supplied (every caller but /multi)', async () => {
    const warn = vi.fn();
    const { db } = makeDb([[]]);
    const svc = new RetrieveService({ db, embedder, logger: { warn } });

    await svc.retrieve({ corpus: 'docs', query: 'q' }, ctx);

    // Full payload asserted, not just the leg name: this object is what a
    // deferring caller replays verbatim, so its shape is part of the contract.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        leg: 'dense',
        corpus: 'docs',
        corpusId: CORPUS_ID,
        mode: 'dense',
        org: ORG,
        project: PROJECT,
      },
      SILENT_LEG_MESSAGE,
    );
  });

  it('hands the warning to the hook INSTEAD of logging it', async () => {
    const warn = vi.fn();
    const seen: SilentLegWarning[] = [];
    const { db } = makeDb([[], []]);
    const svc = new RetrieveService({ db, embedder, logger: { warn } });

    const out = await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid' },
      { ...ctx, onSilentLeg: (w) => seen.push(w) },
    );

    // Both legs empty ⇒ two warnings, all of them to the hook, none logged.
    expect(out.legs).toEqual([]);
    expect(seen.map((w) => w.leg)).toEqual(['dense', 'lexical']);
    expect(seen.every((w) => w.mode === 'hybrid' && w.corpusId === CORPUS_ID)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never routes any OTHER warning through the hook', async () => {
    // A sparse embedder that throws degrades hybrid to dense-only. That raises
    // TWO different warnings: `sparse leg failed…` (why it degraded) and the
    // silent-leg signal for the sparse leg (that it contributed nothing). Only
    // the second belongs to the hook — a hook that swallowed the first would
    // mute a real fault on `/multi`, which is exactly the silence this lane
    // exists to remove.
    const warn = vi.fn();
    const seen: SilentLegWarning[] = [];
    const { db } = makeDb([[row('a')]]);
    const exploding: SparseEmbedder = async () => {
      throw new Error('sparsevec down');
    };
    const svc = new RetrieveService({
      db,
      embedder,
      sparseEmbedder: exploding,
      logger: { warn },
    });

    const out = await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid' },
      { ...ctx, onSilentLeg: (w) => seen.push(w) },
    );

    expect(out.legs).toEqual(['dense']);
    expect(seen.map((w) => w.leg)).toEqual(['sparse']);
    // The degrade warn is still LOGGED, and it is the only thing logged.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain('degrading hybrid to dense-only');
  });

  it('never calls the hook when every leg returned rows', async () => {
    const seen: SilentLegWarning[] = [];
    const { db } = makeDb([[row('a')], [row('b')]]);
    const svc = new RetrieveService({ db, embedder });

    const out = await svc.retrieve(
      { corpus: 'docs', query: 'q', mode: 'hybrid' },
      { ...ctx, onSilentLeg: (w) => seen.push(w) },
    );

    expect(out.legs).toEqual(['dense', 'lexical']);
    expect(seen).toEqual([]);
  });
});
