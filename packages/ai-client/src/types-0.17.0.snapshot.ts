// FROZEN SNAPSHOT — the public wire types as `@edc/ai-client@0.17.0`
// shipped them, taken verbatim from `git show b903699:packages/ai-client/src/types.ts`
// plus the two provisioning request interfaces that lived in `tenant.ts` at the
// same commit.
//
// DO NOT EDIT and DO NOT "keep up to date". Its whole job is to stop moving:
// `types-compat.test.ts` proves every name 0.18.0 still publishes is MUTUALLY
// assignable with the 0.17.0 declaration of it, in both directions, so the
// switch from hand-written types to contract-generated ones cannot have been a
// breaking change for a consumer already on 0.17.0. A snapshot that tracks the
// current types proves nothing.
//
// Excluded from the published build (see `tsconfig.json`); the root
// `npm run typecheck` still checks it, which is where the proof actually runs.

// Public type surface for the @edc/ai-client package.
//
// Hand-written to mirror the wire shapes documented in the ai-service
// OpenAPI spec (`/v1/openapi.json`). The types deliberately re-declare what
// ai-service's internal types look like — importing across the workspace
// boundary would create a circular dep (ai-service ships the spec; the
// client consumes the spec; the client must not depend on ai-service's TS).
//
// Keep these aligned with `src/schemas/*` and `src/types/generation.ts` in
// ai-service whenever the wire contract evolves.

// ---------------------------------------------------------------------------
// Generation surface
// ---------------------------------------------------------------------------

export type EffortLevel = 'quick' | 'standard' | 'deep' | 'maximum';

/** A validator entry is either a builtin name (string) or an inline rule. */
export type Validator = string | { type: string; [k: string]: unknown };

export interface InlineSpecOverride {
  promptTemplate?: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  effortLevel?: EffortLevel;
  effortProfile?: Record<string, unknown>;
  responseSchema?: unknown;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
}

/**
 * Same shape as {@link InlineSpecOverride}, opposite precedence. Aliased rather
 * than duplicated so the two slots can never drift apart.
 */
export type InlineSpecDefault = InlineSpecOverride;

export interface Unit {
  unitKey: string;
  unitType?: string;
  input?: Record<string, unknown>;
  dependsOn?: Record<string, string>;
  /**
   * Per-unit spec **CEILING** — nothing can reconfigure what it sets, not even
   * a registered `registry_entries` row for the unit-type.
   *
   * ⚠ This is the WRONG slot for a default you ship. A built-in prompt sent
   * here makes the project's registered row resolve and then be discarded, with
   * no error anywhere. Use {@link Unit.specDefault} for built-ins.
   */
  specOverride?: InlineSpecOverride;
  /**
   * Per-unit spec **FLOOR** — consulted only after the active
   * `registry_entries` row, so registering the unit-type WINS over it.
   *
   * This is where a built-in belongs: a default prompt / effort tier /
   * response schema that must work with zero registry config while leaving a
   * project free to take ownership. Fields left unset fall through the rest of
   * the precedence chain exactly as if the floor were absent, and unlike
   * `specOverride` it does not suppress registry provenance on the trace.
   *
   * ⚠ Requires an ai-service that publishes the `specDefaultSlot` capability.
   * The unit schema is strict, so an older deployment answers `400` on the
   * unknown key. Assert it at boot with
   * `client.capabilities.negotiate({ require: ['specDefaultSlot'], ... })`.
   */
  specDefault?: InlineSpecDefault;
  /**
   * Per-unit **system prompt**. Reaches the model as a real
   * `{ role: 'system' }` message ahead of the rendered user prompt — this is
   * the supported replacement for hand-folding standing instructions into
   * `input.userPrompt`.
   *
   * Literal text: it is NOT rendered as a Handlebars template, so an embedded
   * JSON schema or brace-heavy output contract survives byte-for-byte.
   *
   * Precedence (highest first): `unit.systemPrompt` →
   * `unit.specOverride.metaPromptTemplate` → request `systemPromptOverride` →
   * the registry entry's `metaPromptTemplate`. Supply none and no `system`
   * message is sent at all.
   *
   * Requires an ai-service deployment carrying system-prompt support. Verify
   * with `SyncResult.systemPromptApplied` before trusting it in production.
   */
  systemPrompt?: string;
}

export type IncludeContextItem =
  | {
      corpus: string;
      query: string;
      topK?: number;
      mmr?: number;
    }
  | { name: string };

export interface GenerateRequest {
  units: Unit[];
  effortLevel?: EffortLevel;
  promptOverride?: string;
  modelOverride?: string;
  /** Batch-wide system prompt; a unit's own `systemPrompt` wins over it. */
  systemPromptOverride?: string;
  effortOverrides?: Record<string, Record<string, unknown>>;
  includeContext?: IncludeContextItem[];
  clientRequestId?: string;
  callbackUrl?: string;
  requestedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateSyncRequest {
  unit: Unit;
  effortLevel?: EffortLevel;
  modelOverride?: string;
  /** Same semantics as on `GenerateRequest`; loses to `unit.systemPrompt`. */
  systemPromptOverride?: string;
  includeContext?: IncludeContextItem[];
  requestedBy?: string;
}

/** Top-level advisory flag returned alongside any budget-reserving response.
 *  Today only emits `BUDGET_SOFT_CAP`; treat unknown codes as informational. */
export interface ResponseWarning {
  code: string;
  message: string;
}

export interface LaunchGenerationResult {
  requestId: string;
  channel: string;
  totalJobs: number;
  estimatedCostUsd: number;
  /** Optional advisory flags (e.g. soft budget cap). Absent when none fired. */
  warnings?: ResponseWarning[];
}

export interface SyncResult {
  text: string;
  parsed?: unknown;
  modelUsed: string;
  provider: string;
  costUsd: number;
  traceId: string;
  /**
   * `true` when a real `system` message was sent to the model on this call.
   *
   * This is the migration safety net: assert `res.systemPromptApplied === true`
   * right after you move off a hand-folded system prompt. An ai-service
   * deployment that predates system-prompt support omits the field entirely, so
   * the assertion fails LOUDLY instead of the model quietly losing your
   * instructions and returning junk that still parses.
   */
  systemPromptApplied?: boolean;
  /**
   * Token counts for this call. See {@link GenerationUsage}.
   *
   * ABSENT when the provider reported no counts — deliberately, so a credits
   * meter falls back to its own estimate rather than billing an
   * authoritative-looking zero. Also absent from an ai-service deployment that
   * predates the shared wire projection.
   *
   * Same field, same omission rules, as the stream's `done` frame
   * ({@link GenerateStreamDone}): both routes are built from one projection
   * server-side, which is what makes "same payload as /sync" true.
   */
  usage?: GenerationUsage;
  /**
   * Why the provider stopped (`stop`, `length`, …), forwarded verbatim and
   * only when the provider supplied one. Not an enum on purpose: the value is
   * provider vocabulary and normalising it here would invent a contract
   * ai-service does not enforce.
   */
  finishReason?: string;
  warnings?: ResponseWarning[];
}

/**
 * Token counts as ai-service puts them on the wire (`projectWireUsage` in
 * `services/generation/wire-projection.ts`).
 *
 * The whole object is ABSENT when the provider reported no counts at all —
 * deliberately, so a consumer metering credits falls back to its own estimate
 * instead of billing an authoritative-looking zero. `outputTokens` is the only
 * member that is always present when the object is; the others appear only
 * when positive.
 */
export interface GenerationUsage {
  outputTokens: number;
  inputTokens?: number;
  totalTokens?: number;
}

/** One token chunk from `POST /v1/generate/stream`. */
export interface GenerateStreamDelta {
  type: 'delta';
  text: string;
}

/**
 * Terminal frame of `POST /v1/generate/stream`.
 *
 * Contractually the SAME payload as `/v1/generate/sync` — both are built from
 * one shared projection server-side — plus the `type` discriminator.
 *
 * ⚠ `text` is AUTHORITATIVE. It is not always the concatenation of the deltas:
 * a cache hit emits no deltas at all and delivers the whole answer here.
 */
export interface GenerateStreamDone {
  type: 'done';
  text: string;
  parsed?: unknown;
  modelUsed: string;
  provider: string;
  costUsd: number;
  /** Absent when the provider reported no token counts. See {@link GenerationUsage}. */
  usage?: GenerationUsage;
  finishReason?: string;
  traceId: string;
  /** See {@link SyncResult.systemPromptApplied} — same migration safety net. */
  systemPromptApplied?: boolean;
  warnings?: ResponseWarning[];
}

/**
 * A frame yielded by `client.generate.stream(...)`.
 *
 * Terminal `error` frames are NOT in this union: they are thrown as the typed
 * error classes instead, so a stream failure is caught the same way a `/sync`
 * failure is.
 */
export type GenerateStreamFrame = GenerateStreamDelta | GenerateStreamDone;

export type GenerationRequestStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GenerationJobState {
  unitKey: string;
  unitType: string | null;
  status: GenerationJobStatus;
  output: unknown;
  error: string | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  registryEntryId: string | null;
  traceId: string | null;
  finishedAt: string | null;
}

export interface GenerationRequestState {
  requestId: string;
  status: GenerationRequestStatus;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  units: GenerationJobState[];
}

export interface CancelResult {
  cancelled: boolean;
  removedJobs: number;
  alreadyCancelled?: boolean;
  /**
   * Jobs that were still `running` because their WORKER DIED, and that this
   * cancel settled. A sibling count, never folded into `removedJobs` — that
   * field has always meant "removed from the queue", and there is nothing left
   * in the queue to remove for these. Absent when there were none, so a client
   * built before this field sees exactly the response it has always seen.
   */
  lostJobs?: number;
}

// ---------------------------------------------------------------------------
// Registry surface
// ---------------------------------------------------------------------------

export interface ProjectConfigPatch {
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  effortProfiles?: Record<string, unknown> | null;
  contextRules?: Record<string, unknown> | null;
  callbackUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProjectConfigResponse {
  id: string;
  org: string;
  project: string;
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  effortProfiles: unknown;
  contextRules: unknown;
  callbackUrl: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RegistryEntryCreate {
  version: string;
  promptTemplate: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  defaultEffort?: EffortLevel | null;
  effortProfiles?: Record<string, unknown> | null;
  responseSchema?: Record<string, unknown> | null;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
  metadata?: Record<string, unknown> | null;
  activate?: boolean;
}

export interface RegistryEntry {
  id: string;
  org: string;
  project: string;
  unitType: string;
  version: string;
  isActive: boolean;
  promptTemplate: string;
  metaPromptTemplate: string | null;
  model: string | null;
  defaultEffort: EffortLevel | null;
  effortProfiles: unknown;
  responseSchema: unknown;
  validators: unknown;
  renderer: string | null;
  contentKind: string | null;
  createdBy: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface UnitTypeSummary {
  unitType: string;
  activeVersion: string | null;
  versionCount: number;
}

// ---------------------------------------------------------------------------
// RAG surface
// ---------------------------------------------------------------------------

export interface IngestDocument {
  id?: string;
  text: string;
  title?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * Chunking configuration for THIS document, overriding the batch-level one.
   * This is the granularity that usually matters: one corpus routinely mixes
   * documents with a numbered structure and documents that are ordinary prose.
   * See `ChunkConfig`.
   */
  chunkConfig?: ChunkConfig;
  /**
   * Temporal validity of this document as a half-open interval
   * `[validFrom, validTo)`, ISO-8601. Omit a side for "unbounded"; omit both
   * for "always valid" (the default, and the behaviour before these fields
   * existed).
   *
   * Set these when the corpus contains content that can be superseded — a
   * statute replaced by a later edition, a policy version, a price list — and
   * pass `asOf` on retrieve. Chunks outside the interval are then dropped from
   * the candidate set BEFORE ranking, so a superseded passage cannot reach the
   * generator at all.
   *
   * To retire an ALREADY-INGESTED document, use
   * `client.admin.setDocumentValidity(...)` — it writes the same bounds
   * without re-embedding anything.
   */
  validFrom?: string;
  validTo?: string;
  /**
   * Per-document Postgres text-search config name (`'spanish'`, `'english'`,
   * `'simple'`, …). Stored on the document for a future per-chunk stemming path;
   * it does NOT change lexical stemming today — that is set per-CORPUS via
   * `IngestRequest.language` (which IS live). An unknown name is rejected at
   * ingest. Optional and additive — omit it and nothing changes.
   */
  language?: string;
}

export interface IngestRequest {
  corpus: string;
  documents: IngestDocument[];
  /**
   * Embedding model applied only when the corpus is FIRST created; ignored for
   * an existing corpus. Omit to use the service default (an open multilingual
   * 1024-dim model).
   */
  embeddingModel?: string;
  /**
   * Corpus-level default language — a Postgres text-search config (`regconfig`)
   * name DIRECTLY: `'spanish'`, `'english'`, `'simple'`, … (not an ISO locale
   * code). DRIVES the lexical leg's stemming. Applied only when the corpus is
   * FIRST created (use `client.corpora.create`/`update` for explicit control);
   * an unknown name is rejected at ingest. Optional and additive.
   */
  language?: string;
  /**
   * Optional consumer-side webhook URL. Required if the consumer wants
   * `ingest.completed` / `ingest.failed` / `ingest.progress` events for
   * this batch — without it the consumer must poll `client.ingest.status()`.
   * See `plan/tecnología/ai-infra/callback-contract.md`.
   */
  callbackUrl?: string;
  /**
   * Chunking configuration for every document in this batch that does not
   * carry its own. See `ChunkConfig`.
   */
  chunkConfig?: ChunkConfig;
}

/** One level of document structure to split on. `pattern` is JS regex source. */
export interface ChunkSectionPattern {
  /**
   * Metadata key the captured identifier is stored under. It lands on each
   * chunk as `metadata[key]`, underneath your own document metadata, so a key
   * you also use in `metadata` always wins.
   */
  key: string;
  /** Regex SOURCE (not a literal). `gm` are forced on. Capture group 1 = the identifier. */
  pattern: string;
  /** Extra regex flags; `i` is the usual one. `g` and `m` are always added. */
  flags?: string;
}

/**
 * Split a document at its OWN headings instead of at an arbitrary token
 * window, so a retrieved chunk corresponds to one addressable, citable unit.
 *
 * YOU own these patterns. ai-service ships no named presets on purpose: the
 * patterns describe what your documents look like, which is your domain, not
 * the shared service's (ADR-0001). Send the same config on every re-ingest of
 * the same documents.
 *
 * ```ts
 * chunkConfig: {
 *   sections: [{ key: 'section', pattern: String.raw`^\s*Section\s+(\d+)\b`, flags: 'i' }],
 *   subSections: [{ key: 'clause', pattern: String.raw`^\s*([IVX]+)[.)]\s` }],
 * }
 * ```
 *
 * An unusable config — or one that matches no boundary in a given document —
 * falls back to the corpus's default splitter with a server-side warning
 * rather than failing the ingest.
 */
export interface ChunkConfig {
  /** Primary split level: one chunk per match, subject to `maxChars`. Required. */
  sections: ChunkSectionPattern[];
  /**
   * Secondary split level, used ONLY to break up a primary section that
   * exceeds `maxChars`, so an oversize section still splits at a meaningful
   * boundary rather than mid-sentence.
   */
  subSections?: ChunkSectionPattern[];
  /** Hard ceiling per chunk, in characters. Default 4000. */
  maxChars?: number;
  /**
   * Below this many characters an UNIDENTIFIED span (a preamble, a bare
   * heading line) is merged into the previous chunk instead of standing alone.
   * Default 80. A span that carries its own identifier is never merged, however
   * short — folding a one-line section into its predecessor would attach it to
   * the wrong identifier.
   */
  minChars?: number;
}

export interface IngestResult {
  ingestId: string;
  corpusId: string;
  totalDocs: number;
}

export interface IngestStatus {
  ingestId: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'processing' | 'completed' | 'partial' | 'failed';
}

// ---------------------------------------------------------------------------
// Corpus control plane (client.corpora)
// ---------------------------------------------------------------------------

/** Corpus config knobs shared by create + update (all optional on both). */
export interface CorpusConfig {
  /**
   * Embedding model to stamp on the corpus. Validated against its known vector
   * dimension server-side. Omit ⇒ the service default. Changing it after data
   * has landed is refused (would invalidate the stored vectors).
   */
  embeddingModel?: string;
  /**
   * Lexical text-search config — a Postgres `regconfig` name directly
   * (`'spanish'`, `'english'`, `'simple'`, …). Drives stemming on the hybrid
   * retrieve leg. Omit on create ⇒ `'simple'`.
   */
  language?: string;
  /** Chunking strategy id. Omit on create ⇒ `'recursive-char'`. */
  chunkStrategy?: string;
  /** Target chunk size. Omit on create ⇒ 800. */
  chunkSize?: number;
  /** Chunk overlap. Omit on create ⇒ 100. */
  chunkOverlap?: number;
  /** Strategy-specific options — see `ChunkConfig`. */
  chunkConfig?: ChunkConfig;
  /** Opaque consumer metadata stored on the corpus row. */
  metadata?: Record<string, unknown>;
}

export interface CorpusCreateRequest extends CorpusConfig {
  /** Corpus name, unique within your `(org, project)`. */
  name: string;
}

/** Update is `CorpusConfig` (every field optional); the route rejects an empty body. */
export type CorpusUpdateRequest = CorpusConfig;

/** Introspection view of a corpus — returned by create/get/update and, in an array, by list. */
export interface Corpus {
  name: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Postgres text-search config name (regconfig) — the `language` you sent. */
  language: string;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  chunkConfig: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  documentCount: number;
  chunkCount: number;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null if never reconfigured. */
  updatedAt: string | null;
  /**
   * Present ONLY when the name you queried was an ALIAS: the fields above are
   * the TARGET corpus's, and `alias.target` names the target.
   */
  alias?: { name: string; target: string };
}

export interface DeleteCorpusResult {
  deleted: {
    chunks: number;
    documents: number;
    corpora: number;
  };
}

export interface RetrieveRequest {
  corpus: string;
  query: string;
  topK?: number;
  mmr?: number;
  /**
   * Opaque metadata constraint applied BEFORE ranking: a chunk matches when
   * its stored `metadata` contains every key/value pair given here (jsonb
   * containment). The service never interprets the keys.
   *
   * jsonb is type-sensitive — `{ k: 5 }` will not match a stored `"5"`.
   */
  filter?: Record<string, unknown>;
  /**
   * Point-in-time constraint, ISO-8601. Only chunks whose
   * `[validFrom, validTo)` interval contains this instant are eligible.
   * Chunks with no validity bounds are always eligible, so adding `asOf` to a
   * corpus that never sets validity changes nothing.
   *
   * Applied as a SQL predicate on the candidate set alongside `filter`, so a
   * superseded chunk cannot displace a current one or appear in the result.
   */
  asOf?: string;
  /**
   * Ranking mode. `dense` (the default) is cosine top-K over the embedding
   * index — unchanged from before this field existed. `hybrid` also runs a
   * lexical full-text leg and fuses the two with Reciprocal Rank Fusion.
   *
   * Use `hybrid` when queries contain exact identifiers — article numbers,
   * norm codes, indicator ids, SKUs — which dense embeddings systematically
   * miss. ⚠ In `hybrid` mode `score` is an RRF score (typically 0.01–0.05),
   * NOT a cosine similarity: if you threshold on `score`, read `denseScore`
   * instead.
   */
  mode?: 'dense' | 'hybrid';
  /** RRF damping constant, default 60. Hybrid only; for eval sweeps. */
  rrfK?: number;
  /**
   * Opt into cross-encoder reranking: after retrieval (dense or hybrid+RRF), a
   * capped top-N pool is re-scored by a cross-encoder and re-ordered before the
   * final top-K, surfacing `rerankScore` on each chunk.
   *
   * A NO-OP unless the SERVER has rerank wired (`RERANK_ENABLED` + `RERANK_URL`)
   * — so on an environment where rerank isn't configured, `rerank: true`
   * degrades silently to the un-reranked order. It also fails safe to that
   * order on any rerank error/timeout. Mutually exclusive with `mmr` (rerank
   * wins if both are set).
   *
   * ⚠ When rerank is on, `score` is the cross-encoder score (typically a 0–1
   * sigmoid), a different scale again from RRF and cosine — threshold on
   * `rerankScore` (equal to `score` here), not `denseScore`.
   */
  rerank?: boolean;
  /** Override the rerank model for this request (A/B). Absent ⇒ the server's `RERANK_MODEL`. Ignored unless `rerank`. */
  rerankModel?: string;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  ordinal: number;
  text: string;
  /**
   * Primary ranking score. Cosine similarity in `dense` mode; an RRF score in
   * `hybrid` mode — see `RetrieveRequest.mode`.
   */
  score: number;
  /**
   * Cosine similarity. Always present in `dense` mode (equal to `score`);
   * present in `hybrid` mode only for chunks the dense leg surfaced. This is
   * the field to threshold on if you need a stable similarity in both modes.
   */
  denseScore?: number;
  /** Lexical (`ts_rank_cd`) score; hybrid mode, lexical-leg hits only. */
  lexicalScore?: number;
  /**
   * Cross-encoder relevance score, present ONLY when `rerank` was applied.
   * Typically a 0–1 sigmoid — a different scale again from the RRF `score` and
   * cosine `denseScore`. When present, `score` mirrors it; threshold on this.
   */
  rerankScore?: number;
  /** 1-based per-leg ranks. Hybrid mode only; for debugging and evals. */
  ranks?: { dense?: number; lexical?: number };
  metadata?: Record<string, unknown>;
}

/** Result of `admin.setDocumentValidity`. */
export interface SetDocumentValidityResult {
  documentId: string;
  /** How many chunk rows had their validity bounds rewritten. */
  chunksUpdated: number;
  validFrom: string | null;
  validTo: string | null;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
}

/** A conversation turn passed to the multi-retrieve rewrite step (oldest → newest). */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Rewrite (query-condensation) directive for `retrieveMulti`. The service
 * supplies the MECHANISM (cheap LLM call + sanitize + fail-safe); YOU supply
 * all natural language. `instruction` is passed to the model verbatim as the
 * rewrite's system message, so its locale and wording stay in your product.
 */
export interface RetrieveRewrite {
  /** System instruction for the rewrite, in your own locale/phrasing. */
  instruction: string;
  /**
   * Conversation turns EXCLUDING the current question, oldest → newest. Only
   * the last few non-system turns are used. Empty/absent ⇒ the query is used
   * unchanged (there is nothing anaphoric to resolve on the first turn).
   */
  history?: ChatTurn[];
  /** Rewrite output token cap. Default 80 — a rewritten query is short. */
  maxTokens?: number;
}

/**
 * `retrieveMulti` request — fan out across corpora + fuse, with an optional
 * cheap query-rewrite step in front. All corpora are resolved under the
 * bearer token's own `(org, project)`.
 */
export interface RetrieveMultiRequest {
  /** Corpus names to search in parallel. */
  corpora: string[];
  query: string;
  /** Per-corpus fetch depth. Default 10 (same as single `retrieve`). */
  topK?: number;
  /** Final cap on the fused, deduped result. Absent ⇒ `topK`. */
  limit?: number;
  /** MMR lambda — forwarded to every per-corpus retrieve. */
  mmr?: number;
  /** jsonb-containment metadata constraint — forwarded to every corpus. */
  filter?: Record<string, unknown>;
  /** Point-in-time validity constraint (ISO-8601) — forwarded to every corpus. */
  asOf?: string;
  /**
   * `dense` (default) or `hybrid`. ⚠ In `hybrid` mode fused `score` values are
   * RRF scores, not cosine — threshold on `denseScore` instead.
   */
  mode?: 'dense' | 'hybrid';
  /** RRF damping constant, default 60. Hybrid only. */
  rrfK?: number;
  /** Optional query-condensation directive. Omit for no rewrite. */
  rewrite?: RetrieveRewrite;
}

/** A fused chunk, tagged with the corpus it came from (for citations/provenance). */
export interface MultiRetrievedChunk extends RetrievedChunk {
  corpus: string;
}

/** Per-corpus outcome. `error` set ⇒ that corpus contributed no chunks. */
export interface CorpusDiagnostics {
  corpus: string;
  /** Chunks this corpus contributed before fusion/cap. */
  matched: number;
  /** `not_found` (no such corpus in your scope) or `failed` (retrieve threw). */
  error?: 'not_found' | 'failed';
}

export interface RetrieveMultiResult {
  /** The query actually used for retrieval (rewritten iff `rewritten`). */
  query: string;
  /** Whether the rewrite step changed the query. */
  rewritten: boolean;
  chunks: MultiRetrievedChunk[];
  corpora: CorpusDiagnostics[];
}

export interface EmbedRequest {
  model?: string;
  input: string | string[];
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  usage: {
    inputTokens: number;
    estimatedCostUsd: number;
  };
  warnings?: ResponseWarning[];
}

// ---------------------------------------------------------------------------
// Route (capability router) surface
// ---------------------------------------------------------------------------

/** One conversational turn supplied as routing context. */
export interface RouteChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One routable surface the caller offers to the router. */
export interface RouteCandidate {
  /** Stable id returned verbatim when this surface is chosen. */
  id: string;
  /** Natural-language description the classifier reasons over. */
  description: string;
  /** Optional structural hint (e.g. a table's columns); rendered, not validated. */
  schema?: Record<string, unknown>;
}

export interface RouteRequest {
  question: string;
  candidates: RouteCandidate[];
  history?: RouteChatMessage[];
  /** Fail-safe target id (must be one of the candidate ids). Defaults to candidates[0].id. */
  defaultRouteId?: string;
  effortLevel?: EffortLevel;
  modelOverride?: string;
}

export interface RouteResult {
  /** Always one of the supplied candidate ids. */
  routeId: string;
  /** Justification, or a `fallback: ...` explanation when the router degraded. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Text-to-SQL surface
// ---------------------------------------------------------------------------

/** One column of the table SQL is generated against. */
export interface SqlColumn {
  name: string;
  type: string;
}

export interface TextToSqlRequest {
  question: string;
  tableName: string;
  columns: SqlColumn[];
  /** SQL dialect hint for the prompt (default: 'postgres'). */
  dialect?: string;
  /** LIMIT appended client-side when the generated SELECT omits one (default 100). */
  rowLimit?: number;
  effortLevel?: EffortLevel;
  modelOverride?: string;
}

export interface TextToSqlResult {
  /** The generated SQL, normalised (fence stripped, LIMIT appended) when valid. */
  sql: string;
  /** True only when the SQL passed the read-only guard. */
  valid: boolean;
  /** Why the SQL was rejected. Absent when `valid` is true. */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetSnapshot {
  org: string;
  limitUsd: number;
  remainingUsd: number;
  spentUsd: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Events (narrow client-side mirror of `src/services/events/types.ts`)
// ---------------------------------------------------------------------------

export interface ValidatorFlag {
  kind: 'blocker' | 'warning' | 'info';
  type: string;
  message: string;
  [k: string]: unknown;
}

export type AppEvent =
  | {
      type: 'generation.request.started';
      requestId: string;
      org: string;
      project?: string;
      totalJobs: number;
      estimatedCostUsd: number;
    }
  | {
      type: 'generation.request.completed';
      requestId: string;
      org: string;
      project?: string;
      status: 'completed' | 'partial' | 'failed';
      totalCostUsd: number;
    }
  | {
      type: 'generation.request.cancelled';
      requestId: string;
      org: string;
      project?: string;
    }
  | {
      type: 'generation.job.started';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
    }
  | {
      type: 'generation.job.completed';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
      flags: ValidatorFlag[];
      costUsd: number;
    }
  | {
      type: 'generation.job.failed';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
      errorCode: string;
      errorMessage: string;
    }
  | {
      type: 'trace.started';
      traceId: string;
      org: string;
      project?: string;
    }
  | {
      type: 'trace.completed';
      traceId: string;
      org: string;
      project?: string;
      totalCostUsd: number;
    }
  | {
      type: 'trace.failed';
      traceId: string;
      org: string;
      project?: string;
      errorCode: string;
    };

export type AppEventType = AppEvent['type'];

export type EventFor<T extends AppEventType> = Extract<AppEvent, { type: T }>;

export interface ProvisionUnitType {
  unitType: string;
  version: string;
  promptTemplate: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  defaultEffort?: 'quick' | 'standard' | 'deep' | 'maximum' | null;
  effortProfiles?: Record<string, unknown> | null;
  responseSchema?: Record<string, unknown> | null;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Defaults to true — an inactive entry provisions nothing. */
  activate?: boolean;
}

export interface ProvisionTenantRequest {
  budget?: { limitUsd: number; refill?: boolean };
  unitTypes?: ProvisionUnitType[];
}
