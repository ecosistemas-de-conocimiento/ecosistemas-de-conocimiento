// RAG-layer types — shared shapes for ingest + retrieve workflows.
//
// These describe the public surface the wave-B routes (`/v1/ingest`,
// `/v1/retrieve`) will validate against and what the worker functions
// produce/consume internally. Kept in a single file so the M4 wiring agent
// can import from one place and the contract stays grep-able.
//
// References: plan/m3-m4-decisions.md §13 (JSON text-only ingest), §14
// (async via BullMQ), §15 (consumer-supplied `id` dedupe), §12 (vector +
// optional MMR).

import type { corpora } from '../../db/schema/index.js';

/**
 * A single document the consumer wants ingested. `id` (decision §15) is the
 * dedupe key inside the parent corpus when present; absent ⇒ always new.
 */
export interface IngestDocument {
  /** Consumer-supplied stable id. `(corpus, id)` collision ⇒ replace doc. */
  id?: string;
  /** Raw extracted text. Service does not parse PDFs/HTML (decision §13). */
  text: string;
  title?: string;
  sourceUrl?: string;
  /** Opaque consumer payload — service stores, never interprets. */
  metadata?: Record<string, unknown>;
  /**
   * Temporal validity, ISO-8601, half-open `[validFrom, validTo)`. Stamped
   * onto every chunk so `/v1/retrieve` can filter by `asOf` pre-ranking.
   * Both omitted ⇒ always valid (existing behaviour).
   */
  validFrom?: string;
  validTo?: string;
  /**
   * Per-document ISO-style language code (`'es'`, `'es-MX'`, `'en'`). Stored on
   * the document row for a future per-chunk stemming path. Does NOT drive the
   * lexical regconfig today — that is the PER-CORPUS `language` (see
   * `IngestRequest.language`), which IS live.
   */
  language?: string;
  /**
   * Per-document chunking configuration; overrides the batch-level one. See
   * `chunkConfigSchema` in `src/schemas/rag.ts` for the shape and
   * `parseStructuralConfig` for the validation.
   */
  chunkConfig?: Record<string, unknown>;
}

/** A `POST /v1/ingest` body. */
export interface IngestRequest {
  /** Corpus name (resolved to `corpora.id` server-side). */
  corpus: string;
  documents: IngestDocument[];
  /**
   * Override the embedding model when the corpus is FIRST created (rare).
   * Ignored for an already-existing corpus (its stored model is authoritative —
   * changing it would invalidate its vectors). Absent ⇒ `env.EMBEDDING_MODEL`.
   */
  embeddingModel?: string;
  /**
   * Corpus-level default language — an ISO-style code (`'es'`, `'es-MX'`,
   * `'en'`), mapped internally to a Postgres regconfig that DRIVES the lexical
   * leg's stemming. Applied only when the corpus is FIRST created. Absent ⇒
   * `'simple'`. See the schema doc in `src/schemas/rag.ts`.
   */
  language?: string;
  /**
   * Optional consumer webhook URL — see `plan/m3-webhook-signing-followup.md`.
   * Fires `ingest.completed` / `ingest.failed` per doc, plus `ingest.progress`
   * on batches >5 docs.
   */
  callbackUrl?: string;
  /**
   * Batch-level chunking configuration, applied to every document in the
   * request that does not carry its own. Absent ⇒ the corpus's strategy.
   */
  chunkConfig?: Record<string, unknown>;
}

/** What `/v1/ingest` returns immediately (work runs async — decision §14). */
export interface IngestResult {
  /** BullMQ job id for status polling via `GET /v1/ingest/:ingestId`. */
  ingestId: string;
  /** The corpus the docs landed in (created if it didn't exist). */
  corpusId: string;
  totalDocs: number;
}

/** A `POST /v1/retrieve` body. */
export interface RetrieveRequest {
  corpus: string;
  query: string;
  /** Top-K cosine matches. Defaults applied server-side. */
  topK?: number;
  /** Optional MMR lambda (0.5–0.7 typical) — decision §12. */
  mmr?: number;
  /**
   * Optional opaque jsonb-containment constraint on chunk `metadata`, applied
   * pre-ranking (plan/open-retrieve-metadata-filter.md). Absent/empty ⇒ no
   * filter (identical to today's corpus-only query). Service never interprets
   * the keys (ADR-0001).
   */
  filter?: Record<string, unknown>;
  /**
   * Point-in-time validity constraint (ISO-8601). Chunks whose
   * `[valid_from, valid_to)` interval excludes this instant are removed from
   * the candidate set BEFORE ranking. Unbounded chunks always qualify.
   */
  asOf?: string;
  /** `dense` (default, unchanged behaviour) or `hybrid` (dense + lexical, RRF-fused). */
  mode?: 'dense' | 'hybrid';
  /** RRF damping constant; default 60. Hybrid only. */
  rrfK?: number;
  /**
   * Opt into cross-encoder reranking: after retrieval (dense or hybrid+RRF), a
   * capped top-N pool is re-scored by a cross-encoder and re-ordered before the
   * final `slice(topK)`. Default off. A NO-OP unless the service has
   * `RERANK_ENABLED=true` and a configured `RERANK_URL` — so it degrades
   * silently to the un-reranked order on any environment where rerank isn't
   * wired, and it FAILS SAFE to the fused order on any rerank error/timeout.
   * Mutually exclusive with `mmr` (rerank wins if both are set).
   */
  rerank?: boolean;
  /** Override the rerank model for this request (A/B). Absent ⇒ `env.RERANK_MODEL`. Ignored unless `rerank`. */
  rerankModel?: string;
}

/** A single retrieved chunk row. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  ordinal: number;
  text: string;
  /**
   * Primary ranking score. In `dense` mode this is cosine similarity
   * (1 - distance), higher = more similar — unchanged. In `hybrid` mode it is
   * the RRF score, which lives on a completely different scale; use
   * `denseScore` if you need a comparable similarity.
   */
  score: number;
  /**
   * Cosine similarity, present when the dense leg surfaced this chunk. Always
   * present in `dense` mode (equal to `score`). Absent in `hybrid` mode for a
   * chunk that only the lexical leg found.
   */
  denseScore?: number;
  /** `ts_rank_cd` score, present when the lexical leg surfaced this chunk. */
  lexicalScore?: number;
  /**
   * Cross-encoder relevance score, present ONLY when `rerank` was applied to
   * this request. Typically a 0–1 sigmoid — a DIFFERENT scale again from the
   * RRF `score` (~0.01–0.05) and from cosine `denseScore`. ⚠ A consumer
   * thresholding on a score MUST switch to `rerankScore` when rerank is on.
   * When rerank is applied, `score` mirrors `rerankScore` so the primary
   * ranking field stays consistent with the ordering.
   */
  rerankScore?: number;
  /** 1-based rank within each leg that surfaced this chunk. Hybrid only; for debugging + evals. */
  ranks?: { dense?: number; lexical?: number };
  metadata?: Record<string, unknown>;
}

/** What `/v1/retrieve` returns. */
export interface RetrieveResult {
  chunks: RetrievedChunk[];
}

// ---------------------------------------------------------------------------
// Multi-corpus retrieval (`POST /v1/retrieve/multi`).
// ---------------------------------------------------------------------------

/** A conversation turn used by the rewrite step (oldest → newest). */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Consumer-owned rewrite directive. The service supplies the MECHANISM (cheap
 * LLM call + sanitize + fail-safe); the consumer supplies ALL natural language.
 */
export interface RetrieveRewrite {
  /** System instruction for the rewrite. All locale/wording lives here. */
  instruction: string;
  /** Turns excluding the current question. Empty/absent ⇒ no rewrite. */
  history?: ChatTurn[];
  /** Rewrite output token cap. Default 80. */
  maxTokens?: number;
}

/** A `POST /v1/retrieve/multi` body. */
export interface RetrieveMultiRequest {
  /** Corpus names, all under the caller's `(org, project)`. */
  corpora: string[];
  query: string;
  /** Per-corpus fetch depth (default 10). */
  topK?: number;
  /** Final cap on the fused result (default `topK`). */
  limit?: number;
  mmr?: number;
  filter?: Record<string, unknown>;
  asOf?: string;
  mode?: 'dense' | 'hybrid';
  rrfK?: number;
  /**
   * Opt into cross-encoder reranking, applied AFTER cross-corpus fusion over a
   * capped top-N pool of the fused candidates (not per corpus). No-op unless
   * the server has rerank wired; fails safe to the fused order. Mutually
   * exclusive with `mmr` (rerank wins — `mmr` is not forwarded to the legs).
   */
  rerank?: boolean;
  /** Override the rerank model for this request (A/B). Absent ⇒ `env.RERANK_MODEL`. Ignored unless `rerank`. */
  rerankModel?: string;
  /** Optional query-condensation directive. */
  rewrite?: RetrieveRewrite;
}

/** A fused chunk, carrying the corpus it was retrieved from (for citations). */
export interface MultiRetrievedChunk extends RetrievedChunk {
  corpus: string;
}

/** Per-corpus outcome. `error` set ⇒ that corpus contributed no chunks. */
export interface CorpusDiagnostics {
  corpus: string;
  /** Chunks this corpus contributed before fusion/cap. */
  matched: number;
  /** `not_found` (no such corpus in scope) or `failed` (retrieve threw). */
  error?: 'not_found' | 'failed';
}

/** What `/v1/retrieve/multi` returns. */
export interface RetrieveMultiResult {
  /** The query actually used for retrieval (rewritten iff `rewritten`). */
  query: string;
  /** Whether the rewrite step changed the query. */
  rewritten: boolean;
  chunks: MultiRetrievedChunk[];
  corpora: CorpusDiagnostics[];
}

/**
 * Convenience subset of the `corpora` Drizzle row — the fields the RAG layer
 * code actually reads. Keeps callers from pulling the full row type through
 * the type system when all they need is the embedding/chunking config.
 */
export type CorpusRow = Pick<
  typeof corpora.$inferSelect,
  | 'id'
  | 'org'
  | 'project'
  | 'name'
  | 'embeddingModel'
  | 'embeddingDim'
  | 'chunkStrategy'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'textSearchConfig'
>;
