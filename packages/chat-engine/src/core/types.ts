/**
 * Engine-owned, domain-neutral types. Deliberately free of product concepts:
 *   - attribution uses a generic `scopeId`, never a product's `projectId`
 *   - `orgId` stays (it is the generic tenant key in the auth contract)
 *   - ref kinds are an open `kind: string`, with the per-product registry
 *     supplying labels/glyphs/aliases (see KindRegistry).
 *
 * The engine never imports a backend SDK, payload, svelte, or any DOM. The only
 * outside seam is the injected `AIClient` (talk to ai-service) and the
 * per-product `DomainAdapter`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Context references — the shared primitive behind `@`-mentions (per-message)
// and the scope header (per-thread). A ref points at a domain entity; the
// adapter turns refs into injectable prompt text and powers search.
// ─────────────────────────────────────────────────────────────────────────────

/** A pointer at a domain entity. `kind` is open — the product's registry names it. */
export interface ContextRef {
  kind: string;
  id?: string | number;
  /**
   * Human label for the referenced entity (e.g. "Equipo de Diseño"). ADDITIVE
   * (≥0.3.0) and OPTIONAL: when a scope ref carries it, the `ContextHeader`
   * chip shows the real entity name instead of the `Kind #id` fallback. Older
   * persisted scopes omit it and keep rendering via the fallback / the
   * injected `resolveChipLabel` resolver — fully backward compatible.
   */
  label?: string;
}

/** The per-thread scope: a set of refs (empty/`org`-only = tenant-wide). */
export interface ContextScope {
  refs: ContextRef[];
}

/** A typeahead / picker hit. Domain-neutral; `kind` is registry-defined. */
export interface ContextSearchResult {
  kind: string;
  id: string | number;
  label: string;
  sublabel?: string;
  /** Owning scope (e.g. project/space) for downstream scoping/labelling. */
  scopeId?: string | number;
}

/** A persisted conversation turn, in the order the model should read it. */
export interface ChatHistoryRow {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** A resolved retrieval target: an ai-service corpus + the scope it belongs to. */
export interface ResolvedCorpus {
  corpus: string;
  /** Empty/undefined for tenant-level corpora (no single scope). */
  scopeId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation / provenance — what a turn cited, recorded on the assistant turn.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One retrieved chunk, tagged with the corpus it came from.
 *
 * ⚠ `score` is the server's RANKING score and its scale depends on the mode:
 * cosine in `dense` mode, Reciprocal Rank Fusion (~0.01–0.05) in `hybrid`
 * mode, the cross-encoder score when rerank ran. Never threshold or display
 * it; read `relevanceScore` / `maxDenseScore` (relevance.ts).
 */
export interface RetrievedChunk {
  documentId: string;
  chunkId: string;
  score: number;
  /**
   * Cosine similarity. ADDITIVE (0.6.0). ai-service sets it on every dense-mode
   * chunk (equal to `score`) and, in hybrid mode, only on chunks the dense leg
   * found. The stable similarity to threshold on in both modes.
   */
  denseScore?: number;
  /** Lexical (`ts_rank_cd`/sparse) score. ADDITIVE (0.6.0); hybrid lexical-leg hits only. */
  lexicalScore?: number;
  /** Cross-encoder score. ADDITIVE (0.6.0); present only when rerank ran. */
  rerankScore?: number;
  text: string;
  corpus: string;
  metadata?: Record<string, unknown> | null;
}

/** Provenance block persisted alongside an assistant turn. */
export interface Provenance {
  chunks: Array<{
    chunkId: string;
    documentId: string;
    /** Ranking score — scale depends on the retrieve mode. See `RetrievedChunk`. */
    score: number;
    corpus: string;
    metadata: Record<string, unknown> | null;
    /** Copied from `RetrievedChunk` when present. ADDITIVE (0.6.0). */
    denseScore?: number;
    /** Copied from `RetrievedChunk` when present. ADDITIVE (0.6.0). */
    lexicalScore?: number;
    /** Copied from `RetrievedChunk` when present. ADDITIVE (0.6.0). */
    rerankScore?: number;
    /**
     * The retrieved chunk's grounding passage. ADDITIVE (engine ≥0.3.0):
     * older provenance blocks omit it. Persisting it lets the canonical
     * citation card render the quoted `<blockquote>` without a second fetch.
     * The engine populates this from `RetrievedChunk.text` when
     * `buildChatTurn({ includePassageText: true })` is set (default on; opt
     * out to keep the legacy lean shape). May be truncated by the caller.
     */
    text?: string;
  }>;
}

/**
 * The domain-agnostic citation shape the canonical `CitationCard` renders.
 * Every product maps its provenance/citation rows to this before passing them
 * to the card; nothing here is product-specific.
 *
 * It is intentionally a SUPERSET-friendly, all-optional-but-`ordinal` shape so
 * a product with only `{chunkId, documentId, score}` still renders a useful
 * card (title falls back to a label, the passage/link simply don't show).
 *
 * Field provenance across the three products:
 *   - `ordinal`       1-based marker number (`[N]`). Required.
 *   - `title`         source document title (`metadata.title`, or the corpus
 *                     name as a fallback).
 *   - `passageText`   the quoted grounding passage (`Provenance.chunks[].text`).
 *   - `score`         data only, never rendered; its scale depends on the
 *                     retrieve mode (cosine, RRF or rerank). See `relevanceScore`.
 *   - `href`          a ready-made link to open the source asset. PREFER the
 *                     injected `linkResolver` on the card; `href` is the escape
 *                     hatch when the consumer already has the URL.
 *   - `documentId`/`chunkId`/`corpus`/`metadata` ride along for the link
 *                     resolver + keying; never rendered directly.
 */
export interface CitationLike {
  ordinal: number;
  title?: string | null;
  passageText?: string | null;
  score?: number | null;
  href?: string | null;
  documentId?: string | number | null;
  chunkId?: string | number | null;
  corpus?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AIClient seam — the narrow slice of the ai-service the engine needs.
// The engine accepts ANY object satisfying this; consumers inject a thin shim
// over `@edc/ai-client` (see `apps/web/src/lib/server/engine/aiClient.ts`).
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type SyncEffort = 'quick' | 'standard' | 'deep' | 'maximum';

export interface SyncGenerationRequest {
  /** Logical surface name — trace/usage attribution + prompt/model selection. */
  surface: string;
  orgId: string;
  /** Opaque scope tag for cost/observability attribution (was `projectId`). */
  scopeId?: string;
  userId: string;
  messages: SyncChatMessage[];
  effort?: SyncEffort;
  maxTokens?: number;
  temperature?: number;
  modelOverride?: string;
}

export interface SyncGenerationResult {
  text: string;
  parsed?: unknown;
  modelUsed: string;
  provider: string;
  costUsd: number;
  traceId: string;
  /**
   * Why the model stopped (`stop`, `length`, …), as ai-service reports it.
   * ADDITIVE (0.6.0); absent on a cache hit or an older server. Read it with
   * `shouldRetryEmpty`.
   */
  finishReason?: string;
}

export interface IngestRequest {
  orgId: string;
  /** Generic scope tag (was `projectId`). */
  scopeId: string;
  corpus: string;
  documents: Array<{
    id?: string;
    title?: string;
    text: string;
    metadata?: Record<string, unknown>;
  }>;
  /** ai-service callback for async ingest completion (forwarded as-is). */
  callbackUrl?: string;
}

export interface IngestResult {
  ingested: number;
  documentIds: string[];
  ingestId?: string;
}

export interface RetrieveRequest {
  orgId: string;
  /** Generic scope tag (was `projectId`). */
  scopeId: string;
  corpus: string;
  query: string;
  topK?: number;
  /**
   * Optional metadata equality filter forwarded to ai-service's `/v1/retrieve`
   * `filter` field (metadata `@>` jsonb). Each `(k,v)` narrows results to
   * chunks whose `metadata->>k = v::text`. Older ai-service builds ignore it;
   * the engine swallows a rejecting build's failure (→ `matches: []`).
   */
  filter?: Record<string, string | number | boolean>;
  /**
   * Ranking mode, forwarded to ai-service. ADDITIVE (0.6.0). Absent = the
   * server default, `dense`. In `hybrid` mode `score` is an RRF value, NOT a
   * cosine — read `denseScore` for a similarity.
   */
  mode?: RetrieveMode;
  /** Opt into cross-encoder reranking (server no-op when not wired). ADDITIVE (0.6.0). */
  rerank?: boolean;
}

/** ai-service ranking mode (ai-client 0.25.0 `RetrieveRequest.mode`). */
export type RetrieveMode = 'dense' | 'hybrid';

/** One match as ai-service returns it, before the engine tags its corpus. */
export interface RetrieveMatch {
  documentId: string;
  chunkId: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
  /** See `RetrievedChunk.denseScore`. ADDITIVE (0.6.0). */
  denseScore?: number;
  /** See `RetrievedChunk.lexicalScore`. ADDITIVE (0.6.0). */
  lexicalScore?: number;
  /** See `RetrievedChunk.rerankScore`. ADDITIVE (0.6.0). */
  rerankScore?: number;
}

export interface RetrieveResult {
  matches: RetrieveMatch[];
}

/**
 * One fan-out over several corpora, fused SERVER-side. ADDITIVE (0.6.0).
 * Mirrors ai-client 0.25.0 `RetrieveMultiRequest` with the engine's
 * scope-neutral naming (`scopeId`, not `projectId`); the consumer's shim maps
 * it, as it does for `retrieve`.
 */
export interface RetrieveMultiRequest {
  orgId: string;
  scopeId: string;
  /** Corpus names, all under the caller's `(orgId, scopeId)`. */
  corpora: string[];
  query: string;
  /** Per-corpus fetch depth. */
  topK?: number;
  /** Final cap on the fused, deduped result. */
  limit?: number;
  mode?: RetrieveMode;
  /** Applied to EVERY corpus — a key only one corpus carries empties the rest. */
  filter?: Record<string, string | number | boolean>;
  /** Cross-encoder rerank, applied once AFTER cross-corpus fusion. */
  rerank?: boolean;
}

/** Per-corpus outcome (ai-client 0.25.0 `CorpusDiagnostics`). */
export interface RetrieveMultiCorpusDiagnostics {
  corpus: string;
  /** Chunks this corpus contributed before fusion/cap. */
  matched: number;
  /** `not_found` (no such corpus in scope) or `failed` (its retrieve threw). */
  error?: 'not_found' | 'failed';
  /** Chunks that survived into the final `matches`. Absent on older servers. */
  contributed?: number;
}

/**
 * Result of `AIClient.retrieveMulti`. ADDITIVE (0.6.0). `matches` mirrors
 * ai-client's `chunks`, each tagged with its corpus, IN SERVER ORDER: in
 * hybrid mode over several corpora the server re-ranks one global pool
 * (`cross-corpus-rrf`), so its order is the only comparable one.
 */
export interface RetrieveMultiResult {
  matches: Array<RetrieveMatch & { corpus: string }>;
  corpora: RetrieveMultiCorpusDiagnostics[];
}

/**
 * The injected AI seam. NOTE the field names differ from `@edc/ai-client`'s
 * wire client (`projectId` vs `scopeId`); the consumer is responsible for the
 * thin shim that maps `scopeId → projectId` when wiring the real HttpAIClient.
 * Keeping the engine's seam scope-neutral is the whole point — the engine has
 * no notion of "project".
 */
export interface AIClient {
  generateSync(req: SyncGenerationRequest): Promise<SyncGenerationResult>;
  retrieve(req: RetrieveRequest): Promise<RetrieveResult>;
  ingest(req: IngestRequest): Promise<IngestResult>;
  /**
   * OPTIONAL (0.6.0). Server-side multi-corpus fan-out + fusion. Required for
   * a `hybrid` `RetrievalPolicy`: without it — or when the resolved corpora
   * span more than one `scopeId`, which one multi call cannot cover — the
   * engine warns `retrieve.multi_unavailable` and runs dense per corpus,
   * because per-corpus RRF scores are rank-based and cannot be merged
   * client-side.
   */
  retrieveMulti?(req: RetrieveMultiRequest): Promise<RetrieveMultiResult>;
}

/**
 * How `retrieveContext` retrieves. ADDITIVE (0.6.0). Absent = the pre-0.6.0
 * behaviour exactly: one dense `retrieve` per corpus (topK 5), merged by
 * score, capped at 8.
 */
export interface RetrievalPolicy {
  mode: RetrieveMode;
  /** Per-corpus fetch depth (`topK`). */
  perCorpusTopK: number;
  /** Final cap on the merged/fused result. */
  limit: number;
  /** Cross-encoder rerank (forwarded; the server no-ops when it is not wired). */
  rerank?: boolean;
}
