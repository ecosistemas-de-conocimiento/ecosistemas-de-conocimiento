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
  ingestJobs as ingestJobsTable,
  callbackDeliveries as callbackDeliveriesTable,
  ingestRequests as ingestRequestsTable,
  usageLogs as usageLogsTable,
} from '../db/schema/index.js';
import type { IngestJobData } from '../queue/queues.js';
import type {
  SparseEmbedResult,
  SparseVector,
} from '../services/ai/embeddings/sparse-embed.js';

import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { processIngestJob as rawProcessIngestJob, type IngestBudget } from './ingest.worker.js';
import { WhereRecorder } from '../test/where-recorder.js';
import { BudgetExceeded } from '../services/budget/errors.js';

// ---------------------------------------------------------------------------
// Fake budget
// ---------------------------------------------------------------------------

/** Records every budget call, in order, and holds a plain-number balance. */
interface FakeBudget extends IngestBudget {
  calls: Array<{ op: 'reserve' | 'adjust' | 'refund'; amountUsd: number; traceId?: string | undefined }>;
}

function makeFakeBudget(opts: { refuse?: boolean } = {}): FakeBudget {
  const calls: FakeBudget['calls'] = [];
  return {
    calls,
    reserve: async (input) => {
      if (opts.refuse) throw new BudgetExceeded(input.org, input.amountUsd, 0);
      calls.push({ op: 'reserve', amountUsd: input.amountUsd, traceId: input.traceId });
      return { remainingUsd: 100, softCap: false };
    },
    adjust: async (input) => {
      calls.push({ op: 'adjust', amountUsd: input.deltaUsd, traceId: input.traceId });
    },
    refund: async (input) => {
      calls.push({ op: 'refund', amountUsd: input.amountUsd, traceId: input.traceId });
    },
    heldReserveUsd: async () => null,
  };
}

/**
 * Every test below runs against a fake budget unless it passes its own. The
 * stub DB has no `budget_state`, and the real enforcer is fail-closed on a
 * missing row — it would fail every document before the code under test ran.
 * The real SQL is covered on Postgres in
 * `src/services/budget/ingest-budget.integration.test.ts`.
 */
function processIngestJob(
  job: Parameters<typeof rawProcessIngestJob>[0],
  deps: Parameters<typeof rawProcessIngestJob>[1] = {},
): Promise<void> {
  return rawProcessIngestJob(job, { budget: makeFakeBudget(), ...deps });
}

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
  /**
   * The `ingest_requests` snapshot the counter bump returns. `undefined` → the
   * default no-callback row; `null` → the row is missing (finding A6).
   */
  requestRow?: Record<string, unknown> | null;
  /** `callback_deliveries` rows inserted (rolled back with the transaction). */
  deliveries: Array<Record<string, unknown>>;
  /** When true, the `callback_deliveries` insert rejects (finding A7). */
  failDeliveryInsert?: boolean;
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
    deliveries: [],
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
          if (table === callbackDeliveriesTable) {
            if (state.failDeliveryInsert) {
              return {
                returning() {
                  return Promise.reject(new Error('simulated callback_deliveries insert failure'));
                },
              };
            }
            const ids: Array<{ id: string }> = [];
            for (const v of list) {
              const id = `delivery-${state.deliveries.length + 1}`;
              state.deliveries.push({ id, ...v });
              ids.push({ id });
            }
            return {
              returning() {
                return Promise.resolve(ids);
              },
            };
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
                    if (state.requestRow === null) return Promise.resolve([]);
                    if (state.requestRow) return Promise.resolve([{ ...state.requestRow }]);
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
        deliveries: [...state.deliveries],
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
          state.deliveries = snap.deliveries;
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

// ---------------------------------------------------------------------------
// Claim lifecycle: claim → release-on-error → guarded terminal write
//
// 🔴 THE DEFECT THESE LOCK. A stalled BullMQ job is re-delivered to a second
// worker, which used to re-run the whole body: the document chunked twice,
// EMBEDDED twice (a second charge), and — with `externalId: null`, which has no
// dedupe key — inserted twice. That the WRITES are refused by Postgres is
// proven in `ingest.worker.stalled.integration.test.ts`; these cases prove the
// worker BRANCHES on the row count, and that the three predicates are actually
// sent.
//
// The RELEASE has no integration counterpart and this is its only cover: get it
// wrong and BullMQ's `attempts: 3` retries all bounce off a row stuck at
// 'running', silently turning every transient ingest error into a lost
// document.
// ---------------------------------------------------------------------------

describe('processIngestJob — claim lifecycle', () => {
  const JOB_ROW = 'job-row-1';

  interface ClaimStub {
    db: Db;
    row: { status: string; attempts: number };
    wheres: WhereRecorder;
    sets: Array<Record<string, unknown>>;
  }

  /**
   * A stub narrow enough to see only the `ingest_jobs` writes. Every OTHER
   * table read throws — deliberately: the body is not under test here, and a
   * throw from the corpus load is exactly the "the run failed" case the release
   * path exists for.
   */
  /**
   * `lost` models the `started_at < now() - window` half of the lost-worker
   * predicate, which this stub cannot express in SQL. False (the default) is a
   * row whose owner may still be alive: the reap's UPDATE matches no row, so
   * a re-delivery writes NOTHING at all.
   */
  function makeClaimStub(initialStatus: string, lost = false): ClaimStub {
    const row = { status: initialStatus, attempts: 0 };
    const wheres = new WhereRecorder();
    const sets: Array<Record<string, unknown>> = [];
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    throw new Error('body ran');
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        if (table !== ingestJobsTable) throw new Error('unexpected table');
        return {
          set(values: Record<string, unknown>) {
            const guard = wheres.guard('ingest_jobs');
            return {
              where(predicate: unknown) {
                const { params } = guard.where(predicate);
                const statuses = params
                  .map((pp) => String(pp))
                  .filter((pp) =>
                    ['queued', 'running', 'completed', 'failed'].includes(pp),
                  );
                // Model the SQL predicate: one status ⇒ equality, more ⇒ NOT IN.
                const matched =
                  statuses.length > 1
                    ? !statuses.includes(row.status)
                    : statuses.length === 1
                      ? statuses[0] === row.status
                      : true;
                const applyWrite = () => {
                  if (!matched) return [];
                  // The lost-worker transition also requires an old
                  // `started_at`; the stub carries that as `lost`.
                  if (values.error === 'worker_lost' && !lost) return [];
                  sets.push({ ...values });
                  if (typeof values.status === 'string') row.status = values.status;
                  if (values.attempts !== undefined) row.attempts += 1;
                  return [{ id: JOB_ROW }];
                };
                const result = {
                  returning: async () => applyWrite(),
                  then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
                    return Promise.resolve(applyWrite()).then(resolve, reject);
                  },
                };
                return result;
              },
            };
          },
        };
      },
    } as unknown as Db;
    return { db, row, wheres, sets };
  }

  const data = (): IngestJobData => ({
    ingestId: 'ing-1',
    jobId: JOB_ROW,
    corpusId: 'corpus-1',
    org: 'o',
    project: 'p',
    externalId: null,
    text: 'some text',
  });

  it('a row already `running` is NOT re-claimed: the body never runs', async () => {
    // Exactly the state a stalled re-delivery finds. The stub's body throws, so
    // a return here IS the proof the body was never entered.
    const stub = makeClaimStub('running');
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).resolves.toBeUndefined();
    expect(stub.row.attempts).toBe(0);
    expect(stub.sets).toHaveLength(0);
  });

  // ── Lost worker ────────────────────────────────────────────────────────
  //
  // Same re-delivery, but the row has been 'running' for longer than the lock
  // window, so its owner is presumed dead. The body still must not run — the
  // whole point is that a lost job is never re-embedded — but the row must
  // stop being 'running' forever.

  it("a 'running' row PAST the window is failed as 'worker_lost', body still never runs", async () => {
    const stub = makeClaimStub('running', true);
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).resolves.toBeUndefined();
    // Still never claimed: no re-run, no second embed.
    expect(stub.row.attempts).toBe(0);
    expect(stub.row.status).toBe('failed');
    expect(stub.sets).toHaveLength(1);
    expect(stub.sets[0]).toMatchObject({ status: 'failed', error: 'worker_lost' });
    expect(stub.sets[0]!['finishedAt']).toBeInstanceOf(Date);
  });

  it("the lost transition is guarded on status = 'running', not on NOT IN (terminal)", async () => {
    // A `queued` row must never be swept up by the reaper: it has no worker at
    // all, it is waiting for one. Only a CLAIMED row can be lost.
    const stub = makeClaimStub('running', true);
    await processIngestJob({ id: 'b-1', data: data() }, { db: stub.db });
    const lostWrite = stub.wheres.calls.find(
      (c) => c.table === 'ingest_jobs' && c.params.includes('running'),
    );
    expect(lostWrite).toBeDefined();
    expect(lostWrite!.params).not.toContain('queued');
    // And it names `started_at` — without the age half of the predicate a
    // healthy in-flight job would be killed the moment BullMQ re-delivers it.
    expect(lostWrite!.sql).toContain('started_at');
  });

  it("a 'running' row past the window is not reaped TWICE", async () => {
    const stub = makeClaimStub('running', true);
    await processIngestJob({ id: 'b-1', data: data() }, { db: stub.db });
    await processIngestJob({ id: 'b-2', data: data() }, { db: stub.db });
    // The second delivery finds the row already 'failed', so the guarded
    // UPDATE matches nothing and no second bookkeeping run happens.
    expect(stub.sets).toHaveLength(1);
  });

  it('a row already `completed` is NOT re-claimed either', async () => {
    const stub = makeClaimStub('completed');
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).resolves.toBeUndefined();
    expect(stub.row.status).toBe('completed');
    expect(stub.sets).toHaveLength(0);
  });

  it('the claim UPDATE is conditional on `status = queued` and bumps attempts', async () => {
    const stub = makeClaimStub('queued');
    // The body throws (stub), so the run fails after the claim.
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).rejects.toThrow('body ran');
    const claim = stub.wheres.calls.find((c) => c.params.includes('queued'));
    expect(claim, 'the claim ran without a status predicate').toBeDefined();
    expect(claim!.sql).toContain('status');
    expect(stub.row.attempts).toBe(1);
  });

  it("the claim stamps `started_at` from POSTGRES' clock, not the worker's", async () => {
    // 🔴 ONE CLOCK. `reapLostIngestJob` asks Postgres
    // `started_at < now() - make_interval(...)`. If the claim stamps
    // `started_at` from a `new Date()` built in the worker, the two ends of
    // that comparison come from two machines: a worker whose clock runs ahead
    // makes a live job look older than the lock window and it is reaped as
    // `worker_lost` mid-embed, and one running behind hides a genuinely lost
    // row for the size of the skew. `generation.worker.ts`'s `claimJob` has
    // always used `now()`; this is the ingest half.
    //
    // Sabotage: `startedAt: new Date()` → the SQL assertions below go RED.
    const stub = makeClaimStub('queued');
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).rejects.toThrow('body ran');

    const claim = stub.sets.find((values) => values['status'] === 'running');
    expect(claim, 'the claim never wrote a `running` row').toBeDefined();
    const startedAt = claim!['startedAt'];
    // A `Date` here is the defect itself — node's clock, serialised as a bound
    // parameter — so name that case rather than only asserting the good one.
    expect(startedAt).not.toBeInstanceOf(Date);
    expect(startedAt).toBeInstanceOf(SQL);
    // Serialised through drizzle's own dialect, the same path the recorder
    // uses for predicates: what Postgres would actually receive.
    expect(new PgDialect().sqlToQuery(startedAt as SQL).sql).toBe('now()');
  });

  it('a failed run RELEASES the row back to `queued` so BullMQ can retry it', async () => {
    const stub = makeClaimStub('queued');
    await expect(
      processIngestJob({ id: 'b-1', data: data() }, { db: stub.db }),
    ).rejects.toThrow('body ran');
    // Left at 'running' instead, all three BullMQ attempts would bounce off the
    // claim and the document would be lost silently.
    expect(stub.row.status).toBe('queued');
    const release = stub.wheres.calls.find((c) => c.params.includes('running'));
    expect(release, 'the release ran without a status predicate').toBeDefined();
  });

  it('a job with NO jobId runs unclaimed — the pre-migration payload still works', async () => {
    // Jobs enqueued by an older build sit in Redis across a deploy. They must
    // run (old behaviour), not be dropped.
    const stub = makeClaimStub('queued');
    const { jobId: _drop, ...legacy } = data();
    await expect(
      processIngestJob({ id: 'b-1', data: legacy as IngestJobData }, { db: stub.db }),
    ).rejects.toThrow('body ran');
    expect(stub.sets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Callback delivery durability (PLAN-live-ingest findings A3/A6/A7)
// ---------------------------------------------------------------------------

describe('processIngestJob — callback outbox', () => {
  const CALLBACK_ROW = {
    callbackUrl: 'http://203.0.113.7:1/cb',
    apiKeyId: 'key-id-without-a-configured-secret',
    corpus: 'test-corpus',
    totalDocs: 1,
    completedDocs: 1,
    failedDocs: 0,
    status: 'running',
  };

  it('A7: the ingest.completed delivery row is written in the SAME transaction as the document', async () => {
    state.corpora.push(makeCorpus());
    state.requestRow = { ...CALLBACK_ROW };
    await processIngestJob({ id: 'q-1', data: jobData({ externalId: 'ext-1' }) }, { db, embedder: makeEmbedder() });

    expect(state.documents).toHaveLength(1);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      event: 'ingest.completed',
      source: 'ingest',
      sourceId: INGEST_ID,
      itemKey: 'ext-1',
      url: CALLBACK_ROW.callbackUrl,
    });
  });

  it('A7: a failed delivery insert rolls the document back and FAILS the job (BullMQ retries)', async () => {
    state.corpora.push(makeCorpus());
    state.requestRow = { ...CALLBACK_ROW };
    state.failDeliveryInsert = true;

    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder: makeEmbedder() }),
    ).rejects.toThrow('simulated callback_deliveries insert failure');

    // Nothing survived: a retry starts from zero and cannot duplicate the doc.
    expect(state.documents).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
    expect(state.usageLogs).toHaveLength(0);
    expect(state.deliveries).toHaveLength(0);
  });

  it('A3: a missing corpus emits ingest.failed and moves the failed counter', async () => {
    // No corpora in state.
    state.requestRow = { ...CALLBACK_ROW, completedDocs: 0, failedDocs: 1 };
    const embedder = makeEmbedder();
    await processIngestJob({ id: 'q-1', data: jobData({ externalId: 'ext-gone' }) }, { db, embedder });

    expect(embedder).not.toHaveBeenCalled();
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({ event: 'ingest.failed', itemKey: 'ext-gone' });
    expect(JSON.parse(String(state.deliveries[0]!.body))).toMatchObject({
      event: 'ingest.failed',
      error: { code: 'corpus-missing' },
    });
    // The failed-docs counter was bumped and the batch went terminal.
    const reqUpdates = state.updates.filter((u) => u.table === 'ingest_requests');
    expect(reqUpdates.some((u) => 'failedDocs' in u.set)).toBe(true);
    expect(reqUpdates.some((u) => u.set.status === 'failed')).toBe(true);
  });

  it('A6: a missing ingest_requests row is counted, not silently skipped', async () => {
    const { callbackEmitSkippedTotal } = await import('../metrics/callbacks.js');
    const value = async () =>
      (await callbackEmitSkippedTotal.get()).values.find(
        (v) => (v.labels as Record<string, unknown>).reason === 'ingest_request_missing',
      )?.value ?? 0;
    const before = await value();
    state.corpora.push(makeCorpus());
    state.requestRow = null;

    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder: makeEmbedder() });

    expect(state.documents).toHaveLength(1); // the document itself is fine
    expect(state.deliveries).toHaveLength(0);
    expect(await value()).toBe(before + 1);
  });
});

describe('processIngestJob — budget (AIS-7)', () => {
  it('reserves the estimate BEFORE the embed, then trues up to the actual cost under the same trace', async () => {
    state.corpora.push(makeCorpus());
    const budget = makeFakeBudget();
    const order: string[] = [];
    const reserve = budget.reserve;
    budget.reserve = async (input) => {
      order.push('reserve');
      return reserve(input);
    };
    const inner = makeEmbedder({ cost: 0.00001 });
    const embedder = vi.fn(async (o: { model: string; input: string | string[] }) => {
      order.push('embed');
      return inner(o);
    });

    await processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder: embedder as never, budget });

    expect(order).toEqual(['reserve', 'embed']);
    const [res, adj, ...rest] = budget.calls;
    expect(rest).toHaveLength(0);
    expect(res!.op).toBe('reserve');
    expect(res!.amountUsd).toBeGreaterThan(0);
    expect(adj!.op).toBe('adjust');
    // delta = estimate − actual: what lands on the counter is exactly the actual.
    expect(res!.amountUsd - adj!.amountUsd).toBeCloseTo(0.00001, 12);
    expect(adj!.traceId).toBe(res!.traceId);
    expect(state.documents).toHaveLength(1);
  });

  it('refunds the whole hold when the embed throws', async () => {
    state.corpora.push(makeCorpus());
    const budget = makeFakeBudget();
    const embedder = vi.fn(async () => {
      throw new Error('upstream embedding 500');
    });

    await expect(
      processIngestJob({ id: 'q-1', data: jobData() }, { db, embedder: embedder as never, budget }),
    ).rejects.toThrow('upstream embedding 500');

    expect(budget.calls.map((c) => c.op)).toEqual(['reserve', 'refund']);
    expect(budget.calls[1]!.amountUsd).toBe(budget.calls[0]!.amountUsd);
    expect(budget.calls[1]!.traceId).toBe(budget.calls[0]!.traceId);
  });

  it('charges, not refunds, once the provider answered — even if the vectors are then rejected', async () => {
    state.corpora.push(makeCorpus());
    const budget = makeFakeBudget();
    const embedder = makeEmbedder({ embeddings: [new Array(512).fill(0.1)], cost: 0.00002 });

    await expect(
      processIngestJob({ id: 'q-1', data: jobData({ text: 'one short chunk' }) }, { db, embedder, budget }),
    ).rejects.toThrow(/dimension mismatch/i);

    expect(budget.calls.map((c) => c.op)).toEqual(['reserve', 'adjust']);
  });

  it('a refused reserve fails the document without calling the embedder or retrying', async () => {
    state.corpora.push(makeCorpus());
    state.requestRow = {
      callbackUrl: 'http://203.0.113.7:1/cb',
      apiKeyId: 'k',
      corpus: 'test-corpus',
      totalDocs: 1,
      completedDocs: 0,
      failedDocs: 1,
      status: 'running',
    };
    const embedder = makeEmbedder();

    // Resolves: a retry would meet the same cap.
    await processIngestJob(
      { id: 'q-1', data: jobData({ externalId: 'ext-broke' }) },
      { db, embedder, budget: makeFakeBudget({ refuse: true }) },
    );

    expect(embedder).not.toHaveBeenCalled();
    expect(state.documents).toHaveLength(0);
    expect(JSON.parse(String(state.deliveries[0]!.body))).toMatchObject({
      event: 'ingest.failed',
      error: { code: 'ERR_BUDGET_EXCEEDED' },
    });
  });
});
