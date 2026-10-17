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
// 🔴 These six shapes are NOT restated here any more. They are the wire
// contract, and the wire contract has exactly one home: `src/contract/`.
//
// `z.input`, NOT `z.infer`. The output view would mark every defaulted field
// (`topK`, `mode`, `rrfK` …) as REQUIRED, which is true of what arrives from a
// route — and false of every other caller. `fetchContext` and the retrieval
// tests call these services directly with `{ corpus, query }` and rely on the
// service applying its own fallback. `z.input` is exactly the shape these
// interfaces were hand-written as, so this substitution changes no types.
import type { z } from '../../contract/zod.js';
import type {
  chatTurnSchema,
  ingestDocumentSchema,
  ingestRequestSchema,
  retrieveMultiRequestSchema,
  retrieveRequestSchema,
  retrieveRewriteSchema,
} from '../../contract/rag.js';

/** `ingestDocumentSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type IngestDocument = z.input<typeof ingestDocumentSchema>;

/** `ingestRequestSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type IngestRequest = z.input<typeof ingestRequestSchema>;

/** What `/v1/ingest` returns immediately (work runs async — decision §14). */
export interface IngestResult {
  /** BullMQ job id for status polling via `GET /v1/ingest/:ingestId`. */
  ingestId: string;
  /** The corpus the docs landed in (created if it didn't exist). */
  corpusId: string;
  totalDocs: number;
}

/** `retrieveRequestSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type RetrieveRequest = z.input<typeof retrieveRequestSchema>;

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

/**
 * A retrieval leg — one independent source of candidate rows.
 *
 * `lexical` and `sparse` are BOTH lexical legs and they are different legs.
 * `lexical` is Postgres full-text search over `chunks.text_search`; `sparse` is
 * the learned-sparse (bge-m3) inner product over `chunks.sparse_embedding`.
 * They used to share the name `lexical` all the way to the wire, which is the
 * reason this type exists: their scores both land in `lexicalScore`, so a
 * response could not say which of the two produced it — or whether it produced
 * anything at all.
 *
 * `trigram` is a third lexical leg (pg_trgm word similarity over `chunks.text`),
 * opt-in via `HYBRID_LEXICAL_LEG=trigram`; its score also lands in `lexicalScore`.
 */
export type RetrievalLeg = 'dense' | 'lexical' | 'sparse' | 'trigram' | 'rerank';

/** What `/v1/retrieve` returns. */
export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /**
   * The legs that returned CANDIDATE rows — not the legs that were requested,
   * and not the legs whose rows survived into `chunks`.
   *
   * ⚠ The unit differs by leg, deliberately. `dense`, `lexical` and `sparse`
   * are recorded from how many rows the leg returned into the fusion POOL,
   * before RRF and before the final top-K slice. `rerank` is recorded from the
   * RESPONSE instead — how many returned chunks carry a `rerankScore` — because
   * the rerank rung has no pool of its own and reading the rows is the only
   * source that cannot drift from what the caller got. So `topK: 1` on a hybrid
   * retrieve whose lexical leg returned 50 rows that all lost the fusion still
   * reports `['dense','lexical']`, with a single dense chunk in `chunks`.
   *
   * Pool contribution is the signal worth having: a leg is ALIVE when it
   * produces candidates. Whether those candidates win slots is ranking, not
   * health, and a healthy leg losing every slot on one query is ordinary.
   *
   * ⚠ `/v1/retrieve` ONLY. `RetrieveMultiResult` below carries no `legs`, and
   * adding one is a separate, deferred lane — so a cross-corpus retrieve still
   * has no degradation signal at all, including for the rerank rung that runs
   * only there (once, after cross-corpus fusion).
   *
   * On this route, it is the field that makes retrieval degradation visible. A dead
   * reranker, an empty sparse column, a tsvector leg that was never
   * backfilled: each of those used to produce a perfectly ordinary-looking
   * 200 that was byte-identical to a response where the leg had simply not
   * been asked for. `legs` is the difference. `rerank` appears here only when
   * the cross-encoder really scored rows; if it timed out or the service was
   * down, the fail-safe returns the fused order and `rerank` is absent.
   *
   * ⚠ Read it as a SET, never by length or position. Today a hybrid retrieve
   * runs dense plus exactly ONE lexical leg — `SPARSE_ENABLED` chooses which —
   * so you will see `['dense','lexical']` or `['dense','sparse']` and never
   * both — plus `rerank` when the cross-encoder really scored rows, and MINUS
   * any leg that came back with zero rows, which is precisely the case this
   * field exists to expose. That is what runs today, not a promise: the declared next change
   * fuses dense + tsvector + sparse together, at which point three leg names
   * is a normal response. A client that hardcodes a length of 2, or reads
   * `legs[1]`, breaks on that release.
   */
  legs: RetrievalLeg[];
}

// ---------------------------------------------------------------------------
// Multi-corpus retrieval (`POST /v1/retrieve/multi`).
// ---------------------------------------------------------------------------

/** `chatTurnSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type ChatTurn = z.input<typeof chatTurnSchema>;

/** `retrieveRewriteSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type RetrieveRewrite = z.input<typeof retrieveRewriteSchema>;

/** `retrieveMultiRequestSchema` in `src/contract/rag.ts` — the request shape as sent. */
export type RetrieveMultiRequest = z.input<typeof retrieveMultiRequestSchema>;

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
  /**
   * Chunks this corpus won a slot for in the FINAL `chunks` array, after
   * fusion, the optional rerank and the `limit` cap.
   *
   * ⚠ `matched` says what the corpus FOUND; `contributed` says what survived.
   * `matched: 8, contributed: 0` is a corpus that was indexed, queried and
   * matched and then reached the caller with nothing — the fingerprint of the
   * cross-corpus fusion defect measured. It can also be
   * ordinary (a weaker corpus under a tight `limit`), which is why it is
   * reported rather than raised; it is also WARNED server-side under
   * `CORPUS_SHUTOUT_MESSAGE`.
   *
   * Additive and always present from this release on. Optional in the type so
   * an older ai-client compiled against the previous shape still type-checks.
   */
  contributed?: number;
}

/** What `/v1/retrieve/multi` returns. */
export interface RetrieveMultiResult {
  /** The query actually used for retrieval (rewritten iff `rewritten`). */
  query: string;
  /** Whether the rewrite step changed the query. */
  rewritten: boolean;
  chunks: MultiRetrievedChunk[];
  corpora: CorpusDiagnostics[];
  /**
   * Which cross-corpus ordering rule produced `chunks`.
   *
   *  • `cross-corpus-rrf` — `mode: 'hybrid'` over MORE THAN ONE corpus. The
   *    per-corpus RRF scores are rank-based and not comparable across corpora,
   *    so ranks are rebuilt over one global pool per leg and RRF is re-run.
   *    `score` on each chunk is that global RRF value (same scale as before:
   *    `Σ 1/(k + rank)` over at most two legs, same `k`).
   *  • `score` — a single corpus, or `mode: 'dense'` (where `score` is cosine
   *    against the same query vector and already comparable). Identical to the
   *    earlier behaviour.
   *
   * Additive; present from this release on. Optional in the type so an older
   * ai-client compiled against the previous shape still type-checks.
   */
  fusion?: 'score' | 'cross-corpus-rrf';
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
