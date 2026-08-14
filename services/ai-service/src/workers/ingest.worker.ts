// In-process BullMQ worker for the `ingest` queue.
//
// One job = one IngestDocument. Steps (plan/m3-m4-decisions.md §11/§13–§15):
//   1. Load the corpus row to pick up the current chunk + embedding settings.
//   2. Chunk the doc text via `chunkForCorpus(...)` — request-supplied
//      `chunkConfig` first, else the corpus row's strategy.
//   3. Embed all chunk texts in one batch call to OpenRouter.
//   4. Dedupe: if `externalId` is non-null, look up the existing document and
//      delete its prior chunks, then UPDATE the doc row's text/title/metadata.
//      Otherwise INSERT a new document row.
//   5. INSERT one chunk row per chunk (with ordinal + embedding).
//   6. Append a `usage_logs` row tagged `/v1/ingest` so spend rolls up cleanly.
//
// `processIngestJob` is exported so unit tests can drive it without Redis.
// Errors are re-thrown to BullMQ (so its retry/backoff kicks in) — unlike the
// generation worker which swallows internally because validator retry is
// already in-band.

import { Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db as defaultDb, type Db } from '../db/client.js';
import { chunks, corpora, documents, ingestRequests, usageLogs } from '../db/schema/index.js';
import { redisConnection } from '../queue/connection.js';
import { INGEST_QUEUE_NAME, type IngestJobData } from '../queue/queues.js';
import { callOpenRouterEmbedding } from '../services/ai/embeddings/openrouter.js';
import {
  callSparseEmbed,
  toSparsevecLiteral,
  type SparseEmbedder,
} from '../services/ai/embeddings/sparse-embed.js';
import { priceForEmbedding } from '../services/ai/router/task-profiles.js';
import { enqueueCallback, maybeMarkProgress } from '../services/callbacks/emit.js';
import { chunkForCorpus, parseStructuralConfig, STRUCTURAL } from '../services/rag/chunk-strategy.js';

export interface IngestWorkerDeps {
  db?: Db;
  embedder?: typeof callOpenRouterEmbedding;
  /**
   * Injectable learned-sparse (bge-m3) embedder. Defaults to the real
   * `callSparseEmbed` client. Passing a stub FORCES the sparse path on
   * (bypassing the `SPARSE_ENABLED` + `SPARSE_EMBED_URL` gate) so tests can drive
   * sparse ingest with zero network. When active, each chunk's
   * `sparse_embedding` is populated alongside its dense `embedding`.
   */
  sparseEmbedder?: SparseEmbedder;
}

function usdString(v: number): string {
  return v.toFixed(6);
}

/**
 * Combine the consumer's document-level metadata with whatever the chunker
 * derived for this specific chunk. Consumer keys win. Returns null (not `{}`)
 * when there is nothing on either side, preserving the exact column value
 * every pre-existing row has.
 */
function mergeChunkMetadata(
  docMeta: Record<string, unknown> | undefined,
  chunkMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!docMeta && !chunkMeta) return null;
  return { ...(chunkMeta ?? {}), ...(docMeta ?? {}) };
}

/**
 * Process one ingest job. Exposed for direct unit-test invocation. Throws on
 * unrecoverable errors so BullMQ retries; empty input is a soft skip (just
 * logs and returns).
 *
 * Callback contract (per `plan/m3-webhook-signing-followup.md`):
 *   - On success → emit `ingest.completed` for this doc.
 *   - On failure → emit `ingest.failed` for this doc, and RE-THROW so BullMQ
 *     retries. Throwing AFTER counters bump is intentional: we only want to
 *     count the doc as failed once the retries are exhausted, but BullMQ
 *     handles that bookkeeping; we count optimistically and the consumer
 *     should treat `ingest.failed` as terminal-for-this-doc (the contract
 *     spec says "ai-service has already exhausted retries"). To match the
 *     contract, we only fire `ingest.failed` from the BullMQ `on('failed')`
 *     handler, which fires after retries exhaust — see `startIngestWorker`.
 *   - When `completed + failed >= total`, emit `ingest.completed` /
 *     `ingest.failed` at the batch level too (one envelope: progress-style
 *     summary with batch counts).
 */
export async function processIngestJob(
  bullJob: { id: string; data: IngestJobData },
  deps: IngestWorkerDeps = {},
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const embedder = deps.embedder ?? callOpenRouterEmbedding;
  const sparseEmbedder = deps.sparseEmbedder ?? callSparseEmbed;
  // Sparse (bge-m3 learned-lexical) leg is OFF unless a stub is injected (tests)
  // or the production gate is set. Byte-identical dense/tsvector ingest when off.
  const sparseActive =
    deps.sparseEmbedder !== undefined || (env.SPARSE_ENABLED && Boolean(env.SPARSE_EMBED_URL));
  const data = bullJob.data;
  const startedAt = Date.now();

  // ── 1. Load corpus ────────────────────────────────────────────────────
  const corpusRows = await db
    .select()
    .from(corpora)
    .where(eq(corpora.id, data.corpusId))
    .limit(1);
  const corpus = corpusRows[0];
  if (!corpus) {
    console.warn(`ingest worker: corpus ${data.corpusId} missing; dropping job ${bullJob.id}`);
    return;
  }

  // ── 2. Chunk ──────────────────────────────────────────────────────────
  const text = data.text;
  if (!text || text.length === 0) {
    console.warn(`ingest worker: empty text for ingestId=${data.ingestId} externalId=${data.externalId ?? '<none>'}; skipping`);
    // Treat as failure for callback purposes.
    await onIngestDocFailed(db, data, {
      code: 'empty-text',
      message: 'document text is empty',
    });
    return;
  }
  // Request-level chunk config beats the corpus row.
  //
  // The corpus row is the wrong granularity on its own: a single corpus
  // routinely holds documents whose addressable unit is a numbered section
  // ALONGSIDE documents that are ordinary prose, and a per-corpus setting
  // forces one splitter on both. So a config supplied with the ingest request
  // (per batch, or per document) selects the structural splitter for exactly
  // the documents it came with, and leaves everything else alone.
  //
  // "Supplied AND usable" is the condition — `parseStructuralConfig` returning
  // null means the consumer sent something the splitter cannot run, and the
  // right answer then is the corpus's configured behaviour, not a failed
  // ingest. Every degradation below is warn-and-continue for that reason.
  const requestConfig = data.chunkConfig;
  const requestConfigUsable =
    requestConfig !== undefined &&
    parseStructuralConfig(requestConfig, (m) =>
      console.warn(`ingest worker: request chunkConfig rejected — ${m}`),
    ) !== null;
  const docChunks = chunkForCorpus(text, {
    chunkStrategy: requestConfigUsable ? STRUCTURAL : corpus.chunkStrategy,
    chunkSize: corpus.chunkSize,
    chunkOverlap: corpus.chunkOverlap,
    chunkConfig: requestConfigUsable ? requestConfig : corpus.chunkConfig,
  });
  // Temporal validity — parsed once and applied identically to the document
  // row and every chunk it produces. Denormalising onto chunks is deliberate:
  // the retrieval filter runs inside a hot vector/GIN scan and must not need a
  // join back to `documents` to decide whether a candidate is eligible.
  const validFrom = data.validFrom ? new Date(data.validFrom) : null;
  const validTo = data.validTo ? new Date(data.validTo) : null;

  if (docChunks.length === 0) {
    console.warn(`ingest worker: 0 chunks for ingestId=${data.ingestId}; skipping`);
    await onIngestDocFailed(db, data, {
      code: 'zero-chunks',
      message: 'document produced no chunks',
    });
    return;
  }

  // ── 3. Embed (batch) ──────────────────────────────────────────────────
  const embedResult = await embedder({
    model: corpus.embeddingModel,
    input: docChunks.map((c) => c.text),
  });
  if (embedResult.embeddings.length !== docChunks.length) {
    throw new Error(
      `ingest worker: embedding count mismatch (got ${embedResult.embeddings.length}, expected ${docChunks.length})`,
    );
  }
  // Dimension guard (Fable review MUST-FIX 1 / #6). The `chunks.embedding`
  // column is a fixed-width `vector(corpus.embeddingDim)`; a vector of any
  // other length fails the pgvector insert. We check BEFORE writing the
  // document row so a dimension mismatch (a known-model mismatch is already
  // refused at corpus creation, but an UNKNOWN model or a drifted
  // `EMBEDDING_DIM` knob can still produce one) throws here — NOT after a
  // partial write. Throwing before the insert is what stops BullMQ retries
  // from accumulating duplicate document rows on the null-externalId path.
  const expectedDim = corpus.embeddingDim;
  const badIdx = embedResult.embeddings.findIndex(
    (v) => (Array.isArray(v) ? v.length : -1) !== expectedDim,
  );
  if (badIdx !== -1) {
    const gotLen = Array.isArray(embedResult.embeddings[badIdx])
      ? embedResult.embeddings[badIdx]!.length
      : 'non-array';
    throw new Error(
      `ingest worker: embedding dimension mismatch for corpus ${data.corpusId} ` +
        `(model ${corpus.embeddingModel}): vector ${badIdx} is ${gotLen}-dim but the corpus ` +
        `expects ${expectedDim} (chunks.embedding is fixed-width). Refusing to insert ` +
        `to avoid a poison-pill retry loop and duplicate document rows.`,
    );
  }

  // ── 3b. Learned-sparse (bge-m3) embed — OPT-IN, computed BEFORE any insert ──
  // When the sparse leg is active (an injected embedder for tests/eval, or the
  // `SPARSE_ENABLED` + `SPARSE_EMBED_URL` production gate), embed the same chunk
  // texts with the bge-m3 sparse sibling and build the sparsevec literals HERE —
  // BEFORE the document/chunk insert below, exactly mirroring the dense
  // dimension guard above.
  //
  // WHY BEFORE THE INSERT (HIGH #1): the sibling is a network call and can throw
  // (down service, timeout, count mismatch). This embed + the sparse UPDATE used
  // to run AFTER the doc/chunk insert (old §5b). On a throw there, processIngestJob
  // throws → BullMQ retries (attempts:3) → and the null-`externalId` path has NO
  // dedupe, so every retry inserted a fresh, fully-retrievable duplicate doc+chunk
  // set (missing only sparse). Computing the sparse vectors before the insert means
  // a sibling failure throws with NOTHING written — no duplicate rows accumulate on
  // retry, the same guarantee the dense dimension guard already provides.
  //
  // FAIL-LOUD is DELIBERATE, not fail-safe: the seam's own design notes (the
  // `callSparseEmbed` docstring and §5b) require a broken sibling to SURFACE
  // rather than silently produce a half-indexed corpus. Throwing before the
  // insert reconciles fail-loud with the no-duplicate invariant. The actual
  // sparse WRITE still runs in §5b — it needs the inserted `documentId` — but the
  // failure-prone step (the sibling call) is now pre-insert.
  let sparseLiterals: string[] | null = null;
  if (sparseActive) {
    const sparseResult = await sparseEmbedder({
      model: env.SPARSE_EMBED_MODEL,
      input: docChunks.map((c) => c.text),
    });
    if (sparseResult.sparse.length !== docChunks.length) {
      throw new Error(
        `ingest worker: sparse embedding count mismatch (got ${sparseResult.sparse.length}, ` +
          `expected ${docChunks.length}) for corpus ${data.corpusId}`,
      );
    }
    sparseLiterals = sparseResult.sparse.map((v) => toSparsevecLiteral(v, env.SPARSE_DIM));
  }

  // ── 4–5b. Atomic write: document + chunks + tsvector + sparse ─────────
  // Everything that WRITES this document runs inside ONE transaction, so ANY
  // failure — a chunk insert, the tsvector build, or the sparse UPDATE — rolls
  // the WHOLE document back. Before this, the dense chunk INSERT COMMITTED before
  // the sparse write ran (old §5b lived after the insert with no surrounding
  // tx), so a sparse-write failure left a half-indexed dense-only document. The
  // transaction makes it clean all-or-nothing.
  //
  // Read-only / network steps stay OUTSIDE the tx on purpose: the corpus load
  // (§1) and the dense + sparse EMBED (§3/§3b) already ran, and the sparse
  // vectors are computed PRE-insert (§3b) so a sibling failure writes nothing —
  // we never hold a transaction open across a network call. Usage tracking (§6)
  // and the callback contract (§7) are post-commit side effects and stay outside
  // too: a rollback re-throws, so neither runs on a failed write.
  const documentId = await db.transaction(async (tx) => {
    // ── 4. Dedupe / upsert the document row ───────────────────────────────
    let docId: string;
    if (data.externalId !== null) {
      const existing = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.corpusId, data.corpusId),
            eq(documents.externalId, data.externalId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        docId = existing[0].id;
        // Drop prior chunks (cascade-on-delete only triggers when the parent
        // doc is deleted; we want to KEEP the doc row and just refresh its
        // body, so wipe the chunks manually). Now inside the tx: the delete +
        // re-insert of a re-ingested doc's chunks is itself atomic.
        await tx.delete(chunks).where(eq(chunks.documentId, docId));
        await tx
          .update(documents)
          .set({
            text,
            title: data.title ?? null,
            sourceUrl: data.sourceUrl ?? null,
            metadata: data.metadata ?? null,
            language: data.language ?? null,
            validFrom,
            validTo,
            ingestId: data.ingestId,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, docId));
      } else {
        const inserted = await tx
          .insert(documents)
          .values({
            corpusId: data.corpusId,
            org: data.org,
            project: data.project,
            externalId: data.externalId,
            text,
            title: data.title ?? null,
            sourceUrl: data.sourceUrl ?? null,
            metadata: data.metadata ?? null,
            language: data.language ?? null,
            validFrom,
            validTo,
            ingestId: data.ingestId,
          })
          .returning({ id: documents.id });
        const row = inserted[0];
        if (!row) throw new Error('ingest worker: document insert returned no row');
        docId = row.id;
      }
    } else {
      const inserted = await tx
        .insert(documents)
        .values({
          corpusId: data.corpusId,
          org: data.org,
          project: data.project,
          externalId: null,
          text,
          title: data.title ?? null,
          sourceUrl: data.sourceUrl ?? null,
          metadata: data.metadata ?? null,
          language: data.language ?? null,
          validFrom,
          validTo,
          ingestId: data.ingestId,
        })
        .returning({ id: documents.id });
      const row = inserted[0];
      if (!row) throw new Error('ingest worker: document insert returned no row');
      docId = row.id;
    }

    // ── 5. Insert chunk rows ──────────────────────────────────────────────
    const chunkValues = docChunks.map((c, i) => ({
      documentId: docId,
      corpusId: data.corpusId,
      org: data.org,
      project: data.project,
      ordinal: c.ordinal,
      text: c.text,
      tokens: c.tokens,
      embedding: embedResult.embeddings[i] as number[],
      // Round-trip the consumer's opaque doc-level metadata onto each chunk so
      // /v1/retrieve (which SELECTs chunks.metadata) returns it. Without this,
      // chunk.metadata is always null and consumers (a prototype M3 citations) cannot
      // map a retrieved chunk back to their source row.
      //
      // Chunker-derived metadata (structural section ids, under whatever `key`
      // the consumer's own `chunk_config` named) is merged UNDERNEATH the
      // consumer's, so a consumer key always wins a collision. The consumer
      // owns its namespace; we are only
      // adding what it could not have known — which chunk of the document this
      // is, structurally.
      metadata: mergeChunkMetadata(data.metadata, c.metadata),
      validFrom,
      validTo,
    }));
    if (chunkValues.length > 0) {
      await tx.insert(chunks).values(chunkValues);
      // Build the lexical index for the chunks we just wrote. A separate
      // statement rather than part of the INSERT because the text search
      // configuration is per-corpus and has to be bound as a parameter; and a
      // separate statement rather than a GENERATED column for the same reason.
      // Scoped to this document so a re-ingest of one doc never rewrites the
      // whole corpus. `::regconfig` on a bound param — the config name is never
      // interpolated into SQL text.
      await tx.execute(sql`
        UPDATE "chunks"
           SET "text_search" = to_tsvector(${corpus.textSearchConfig}::regconfig, "text")
         WHERE "document_id" = ${docId}::uuid
      `);

      // ── 5b. Learned-sparse (bge-m3) index — OPT-IN, gated ────────────────────
      // Write the sparse vectors embedded in §3b (computed BEFORE this insert, so a
      // sibling failure can never leave a duplicate doc on retry — see §3b). The
      // dense path above is untouched (still OpenRouter, cost tracked as before);
      // sparse is purely additive, so a gate-off ingest is byte-identical
      // (`sparseLiterals` stays null and this block is skipped). Matched back to the
      // just-inserted rows by (document_id, ordinal) — ordinal is unique within a
      // document. Runs inside the SAME transaction as the insert above, so a
      // sparse-write failure rolls the whole document back — no dense-only
      // half-index.
      if (sparseLiterals) {
        // Ship the (ordinal, sparsevec-literal) pairs as ONE json param and
        // unnest them server-side. A raw JS array interpolated into drizzle's
        // `sql` template is NOT a single array bind: drizzle expands it into a
        // parenthesised param LIST — `unnest(($1,$2,…)::int[])` — and pushes each
        // element as its own scalar param, so the first ordinal (a raw number)
        // reaches postgres.js's Bind step as a non-string and throws
        // (`"string" argument … Received type number (0)`). A single json string
        // is one clean bind, and it needs no manual PG-array escaping of the
        // sparsevec literals (which themselves contain commas and braces).
        // `jsonb_array_elements` yields one `[ordinal, literal]` row per chunk;
        // the casts pull each field back out.
        const pairs = JSON.stringify(
          docChunks.map((c, i) => [c.ordinal, sparseLiterals![i]]),
        );
        await tx.execute(sql`
          UPDATE "chunks" AS c
             SET "sparse_embedding" = (d.pair->>1)::sparsevec
            FROM (
              SELECT jsonb_array_elements(${pairs}::jsonb) AS pair
            ) AS d
           WHERE c."document_id" = ${docId}::uuid
             AND c."ordinal" = (d.pair->>0)::int
        `);
      }
    }

    return docId;
  });

  // ── 6. Usage tracking ─────────────────────────────────────────────────
  const cost =
    embedResult.usage.estimatedCostUsd > 0
      ? embedResult.usage.estimatedCostUsd
      : priceForEmbedding(corpus.embeddingModel, embedResult.usage.inputTokens);
  await db.insert(usageLogs).values({
    org: data.org,
    project: data.project,
    provider: 'openrouter',
    model: corpus.embeddingModel,
    endpoint: '/v1/ingest',
    inputTokens: embedResult.usage.inputTokens,
    outputTokens: 0,
    estimatedCostUsd: usdString(cost),
    actualCostUsd: usdString(cost),
    status: 'completed',
    metadata: { ingestId: data.ingestId, documentId, chunkCount: docChunks.length },
  });

  // ── 7. Callback contract: per-doc completion + batch terminal ─────────
  await onIngestDocCompleted(db, data, {
    docId: data.externalId ?? documentId,
    chunkCount: docChunks.length,
    model: corpus.embeddingModel,
    dimensions: corpus.embeddingDim,
    costUsd: cost,
    durationMs: Date.now() - startedAt,
  });
}

// ---------------------------------------------------------------------------
// Callback contract: terminal-state helpers
// ---------------------------------------------------------------------------

/**
 * Atomically increment `ingest_requests.completed_docs`, then emit the per-doc
 * `ingest.completed` envelope, and — if this was the last doc — the batch-
 * level `ingest.completed` / `ingest.failed` envelope too. Also fires
 * `ingest.progress` per the contract throttle (every 10 docs or 30s on
 * batches > 5).
 */
async function onIngestDocCompleted(
  db: Db,
  data: IngestJobData,
  result: {
    docId: string;
    chunkCount: number;
    model: string;
    dimensions: number;
    costUsd: number;
    durationMs: number;
  },
): Promise<void> {
  const requestRow = await bumpIngestCounters(db, data.ingestId, 'completed');
  if (!requestRow) return; // legacy row missing — silently skip emit

  const now = new Date();
  if (requestRow.callbackUrl) {
    void enqueueCallback(
      {
        event: 'ingest.completed',
        emittedAt: now.toISOString(),
        ingestId: data.ingestId,
        corpus: requestRow.corpus,
        docId: result.docId,
        embeddings: {
          chunkCount: result.chunkCount,
          model: result.model,
          dimensions: result.dimensions,
        },
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      },
      {
        url: requestRow.callbackUrl,
        apiKeyId: requestRow.apiKeyId,
        source: 'ingest',
        sourceId: data.ingestId,
        itemKey: result.docId,
        org: data.org,
        project: data.project,
      },
      { db },
    ).catch((err) => {
      console.warn(
        `ingest worker: enqueueCallback (ingest.completed) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Progress event throttle (only for batches > 5 docs, every 10 or 30s).
    if (
      await maybeMarkProgress(
        db,
        data.ingestId,
        requestRow.totalDocs,
        requestRow.completedDocs,
        now,
      )
    ) {
      void enqueueCallback(
        {
          event: 'ingest.progress',
          emittedAt: now.toISOString(),
          ingestId: data.ingestId,
          corpus: requestRow.corpus,
          totalDocs: requestRow.totalDocs,
          completedDocs: requestRow.completedDocs,
          failedDocs: requestRow.failedDocs,
        },
        {
          url: requestRow.callbackUrl,
          apiKeyId: requestRow.apiKeyId,
          source: 'ingest',
          sourceId: data.ingestId,
          itemKey: null,
          org: data.org,
          project: data.project,
        },
        { db },
      ).catch((err) => {
        console.warn(
          `ingest worker: enqueueCallback (ingest.progress) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
  await maybeMarkBatchTerminal(db, data, requestRow);
}

async function onIngestDocFailed(
  db: Db,
  data: IngestJobData,
  error: { code: string; message: string },
): Promise<void> {
  const requestRow = await bumpIngestCounters(db, data.ingestId, 'failed');
  if (!requestRow) return;
  const now = new Date();
  const docId = data.externalId ?? data.ingestId; // fallback: caller didn't supply an id
  if (requestRow.callbackUrl) {
    void enqueueCallback(
      {
        event: 'ingest.failed',
        emittedAt: now.toISOString(),
        ingestId: data.ingestId,
        corpus: requestRow.corpus,
        docId,
        error,
      },
      {
        url: requestRow.callbackUrl,
        apiKeyId: requestRow.apiKeyId,
        source: 'ingest',
        sourceId: data.ingestId,
        itemKey: docId,
        org: data.org,
        project: data.project,
      },
      { db },
    ).catch((err) => {
      console.warn(
        `ingest worker: enqueueCallback (ingest.failed) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  await maybeMarkBatchTerminal(db, data, requestRow);
}

interface IngestRequestSnapshot {
  callbackUrl: string | null;
  apiKeyId: string | null;
  corpus: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed';
}

/**
 * Atomic `UPDATE … RETURNING` to bump completed/failed counters and read the
 * post-update snapshot back. Returns null if no `ingest_requests` row exists
 * for the id (legacy / orphan).
 */
async function bumpIngestCounters(
  db: Db,
  ingestRequestId: string,
  kind: 'completed' | 'failed',
): Promise<IngestRequestSnapshot | null> {
  const column = kind === 'completed' ? ingestRequests.completedDocs : ingestRequests.failedDocs;
  const rows = await db
    .update(ingestRequests)
    .set(
      kind === 'completed'
        ? { completedDocs: sql`${column} + 1`, status: sql`CASE WHEN ${ingestRequests.status} = 'queued' THEN 'running'::ingest_request_status ELSE ${ingestRequests.status} END` }
        : { failedDocs: sql`${column} + 1`, status: sql`CASE WHEN ${ingestRequests.status} = 'queued' THEN 'running'::ingest_request_status ELSE ${ingestRequests.status} END` },
    )
    .where(eq(ingestRequests.id, ingestRequestId))
    .returning({
      callbackUrl: ingestRequests.callbackUrl,
      apiKeyId: ingestRequests.apiKeyId,
      corpus: ingestRequests.corpus,
      totalDocs: ingestRequests.totalDocs,
      completedDocs: ingestRequests.completedDocs,
      failedDocs: ingestRequests.failedDocs,
      status: ingestRequests.status,
    });
  return rows[0] ?? null;
}

/**
 * When `completed + failed >= total`, flip status to its terminal value
 * (`completed` / `partial` / `failed`) and emit no additional callback —
 * per the contract spec the per-doc events ARE the terminal signal; we do
 * NOT fire a duplicate batch-level `ingest.completed`. The contract says
 * "plus a final ingest.completed envelope for the batch IF any docs
 * succeeded" — we keep that as a future enhancement; current consumer
 * (a prototype) tracks doc-level only.
 */
async function maybeMarkBatchTerminal(
  db: Db,
  data: IngestJobData,
  snapshot: IngestRequestSnapshot,
): Promise<void> {
  const { totalDocs, completedDocs, failedDocs } = snapshot;
  if (completedDocs + failedDocs < totalDocs) return;
  const nextStatus: 'completed' | 'partial' | 'failed' =
    failedDocs === 0 ? 'completed' : completedDocs === 0 ? 'failed' : 'partial';
  await db
    .update(ingestRequests)
    .set({ status: nextStatus, finishedAt: new Date() })
    .where(eq(ingestRequests.id, data.ingestId));
}

export async function startIngestWorker(
  deps: IngestWorkerDeps = {},
): Promise<{ worker: Worker<IngestJobData>; stop: () => Promise<void> }> {
  const db = deps.db ?? defaultDb;
  const worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    async (job) => {
      await processIngestJob({ id: String(job.id ?? ''), data: job.data }, deps);
    },
    {
      connection: redisConnection,
      concurrency: 3,
    },
  );

  // BullMQ fires `failed` on each attempt; only emit `ingest.failed` once
  // retries are exhausted (`job.attemptsMade >= job.opts.attempts`). The
  // counter bump + callback contract emit happens then.
  worker.on('failed', (job, err) => {
    console.error(
      `ingest worker: BullMQ-level failure for job ${job?.id}: ${err.message}`,
    );
    if (!job) return;
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      void onIngestDocFailed(db, job.data, {
        code: 'job-failed',
        message: err.message,
      }).catch((e) => {
        console.warn(
          `ingest worker: onIngestDocFailed bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
  });

  return {
    worker,
    stop: async () => {
      await worker.close().catch(() => undefined);
    },
  };
}
