// Ingest service — orchestrator-side entry point for `POST /v1/ingest`.
//
// Responsibility: resolve / create the target corpus, mint an `ingestId`, fan
// one BullMQ job per `IngestDocument` into the new `ingest` queue (decisions
// §14 — always async). The actual chunking + embedding + DB writes happen in
// `src/workers/ingest.worker.ts`. Status is reported via `getIngestStatus`,
// which counts `documents` rows already written by the worker.
//
// Cross-org/project isolation: every corpus lookup is filtered by
// `(org, project)` — never any narrower. The auth plugin's `req.auth.org` /
// `req.auth.project` are the canonical scope; the route handler must pass
// them through verbatim.

import { and, eq, sql } from 'drizzle-orm';

import { env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { corpora, documents, ingestRequests } from '../../db/schema/index.js';
import type {
  GenerationQueueLike,
} from '../../queue/queues.js';
import {
  INGEST_QUEUE_NAME,
  type IngestJobData,
  type IngestQueueLike,
} from '../../queue/queues.js';
import { resolveCorpusEmbeddingDim } from './embedding-models.js';
import { resolveTextSearchConfig } from './language.js';
import type { IngestRequest, IngestResult } from './types.js';

export interface IngestServiceDeps {
  db: Db;
  queue: IngestQueueLike;
}

export interface IngestCtx {
  org: string;
  project: string;
  /**
   * SHA-256 fingerprint of the bearer key — captured on the `ingest_requests`
   * row so the callback emitter can look up the per-consumer `callbackSecret`
   * later, without re-reading HTTP headers (which are gone by worker time).
   */
  apiKeyId?: string;
}

export interface IngestStatus {
  ingestId: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'processing' | 'completed' | 'partial' | 'failed';
}

/** Suppress an unused-export lint when the route layer only imports this name. */
export type { GenerationQueueLike };

export class IngestService {
  constructor(private readonly deps: IngestServiceDeps) {}

  /**
   * Resolve or create the named corpus, mint an `ingest_requests` row so the
   * callback emitter has a persistent home for the batch's `apiKeyId` +
   * `callbackUrl` + progress bookkeeping, then enqueue one BullMQ job per
   * document. Returns the handle the consumer polls (or receives callbacks
   * against).
   */
  async ingestBatch(req: IngestRequest, ctx: IngestCtx): Promise<IngestResult> {
    const corpus = await this.resolveOrCreateCorpus(req.corpus, ctx, {
      ...(req.embeddingModel !== undefined ? { embeddingModel: req.embeddingModel } : {}),
      ...(req.language !== undefined ? { language: req.language } : {}),
    });

    // Persist an `ingest_requests` row up front. The `ingestId` returned to
    // the consumer is this row's id — every emitted callback's `ingestId`
    // resolves back here.
    const inserted = await this.deps.db
      .insert(ingestRequests)
      .values({
        org: ctx.org,
        project: ctx.project,
        apiKeyId: ctx.apiKeyId ?? null,
        corpus: req.corpus,
        corpusId: corpus.id,
        callbackUrl: req.callbackUrl ?? null,
        status: 'queued',
        totalDocs: req.documents.length,
        startedAt: new Date(),
      })
      .returning({ id: ingestRequests.id });
    const ingestId = inserted[0]!.id;

    for (const doc of req.documents) {
      const data: IngestJobData = {
        ingestId,
        corpusId: corpus.id,
        org: ctx.org,
        project: ctx.project,
        externalId: doc.id ?? null,
        text: doc.text,
        ...(doc.title !== undefined ? { title: doc.title } : {}),
        ...(doc.sourceUrl !== undefined ? { sourceUrl: doc.sourceUrl } : {}),
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
        ...(doc.validFrom !== undefined ? { validFrom: doc.validFrom } : {}),
        ...(doc.validTo !== undefined ? { validTo: doc.validTo } : {}),
        ...(doc.language !== undefined ? { language: doc.language } : {}),
        // Per-document config wins over the batch-level one. Resolved HERE so
        // the worker receives a single already-decided value and never has to
        // reason about precedence.
        ...(doc.chunkConfig ?? req.chunkConfig
          ? { chunkConfig: doc.chunkConfig ?? req.chunkConfig! }
          : {}),
      };
      await this.deps.queue.add(`${INGEST_QUEUE_NAME}:${ctx.org}`, data);
    }

    return {
      ingestId,
      corpusId: corpus.id,
      totalDocs: req.documents.length,
    };
  }

  /**
   * Compute status. With the `ingest_requests` row landed (callback contract
   * pass), we now report totals + failed counts directly from that row
   * instead of approximating from `documents`. Falls back to the old
   * `documents`-count approximation if the request row is missing (pre-
   * migration data).
   */
  async getIngestStatus(ingestId: string, ctx: IngestCtx): Promise<IngestStatus> {
    const reqRows = await this.deps.db
      .select()
      .from(ingestRequests)
      .where(
        and(
          eq(ingestRequests.id, ingestId),
          eq(ingestRequests.org, ctx.org),
          eq(ingestRequests.project, ctx.project),
        ),
      )
      .limit(1);
    if (reqRows[0]) {
      const r = reqRows[0];
      const status: IngestStatus['status'] =
        r.status === 'queued' || r.status === 'running'
          ? 'processing'
          : r.status;
      return {
        ingestId,
        totalDocs: r.totalDocs,
        completedDocs: r.completedDocs,
        failedDocs: r.failedDocs,
        status,
      };
    }
    // Legacy fallback — pre-migration ingests don't have an `ingest_requests`
    // row. Count `documents` rows by ingest_id (worker's old behaviour).
    const rows = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(
          eq(documents.ingestId, ingestId),
          eq(documents.org, ctx.org),
          eq(documents.project, ctx.project),
        ),
      );
    const completed = rows[0]?.count ?? 0;
    const totalDocs = completed;
    const failedDocs = 0;
    const status: IngestStatus['status'] =
      completed === 0 ? 'processing' : 'completed';
    return { ingestId, totalDocs, completedDocs: completed, failedDocs, status };
  }

  // -------------------------------------------------------------------------

  private async resolveOrCreateCorpus(
    name: string,
    ctx: IngestCtx,
    opts: { embeddingModel?: string; language?: string } = {},
  ): Promise<{ id: string }> {
    const existing = await this.deps.db
      .select({ id: corpora.id })
      .from(corpora)
      .where(
        and(
          eq(corpora.org, ctx.org),
          eq(corpora.project, ctx.project),
          eq(corpora.name, name),
        ),
      )
      .limit(1);
    // Existing corpus wins: its stored embedding model + text-search config are
    // authoritative (changing the model would invalidate its vectors), so the
    // wire fields are honoured ONLY on first creation.
    if (existing[0]) return { id: existing[0].id };

    // Model + dimension are config-driven (`env.EMBEDDING_MODEL` /
    // `env.EMBEDDING_DIM`) so a redeploy can move the default with no code
    // change; a per-request `embeddingModel` overrides at creation time.
    //
    // `resolveCorpusEmbeddingDim` refuses (throws
    // `EmbeddingDimensionMismatchError`, → 400 at the route) a KNOWN model whose
    // real dimension can't fit the live `chunks.embedding vector(N)` column —
    // otherwise the corpus would be born broken, every embed failing the
    // pgvector insert forever and retries piling up duplicate document rows. For
    // a known-good or unknown model it returns the dimension to STAMP (the
    // model's true dim when known, else the column width). The wire `language`
    // is a Postgres text-search config name; `resolveTextSearchConfig` keeps it
    // safe to cast `::regconfig` (defaults absent/unknown → `'simple'`).
    const model = opts.embeddingModel ?? env.EMBEDDING_MODEL;
    const embeddingDim = resolveCorpusEmbeddingDim(model, env.EMBEDDING_DIM);
    const inserted = await this.deps.db
      .insert(corpora)
      .values({
        org: ctx.org,
        project: ctx.project,
        name,
        embeddingModel: model,
        embeddingDim,
        chunkStrategy: 'recursive-char',
        chunkSize: 800,
        chunkOverlap: 100,
        textSearchConfig: resolveTextSearchConfig(opts.language),
      })
      .returning({ id: corpora.id });
    const row = inserted[0];
    if (!row) {
      throw new Error(`failed to create corpus '${name}' for ${ctx.org}/${ctx.project}`);
    }
    return { id: row.id };
  }
}
