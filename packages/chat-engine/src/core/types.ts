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

/** One retrieved chunk, tagged with the corpus it came from. */
export interface RetrievedChunk {
  documentId: string;
  chunkId: string;
  score: number;
  text: string;
  corpus: string;
  metadata?: Record<string, unknown> | null;
}

/** Provenance block persisted alongside an assistant turn. */
export interface Provenance {
  chunks: Array<{
    chunkId: string;
    documentId: string;
    score: number;
    corpus: string;
    metadata: Record<string, unknown> | null;
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
 *   - `score`         relevance 0..1 (rendered as a %). Null/undefined hides it.
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
}

export interface RetrieveResult {
  matches: Array<{
    documentId: string;
    chunkId: string;
    score: number;
    text: string;
    metadata?: Record<string, unknown>;
  }>;
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
}
