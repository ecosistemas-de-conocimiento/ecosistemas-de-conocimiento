// Unit tests for processIngestJob.
//
// Pattern matches generation.worker.test.ts: a tiny stub `db` with chainable
// `select / insert / update / delete`, recording writes for assertion. The
// embedder is a `vi.fn()`; the chunker runs for real (it's deterministic and
// tiny).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client.js';
import {
  chunks as chunksTable,
  corpora as corporaTable,
  documents as documentsTable,
  ingestRequests as ingestRequestsTable,
  usageLogs as usageLogsTable,
} from '../db/schema/index.js';
import type { IngestJobData } from '../queue/queues.js';
import type {
  SparseEmbedResult,
  SparseVector,
} from '../services/ai/embeddings/sparse-embed.js';

import { processIngestJob } from './ingest.worker.js';

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

interface StubCorpus {
  id: string;
  org: string;
  project: string;
  name: string;
  embeddingModel: string;
  embeddingDim: number;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  chunkConfig?: unknown;
  textSearchConfig: string;
}

interface StubDocument {
  id: string;
  corpusId: string;
  org: string;
  project: string;
  externalId: string | null;
  text: string;
  title: string | null;
  sourceUrl: string | null;
  metadata: Record<string, unknown> | null;
  ingestId: string;
  updatedAt?: Date;
}

interface StubChunk {
  documentId: string;
  corpusId: string;
  org: string;
  project: string;
  ordinal: number;
  text: string;
  tokens: number;
  embedding: number[];
  /** Merged consumer doc metadata + chunker-derived section ids. */
  metadata: Record<string, unknown> | null;
}

interface StubUsage {
  org: string;
  project: string;
  provider: string;
  model: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string;
  actualCostUsd: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

interface StubState {
  corpora: StubCorpus[];
  documents: StubDocument[];
  chunks: StubChunk[];
  usageLogs: StubUsage[];
  /** Records every UPDATE (table + set) for assertion. */
  updates: Array<{ table: string; set: Record<string, unknown> }>;
  /** Records every DELETE (table) for assertion. */
  deletes: Array<{ table: string }>;
  /** Records every raw `db.execute(...)` — the tsvector build + sparse UPDATE. */
  executes: unknown[];
  /** Sequence for auto-generated doc IDs (so tests are deterministic). */
  docIdSeq: number;
  /**
   * When set, `db.execute(...)` REJECTS for any statement whose flattened SQL
   * contains this substring — used to simulate a sparse-write failure and prove
   * the whole document transaction rolls back (no half-index).
   */
  failExecuteMatching?: string;
}

function makeState(): StubState {
  return {
    corpora: [],
    documents: [],
    chunks: [],
    usageLogs: [],
    updates: [],
    deletes: [],
    executes: [],
    docIdSeq: 0,
  };
}

function makeDb(state: StubState): Db {
  const stub: Record<string, unknown> = {
    select(_cols?: unknown) {
      let table: unknown = null;
      let predicateColRefs: unknown[] = [];
      return {
        from(t: unknown) {
          table = t;
          const chain: Record<string, unknown> = {
            where(...args: unknown[]) {
              predicateColRefs = args;
              return chain;
            },
            limit(_n: number) {
              return Promise.resolve(rowsFor());
            },
            then(resolve: (v: unknown[]) => void) {
              Promise.resolve(rowsFor()).then(resolve);
            },
          };
          return chain;

          function rowsFor(): unknown[] {
            void predicateColRefs;
            if (table === corporaTable) return state.corpora;
            if (table === documentsTable) return state.documents;
            if (table === chunksTable) return state.chunks;
            return [];
          }
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown> | Record<string, unknown>[]) {
          const list = Array.isArray(values) ? values : [values];
          if (table === documentsTable) {
            const inserted: StubDocument[] = [];
            for (const v of list) {
              const id = `doc-${++state.docIdSeq}`;
              const row: StubDocument = {
                id,
                corpusId: v.corpusId as string,
                org: v.org as string,
                project: v.project as string,
                externalId: (v.externalId ?? null) as string | null,
                text: v.text as string,
                title: (v.title ?? null) as string | null,
                sourceUrl: (v.sourceUrl ?? null) as string | null,
                metadata: (v.metadata ?? null) as Record<string, unknown> | null,
                ingestId: v.ingestId as string,
              };
              state.documents.push(row);
              inserted.push(row);
            }
            return {
              returning(_cols: unknown) {
                return Promise.resolve(inserted.map((r) => ({ id: r.id })));
              },
            };
          }
          if (table === chunksTable) {
            for (const v of list) {
              state.chunks.push({
                documentId: v.documentId as string,
                corpusId: v.corpusId as string,
                org: v.org as string,
                project: v.project as string,
                ordinal: v.ordinal as number,
                text: v.text as string,
                tokens: v.tokens as number,
                embedding: v.embedding as number[],
                metadata: (v.metadata ?? null) as Record<string, unknown> | null,
              });
            }
            const out = {
              returning() {
                return Promise.resolve(list.map(() => ({ id: 'chunk' })));
              },
              then(resolve: (v: unknown) => void) {
                resolve(undefined);
              },
            };
            return out;
          }
          if (table === usageLogsTable) {
            for (const v of list) {
              state.usageLogs.push({
                org: v.org as string,
                project: v.project as string,
                provider: v.provider as string,
                model: v.model as string,
                endpoint: v.endpoint as string,
                inputTokens: v.inputTokens as number,
                outputTokens: v.outputTokens as number,
                estimatedCostUsd: v.estimatedCostUsd as string,
                actualCostUsd: v.actualCostUsd as string,
                status: v.status as string,
                metadata: (v.metadata ?? null) as Record<string, unknown> | null,
              });
            }
            return {
              returning() {
                return Promise.resolve(list.map(() => ({ id: 'usage' })));
              },
              then(resolve: (v: unknown) => void) {
                resolve(undefined);
              },
            };
          }
          return {
            returning() {
              return Promise.resolve([]);
            },
            then(resolve: (v: unknown) => void) {
              resolve(undefined);
            },
          };
        },
      };
    },
    update(table: unknown) {
      const which =
        table === documentsTable
          ? 'documents'
          : table === ingestRequestsTable
            ? 'ingest_requests'
            : 'other';
      return {
        set(values: Record<string, unknown>) {
          state.updates.push({ table: which, set: { ...values } });
          return {
            where() {
              if (which === 'documents') {
                // Apply to the first doc row (tests put exactly one row).
                if (state.documents[0]) {
                  state.documents[0] = {
                    ...state.documents[0],
                    text: (values.text as string) ?? state.documents[0].text,
                    title: (values.title as string | null) ?? state.documents[0].title,
                    sourceUrl:
                      (values.sourceUrl as string | null) ?? state.documents[0].sourceUrl,
                    metadata:
                      (values.metadata as Record<string, unknown> | null) ?? state.documents[0].metadata,
                    ingestId: (values.ingestId as string) ?? state.documents[0].ingestId,
                    updatedAt: (values.updatedAt as Date) ?? state.documents[0].updatedAt,
                  };
                }
              }
              const result = Promise.resolve();
              return Object.assign(result, {
                returning() {
                  // Mock ingest_requests.update().set(...).where(...).returning(...)
                  // — return a snapshot suitable for the callback contract bookkeeping.
                  // No callbackUrl on the stub ⇒ enqueueCallback is skipped.
                  if (which === 'ingest_requests') {
                    return Promise.resolve([
                      {
                        callbackUrl: null,
                        apiKeyId: null,
                        corpus: 'test-corpus',
                        totalDocs: 1,
                        completedDocs: 1,
                        failedDocs: 0,
                        status: 'running',
                      },
                    ]);
                  }
                  return Promise.resolve([]);
                },
              });
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const which = table === chunksTable ? 'chunks' : 'other';
      return {
        where() {
          state.deletes.push({ table: which });
          if (which === 'chunks') {
            state.chunks = [];
          }
          return Promise.resolve();
        },
      };
    },
    /**
     * Raw-SQL escape hatch. The worker uses it for the one statement that
     * cannot go through the query builder: building `chunks.text_search` with
     * `to_tsvector(<corpus config>::regconfig, text)`. The stub just records
     * the call so a test can assert the lexical index was populated — there is
     * no tsvector engine here, and pretending otherwise would be testing a
     * reimplementation rather than Postgres.
     */
    execute(query: unknown) {
      state.executes.push(query);
      if (state.failExecuteMatching && executeSqlText(query).includes(state.failExecuteMatching)) {
        return Promise.reject(new Error(`simulated execute failure (${state.failExecuteMatching})`));
      }
      return Promise.resolve([]);
    },
    /**
     * Minimal transaction shim. Runs `fn` against the SAME stub (so every
     * insert/update/delete/execute recording still lands in `state`), and on a
     * throw RESTORES the pre-call snapshot — modelling a real ROLLBACK. This is
     * what lets a test prove the atomicity fix: a sparse-write failure must
     * leave ZERO rows, not a half-indexed dense-only doc.
     */
    transaction(fn: (tx: unknown) => unknown) {
      const snap = {
        documents: [...state.documents],
        chunks: [...state.chunks],
        usageLogs: [...state.usageLogs],
        updates: [...state.updates],
        deletes: [...state.deletes],
        executes: [...state.executes],
        docIdSeq: state.docIdSeq,
      };
      return Promise.resolve()
        .then(() => fn(stub))
        .catch((err: unknown) => {
          state.documents = snap.documents;
          state.chunks = snap.chunks;
          state.usageLogs = snap.usageLogs;
          state.updates = snap.updates;
          state.deletes = snap.deletes;
          state.executes = snap.executes;
          state.docIdSeq = snap.docIdSeq;
          throw err;
        });
    },
  };
  return stub as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';
const CORPUS_ID = 'corpus-1';
const INGEST_ID = 'ingest-1';

function makeCorpus(over: Partial<StubCorpus> = {}): StubCorpus {
  return {
    id: CORPUS_ID,
    org: ORG,
    project: PROJECT,
    name: 'corpus-a',
    embeddingModel: 'openai/text-embedding-3-small',
    embeddingDim: 1024,
    chunkStrategy: 'recursive-char',
    chunkSize: 800,
    chunkOverlap: 100,
    textSearchConfig: 'spanish',
    ...over,
  };
}

function jobData(over: Partial<IngestJobData> = {}): IngestJobData {
  return {
    ingestId: INGEST_ID,
    corpusId: CORPUS_ID,
    org: ORG,
    project: PROJECT,
    externalId: null,
    text: 'Hello world. This is a short doc.',
    ...over,
  };
}

function makeEmbedder(over?: {
  embeddings?: number[][];
  inputTokens?: number;
  cost?: number;
}) {
  return vi.fn(async (opts: { model: string; input: string | string[] }) => {
    const input = Array.isArray(opts.input) ? opts.input : [opts.input];
    const embeddings =
      over?.embeddings ?? input.map((_, i) => new Array(1024).fill(0).map(() => i + 1));
    return {
      embeddings,
      model: opts.model,
      usage: {
        inputTokens: over?.inputTokens ?? input.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
        estimatedCostUsd: over?.cost ?? 0.00001,
      },
    };
  });
}

/**
 * Injectable sparse (bge-m3) embedder stub. Passing one FORCES the sparse leg
 * on (bypassing the `SPARSE_ENABLED` gate) so these tests drive sparse ingest
 * with zero network. By default returns one sparse vector per input; `over` can
 * fix the sparse array (to force a count mismatch) or make the sibling throw.
 */
function makeSparseEmbedder(over?: { sparse?: SparseVector[]; throwErr?: Error }) {
  return vi.fn(async (opts: { model: string; input: string | string[] }): Promise<SparseEmbedResult> => {
    if (over?.throwErr) throw over.throwErr;
    const input = Array.isArray(opts.input) ? opts.input : [opts.input];
    const sparse =
      over?.sparse ?? input.map((_, i) => ({ indices: [i + 1, i + 5], values: [0.9, 0.4] }));
    return { model: opts.model, dense: input.map(() => [0.1]), sparse };
  });
}

/**
 * Flatten a Drizzle `sql` template object (as recorded by the stub `db.execute`)
 * down to its raw SQL text, so a test can assert WHICH statement ran (tsvector
 * build vs the sparse-embedding UPDATE). Mirrors the flattener in
 * `retrieve-sparse.test.ts`.
 */
function executeToText(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const n of node) executeToText(n, out);
    return;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o['value']) && o['value'].every((v) => typeof v === 'string')) {
      out.push((o['value'] as string[]).join(''));
      return;
    }
    if (Array.isArray(o['queryChunks'])) executeToText(o['queryChunks'], out);
  }
}
function executeSqlText(q: unknown): string {
  const parts: string[] = [];
  executeToText(q, parts);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let state: StubState;
let db: Db;

beforeEach(() => {
  state = makeState();
  db = makeDb(state);
});

describe('processIngestJob', () => {
  it('happy path — new doc with no externalId, chunks + embeddings inserted', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder });

    expect(state.documents).toHaveLength(1);
    const doc = state.documents[0]!;
    expect(doc.externalId).toBeNull();
    expect(doc.ingestId).toBe(INGEST_ID);

    // At least one chunk row inserted, all pointing at the new doc.
    expect(state.chunks.length).toBeGreaterThan(0);
    for (const c of state.chunks) {
      expect(c.documentId).toBe(doc.id);
      expect(c.corpusId).toBe(CORPUS_ID);
      expect(c.embedding).toHaveLength(1024);
    }

    // Embedder was called once with all chunk texts in a batch.
    expect(embedder).toHaveBeenCalledTimes(1);
    const call = embedder.mock.calls[0]![0];
    expect(Array.isArray(call.input)).toBe(true);

    // usage_logs row was appended with the right endpoint tag.
    expect(state.usageLogs).toHaveLength(1);
    expect(state.usageLogs[0]!.endpoint).toBe('/v1/ingest');
    expect(state.usageLogs[0]!.model).toBe('openai/text-embedding-3-small');
  });

  it('dedupe — externalId match deletes prior chunks, updates the doc row, no new doc inserted', async () => {
    state.corpora.push(makeCorpus());
    // Pre-existing document for the same externalId.
    state.documents.push({
      id: 'doc-existing',
      corpusId: CORPUS_ID,
      org: ORG,
      project: PROJECT,
      externalId: 'ext-1',
      text: 'old content',
      title: 'old',
      sourceUrl: null,
      metadata: null,
      ingestId: 'previous-ingest',
    });
    state.chunks.push({
      documentId: 'doc-existing',
      corpusId: CORPUS_ID,
      org: ORG,
      project: PROJECT,
      ordinal: 0,
      text: 'old chunk',
      tokens: 2,
      embedding: new Array(1024).fill(0),
      metadata: null,
    });
    const embedder = makeEmbedder();

    await processIngestJob(
      { id: 'q-1', data: jobData({ externalId: 'ext-1', text: 'updated content here.' }) },
      { db, embedder },
    );

    // No new document row.
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]!.id).toBe('doc-existing');
    // Doc row updated (text / ingestId refreshed via UPDATE).
    const docUpdate = state.updates.find((u) => u.table === 'documents');
    expect(docUpdate).toBeDefined();
    expect(docUpdate!.set.text).toBe('updated content here.');
    expect(docUpdate!.set.ingestId).toBe(INGEST_ID);
    // Old chunks were deleted.
    const chunkDelete = state.deletes.find((d) => d.table === 'chunks');
    expect(chunkDelete).toBeDefined();
    // New chunks inserted (post-delete the chunks state was emptied; insert
    // adds the new ones).
    expect(state.chunks.length).toBeGreaterThan(0);
    for (const c of state.chunks) {
      expect(c.documentId).toBe('doc-existing');
    }
  });

  it('empty text — skipped, no rows inserted', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob({ id: 'q-1', data: jobData({ text: '' }) }, { db, embedder });

    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(embedder).not.toHaveBeenCalled();
  });

  it('embedding failure — re-thrown so BullMQ retries', async () => {
    state.corpora.push(makeCorpus());
    const embedder = vi.fn(async () => {
      throw new Error('upstream embedding 500');
    }) as unknown as typeof import('../services/ai/embeddings/openrouter.js').callOpenRouterEmbedding;

    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder }),
    ).rejects.toThrow('upstream embedding 500');

    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(state.usageLogs).toHaveLength(0);
  });

  it('embedding dimension mismatch — throws BEFORE any doc/chunk insert', async () => {
    // corpus expects 1024-dim (see makeCorpus), but the embedder returns a
    // 512-dim vector — as an unknown model or a drifted EMBEDDING_DIM knob
    // could. The guard must throw legibly and write NOTHING, so BullMQ retries
    // never accumulate duplicate document rows on the null-externalId path.
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder({
      embeddings: [new Array(512).fill(0.1)],
    });

    await expect(
      processIngestJob({ id: 'q-1', data: jobData({ text: 'one short chunk' }) }, { db, embedder }),
    ).rejects.toThrow(/dimension mismatch/i);

    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(state.usageLogs).toHaveLength(0);
  });

  it('missing corpus — soft skip (no throw, no inserts)', async () => {
    // No corpora in state.
    const embedder = makeEmbedder();

    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder });

    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(embedder).not.toHaveBeenCalled();
  });

  it('uses corpus chunkSize / chunkOverlap for chunking', async () => {
    state.corpora.push(makeCorpus({ chunkSize: 5, chunkOverlap: 1 }));
    const embedder = makeEmbedder();
    // Build a doc long enough that chunkSize=5 (=20 chars) forces multiple chunks.
    const text = 'word1. word2. word3. word4. word5. word6. word7. word8.';
    await processIngestJob({ id: 'q-1', data: jobData({ text }) }, { db, embedder });

    expect(state.chunks.length).toBeGreaterThan(1);
    // Embedder received the same number of inputs as chunks generated.
    const call = embedder.mock.calls[0]![0];
    expect(Array.isArray(call.input)).toBe(true);
    expect((call.input as string[]).length).toBe(state.chunks.length);
  });

  // ── request-level chunkConfig ────────────────────────────────────────────
  //
  // The seam that keeps document-format knowledge OUT of this repo: the
  // consumer sends the patterns for its own documents, per batch or per
  // document. Tested at the worker because that is where precedence is
  // resolved, and because per-document granularity is the requirement — one
  // corpus legitimately holds structured documents and plain prose together.

  const SECTIONS = {
    sections: [
      { key: 'section', pattern: String.raw`^[ \t]*Section[ \t]+(\d+)\b`, flags: 'i' },
    ],
  };
  const STRUCTURED_DOC = [
    'PREAMBLE LINE',
    '',
    'Section 1. First provision.',
    '',
    'Section 2. Second provision.',
    '',
    'Section 3. Third provision.',
    '',
  ].join('\n');

  it('request chunkConfig selects the structural splitter on a recursive-char corpus', async () => {
    // The corpus row still says `recursive-char` — and must keep saying it,
    // because the NEXT document in the same corpus may well be prose.
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob(
      { id: 'q-1', data: jobData({ text: STRUCTURED_DOC, chunkConfig: SECTIONS }) },
      { db, embedder },
    );

    const ids = state.chunks.map((c) => (c.metadata as Record<string, unknown> | null)?.['section']);
    expect(ids).toEqual([undefined, '1', '2', '3']); // preamble + one per section
  });

  it('leaves the corpus strategy alone for a document with no chunkConfig', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob({ id: 'q-1', data: jobData({ text: STRUCTURED_DOC }) }, { db, embedder });

    // Same corpus, same text, no config → the historical splitter, no section
    // metadata. This is what makes the field additive.
    for (const c of state.chunks) {
      expect((c.metadata as Record<string, unknown> | null)?.['section']).toBeUndefined();
    }
  });

  it('falls back to the corpus strategy when the request chunkConfig is unusable', async () => {
    // A malformed config must degrade, never fail the ingest — otherwise one
    // bad consumer payload becomes an infinite BullMQ retry loop.
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob(
      {
        id: 'q-1',
        data: jobData({ text: STRUCTURED_DOC, chunkConfig: { preset: 'something-removed' } }),
      },
      { db, embedder },
    );

    expect(state.documents).toHaveLength(1);
    expect(state.chunks.length).toBeGreaterThan(0);
    for (const c of state.chunks) {
      expect((c.metadata as Record<string, unknown> | null)?.['section']).toBeUndefined();
    }
  });

  it('merges chunker section ids UNDER the consumer document metadata', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();

    await processIngestJob(
      {
        id: 'q-1',
        data: jobData({
          text: STRUCTURED_DOC,
          chunkConfig: SECTIONS,
          // The consumer happens to use the same key. Its value must win —
          // it owns its namespace; we are only adding what it could not know.
          metadata: { section: 'consumer-owned', docKey: 'v' },
        }),
      },
      { db, embedder },
    );

    for (const c of state.chunks) {
      const meta = c.metadata as Record<string, unknown>;
      expect(meta['section']).toBe('consumer-owned');
      expect(meta['docKey']).toBe('v');
    }
  });

  // ── learned-sparse (bge-m3) ingest leg — gate forced on via injection ──────
  //
  // Injecting a `sparseEmbedder` bypasses the SPARSE_ENABLED env gate and drives
  // the sparse path with zero network. The critical property under test is HIGH
  // #1: the sparse embed is computed BEFORE the doc/chunk insert, so a sibling
  // failure throws with NOTHING written and a BullMQ retry cannot accumulate
  // duplicate documents on the null-`externalId` path.

  it('sparse ingest (gate on) — populates sparse_embedding alongside dense, one doc only', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();
    const sparseEmbedder = makeSparseEmbedder();

    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder });

    // Dense path is unchanged: exactly one doc, chunks inserted with dense vectors.
    expect(state.documents).toHaveLength(1);
    expect(state.chunks.length).toBeGreaterThan(0);
    for (const c of state.chunks) {
      expect(c.embedding).toHaveLength(1024);
    }

    // Sparse sibling called once with every chunk text in a batch.
    expect(sparseEmbedder).toHaveBeenCalledTimes(1);
    const call = sparseEmbedder.mock.calls[0]![0];
    expect(Array.isArray(call.input)).toBe(true);
    expect((call.input as string[]).length).toBe(state.chunks.length);

    // Both the tsvector build AND the sparse-embedding UPDATE ran.
    const sqls = state.executes.map(executeSqlText);
    expect(sqls.some((s) => s.includes('text_search'))).toBe(true);
    expect(sqls.some((s) => s.includes('sparse_embedding'))).toBe(true);
  });

  it('sparse WRITE failure — whole document rolls back atomically (no dense-only half-index)', async () => {
    // The dense chunk INSERT + tsvector build + sparse UPDATE now run in ONE
    // transaction. The sparse embed (§3b) SUCCEEDS here — it's the WRITE that
    // fails (down DB / bad cast). Before the atomicity fix the dense rows had
    // already committed, leaving a half-indexed dense-only document; now the
    // transaction must roll EVERYTHING back so the retriever never sees a
    // partial doc.
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();
    const sparseEmbedder = makeSparseEmbedder();
    // Make the sparse UPDATE (the only execute mentioning `sparse_embedding`)
    // reject — the tsvector build (`text_search`) still succeeds first.
    state.failExecuteMatching = 'sparse_embedding';

    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder }),
    ).rejects.toThrow(/simulated execute failure/i);

    // Atomic rollback: the document + its chunks + the tsvector write are all
    // gone. Not a single dense-only row survives.
    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    // Usage logging is post-commit; a rolled-back write must not bill.
    expect(state.usageLogs).toHaveLength(0);
    // The sparse embed WAS attempted (it's the write, not the embed, that failed).
    expect(sparseEmbedder).toHaveBeenCalledTimes(1);
  });

  it('sparse count mismatch — throws BEFORE any doc/chunk insert (no dup on retry)', async () => {
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();
    // The default short doc yields ONE chunk, but the sibling returns TWO sparse
    // vectors → count mismatch. The guard must throw and write NOTHING.
    const sparseEmbedder = makeSparseEmbedder({
      sparse: [
        { indices: [1], values: [0.5] },
        { indices: [2], values: [0.5] },
      ],
    });

    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder }),
    ).rejects.toThrow(/sparse embedding count mismatch/i);

    // Because the sparse embed happens before the insert, a mismatch leaves a
    // clean slate — a BullMQ retry cannot pile up duplicate rows.
    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(state.usageLogs).toHaveLength(0);
    // Not even the tsvector build ran — nothing was inserted to index.
    const sqls = state.executes.map(executeSqlText);
    expect(sqls.some((s) => s.includes('sparse_embedding'))).toBe(false);
  });

  it('sparse sibling error — throws with NO insert; two retries produce NO duplicate doc', async () => {
    // The regression HIGH #1 guards against: on the null-externalId path there is
    // no dedupe, so before this fix each retry (sparse embed ran AFTER the insert)
    // left a fresh, fully-retrievable duplicate doc+chunk set. With the embed
    // moved before the insert, a down sibling writes nothing at all.
    state.corpora.push(makeCorpus());
    const embedder = makeEmbedder();
    const downSibling = makeSparseEmbedder({ throwErr: new Error('bge-m3 sibling down') });

    // Attempt 1 (sibling down): throws, nothing written.
    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder: downSibling }),
    ).rejects.toThrow('bge-m3 sibling down');
    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);

    // Attempt 2 (BullMQ retry, still down): throws again, STILL nothing written.
    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder: downSibling }),
    ).rejects.toThrow('bge-m3 sibling down');
    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);

    // Attempt 3 (sibling recovered): inserts EXACTLY ONE doc, with sparse written.
    const recovered = makeSparseEmbedder();
    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder, sparseEmbedder: recovered });
    expect(state.documents).toHaveLength(1);
    expect(state.chunks.length).toBeGreaterThan(0);
    const sqls = state.executes.map(executeSqlText);
    expect(sqls.some((s) => s.includes('sparse_embedding'))).toBe(true);
  });
});
