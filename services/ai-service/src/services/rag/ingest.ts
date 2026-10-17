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
import { chunks, corpora, documents, ingestJobs, ingestRequests } from '../../db/schema/index.js';
import { CodedEnvelopeError } from '../../errors/base.js';
import type {
  GenerationQueueLike,
} from '../../queue/queues.js';
import {
  INGEST_QUEUE_NAME,
  type IngestJobData,
  type IngestQueueLike,
} from '../../queue/queues.js';
import { assertCallbackSecretFor } from '../callbacks/emit.js';
import { assertSafeCallbackUrl } from '../callbacks/url-guard.js';
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

export interface IngestStatusDocument {
  /** The consumer's document id when it sent one, else ai-service's — the same `docId` the callbacks carry. */
  docId: string;
  /** Chunks indexed for this document. 0 means nothing is retrievable. */
  chunkCount: number;
}

export interface IngestStatus {
  ingestId: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'processing' | 'completed' | 'partial' | 'failed';
  /** Sum of `documents[].chunkCount`. Present once the batch is terminal. */
  chunkCount?: number;
  /** One entry per indexed document of this batch. Present once the batch is terminal. */
  documents?: IngestStatusDocument[];
}

/**
 * 404 for `GET /v1/ingest/:ingestId` when no ingest with that id exists in the
 * caller's (org, project) — including ids that are not UUIDs at all.
 *
 * Plan finding A11: this used to answer 200 `status: 'processing'` with zero
 * counts, so a consumer polling an id it had lost (or a typo) waited forever.
 * Reconcilers poll this route, so "never existed" must be distinguishable
 * from "still running".
 */
export class IngestNotFoundError extends CodedEnvelopeError {
  readonly code = 'ERR_INGEST_NOT_FOUND';
  readonly status = 404;
  override name = 'IngestNotFoundError';
  constructor(readonly ingestId: string) {
    super(`ingest '${ingestId}' not found in this org/project`);
  }
  protected override bodyFields(): Record<string, unknown> {
    return { ingestId: this.ingestId };
  }
}

/** `ingest_requests.id` is a uuid column; anything else can never match. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // SSRF guard (audit finding [HIGH] SSRF): refuse loopback/private/
    // link-local/metadata targets BEFORE persisting the request row, so a
    // hostile callbackUrl never enters the delivery pipeline. The route maps
    // `CallbackUrlBlockedError` to a 400.
    if (req.callbackUrl) {
      // D4=A (PLAN-live-ingest): a callbackUrl from a key that
      // cannot sign is refused with 400 `CallbackSecretMissingError` instead of
      // a 202 whose every callback is recorded `auth_failed`.
      assertCallbackSecretFor(ctx.apiKeyId);
      await assertSafeCallbackUrl(req.callbackUrl);
    }

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

    // One `ingest_jobs` row per document, INSERTED BEFORE THE JOB IS QUEUED.
    // That ordering is the whole mechanism: the worker claims this row with a
    // conditional UPDATE (`WHERE status = 'queued'`) before it chunks or
    // embeds anything, so a stalled re-delivery of the same BullMQ job finds
    // nothing to claim and returns without a second embedding charge. A row
    // written after the add would leave a window where the worker is already
    // running with nothing to claim.
    //
    // One INSERT for the whole batch (≤100 docs, capped by the request schema).
    // `RETURNING` on a multi-row INSERT comes back in VALUES order, which is
    // what pairs each id with its document below.
    // (`documents` is `.min(1)` at the route; the guard is for direct callers —
    // drizzle throws on an empty VALUES list.)
    const jobRows = req.documents.length === 0 ? [] : await this.deps.db
      .insert(ingestJobs)
      .values(
        req.documents.map((doc) => ({
          org: ctx.org,
          project: ctx.project,
          ingestId,
          externalId: doc.id ?? null,
          status: 'queued' as const,
        })),
      )
      .returning({ id: ingestJobs.id });

    for (const [i, doc] of req.documents.entries()) {
      const data: IngestJobData = {
        ingestId,
        jobId: jobRows[i]!.id,
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
   * Compute status from the `ingest_requests` row. Falls back to counting
   * `documents` rows for pre-migration ingests that have no request row.
   *
   * Throws `IngestNotFoundError` (404) when neither exists in the caller's
   * (org, project), or when `ingestId` is not a UUID.
   *
   * Once the batch is terminal the snapshot also carries per-document
   * `chunkCount`s: a consumer reconciling a lost callback needs the same
   * "how much got indexed" fact the `ingest.completed` envelope carries.
   * Computed only for terminal batches, so a poll loop on a running batch
   * stays one indexed lookup.
   */
  async getIngestStatus(ingestId: string, ctx: IngestCtx): Promise<IngestStatus> {
    if (!UUID_RE.test(ingestId)) throw new IngestNotFoundError(ingestId);
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
      if (r.status === 'queued' || r.status === 'running') {
        return {
          ingestId,
          totalDocs: r.totalDocs,
          completedDocs: r.completedDocs,
          failedDocs: r.failedDocs,
          status: 'processing',
        };
      }
      const docs = await this.documentChunkCounts(ingestId, ctx);
      return {
        ingestId,
        totalDocs: r.totalDocs,
        completedDocs: r.completedDocs,
        failedDocs: r.failedDocs,
        status: r.status,
        chunkCount: docs.reduce((n, d) => n + d.chunkCount, 0),
        documents: docs,
      };
    }
    // Legacy fallback — pre-migration ingests don't have an `ingest_requests`
    // row. Their `documents` rows are the only evidence they existed.
    const docs = await this.documentChunkCounts(ingestId, ctx);
    if (docs.length === 0) throw new IngestNotFoundError(ingestId);
    return {
      ingestId,
      totalDocs: docs.length,
      completedDocs: docs.length,
      failedDocs: 0,
      status: 'completed',
      chunkCount: docs.reduce((n, d) => n + d.chunkCount, 0),
      documents: docs,
    };
  }

  /**
   * Per-document chunk counts for the documents whose latest ingest is
   * `ingestId`. A document re-ingested by a LATER batch moves to that batch
   * (the worker re-stamps `documents.ingest_id`), so it is reported there.
   */
  private async documentChunkCounts(
    ingestId: string,
    ctx: IngestCtx,
  ): Promise<IngestStatusDocument[]> {
    const rows = await this.deps.db
      .select({
        id: documents.id,
        externalId: documents.externalId,
        chunkCount: sql<number>`count(${chunks.id})::int`,
      })
      .from(documents)
      .leftJoin(chunks, eq(chunks.documentId, documents.id))
      .where(
        and(
          eq(documents.ingestId, ingestId),
          eq(documents.org, ctx.org),
          eq(documents.project, ctx.project),
        ),
      )
      .groupBy(documents.id, documents.externalId);
    return rows.map((r) => ({ docId: r.externalId ?? r.id, chunkCount: Number(r.chunkCount) }));
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
