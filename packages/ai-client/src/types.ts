// Public type surface for the @edc/ai-client package.
//
// TWO HALVES, and the difference matters when you edit this file.
//
// 1. REQUEST bodies are GENERATED. They are re-exported below from
//    `./generated/wire.js`, which `npm run contract:types` derives from the
//    Zod schemas in ai-service's `src/contract/` — the same objects that gate
//    the requests at runtime and that build `/v1/openapi.json`. Do not add or
//    edit a request type here: change the schema, regenerate, and
//    `npm run contract:check` will confirm the two agree.
//    The generated file is plain structural TypeScript with no zod import, so
//    this package keeps its zero-dependency contract.
//
//    The header this replaced said "keep these aligned ... whenever the wire
//    contract evolves". They had not stayed aligned:
//    `RetrieveMultiRequest` was missing `rerank` and `rerankModel`, both of
//    which `/v1/retrieve/multi` has accepted since the reranker landed, so a
//    typed consumer could not reach the feature at all. That is the failure
//    mode the generator exists to make impossible.
//
// 2. RESPONSE bodies stay HAND-WRITTEN, below the re-exports. ai-service does
//    not validate its own responses with Zod, so there is no schema to derive
//    them from; writing one purely to generate types would create the second
//    source of truth this change removes. They are still pinned by
//    `src/errors/wire-golden.test.ts` and the openapi golden on the server.
//
// ── The one deliberate narrowing ──────────────────────────────────────────
// `chunkConfig` is `z.record(z.string(), z.unknown())` on the wire ON PURPOSE
// (see `chunkConfigSchema` in `src/contract/rag.ts`: the real validation lives
// in `parseStructuralConfig`, so a stricter edge schema would make every new
// chunking option a breaking change). The client narrows it to `ChunkConfig`
// for editor help. That narrowing is applied with `Omit<...>` on top of the
// generated type, so every OTHER field still comes from the contract and
// drift in any of them is still caught.

import type * as Wire from './generated/wire.js';

// ---------------------------------------------------------------------------
// Generated request types — see `src/contract/wire-manifest.ts` for the list.
// ---------------------------------------------------------------------------

export type {
  EffortLevel,
  Validator,
  InlineSpecOverride,
  IncludeContextItem,
  Unit,
  GenerateRequest,
  GenerateSyncRequest,
  ProjectConfigPatch,
  RegistryEntryCreate,
  SetBudgetRequest,
  ProvisionUnitType,
  ProvisionTenantRequest,
  CorpusAliasRequest,
  DocumentValidityRequest,
  ChatTurn,
  RetrieveRewrite,
  RetrieveRequest,
  RetrieveMultiRequest,
  EmbedRequest,
  RouteChatMessage,
  RouteCandidate,
  RouteRequest,
} from './generated/wire.js';

/**
 * Per-unit spec FLOOR. Same shape as `specOverride`, opposite precedence: an
 * active registry entry for the unit-type BEATS it. Kept as a named alias
 * because the contract declares `inlineSpecDefaultSchema` as literally
 * `inlineSpecOverrideSchema`, so generating it would emit a duplicate.
 */
export type InlineSpecDefault = Wire.InlineSpecOverride;

// ---------------------------------------------------------------------------
// The `chunkConfig` narrowing (see the header). Everything except that one
// field is inherited from the generated contract type.
// ---------------------------------------------------------------------------

/** One structural boundary pattern. `pattern` is JS regex SOURCE; group 1 is the identifier. */
export interface ChunkSectionPattern {
  key: string;
  pattern: string;
  flags?: string;
}

/**
 * Structural chunking configuration. The wire accepts any object here; this
 * is the shape ai-service's `parseStructuralConfig` actually understands, so
 * it is what you want in an editor. Anything it does not understand degrades
 * to the corpus's configured strategy with a warning rather than failing.
 */
export interface ChunkConfig {
  sections: ChunkSectionPattern[];
  subSections?: ChunkSectionPattern[];
  maxChars?: number;
  minChars?: number;
}

export type IngestDocument = Omit<Wire.IngestDocument, 'chunkConfig'> & {
  chunkConfig?: ChunkConfig;
};

export type IngestRequest = Omit<Wire.IngestRequest, 'chunkConfig' | 'documents'> & {
  documents: IngestDocument[];
  chunkConfig?: ChunkConfig;
};

/** The mutable settings on a corpus — the body of `PATCH /v1/corpora/:name`. */
export type CorpusConfig = Omit<Wire.CorpusUpdateRequest, 'chunkConfig'> & {
  chunkConfig?: ChunkConfig;
};

export type CorpusCreateRequest = Omit<Wire.CorpusCreateRequest, 'chunkConfig'> & {
  chunkConfig?: ChunkConfig;
};

export type CorpusUpdateRequest = CorpusConfig;

// ---------------------------------------------------------------------------
// Generation surface
// ---------------------------------------------------------------------------

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
  /**
   * What each `includeContext` item retrieved, in request order: chunk ids,
   * the legs that ran, and any retrieval warnings. Ids only, never chunk text.
   *
   * Present only when the request carried `includeContext`. Absent from an
   * ai-service deployment older than this field.
   */
  retrievalTrace?: RetrievalTraceEntry[];
}

/** One entry of {@link SyncResult.retrievalTrace}: one `includeContext` item. */
export interface RetrievalTraceEntry {
  /** The `__context` key the chunks were rendered under. */
  key: string;
  corpus: string;
  /** In rank order; exactly the chunks the prompt got. */
  chunkIds: string[];
  legs: RetrievalLeg[];
  warnings?: RetrievalWarning[];
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
  /** See {@link SyncResult.retrievalTrace}. */
  retrievalTrace?: RetrievalTraceEntry[];
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

export interface ProjectConfigResponse {
  id: string;
  org: string;
  project: string;
  defaultModel: string | null;
  defaultEffort: Wire.EffortLevel | null;
  effortProfiles: unknown;
  contextRules: unknown;
  callbackUrl: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string | null;
  updatedBy: string | null;
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
  defaultEffort: Wire.EffortLevel | null;
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

/** One indexed document in a terminal `IngestStatus`. New in 0.24.0. */
export interface IngestStatusDocument {
  /** Your document id when you sent one, else ai-service's — the same `docId` callbacks carry. */
  docId: string;
  /** Chunks indexed for this document; 0 means nothing is retrievable. */
  chunkCount: number;
}

export interface IngestStatus {
  ingestId: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'processing' | 'completed' | 'partial' | 'failed';
  /**
   * Total chunks indexed by this batch. Present once `status` is terminal, on
   * servers that ship it (absent on older ones — treat absent as unknown, not 0).
   */
  chunkCount?: number;
  /** Per-document chunk counts; same presence rule as `chunkCount`. */
  documents?: IngestStatusDocument[];
}

// ---------------------------------------------------------------------------
// Corpus control plane (client.corpora)
// ---------------------------------------------------------------------------

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

/**
 * `DELETE /v1/corpus/:name/documents/:externalId` response. TWO counters, not
 * the three on {@link DeleteCorpusResult}: removing a document never removes
 * its corpus.
 */
export interface DeleteDocumentResult {
  deleted: {
    chunks: number;
    documents: number;
  };
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

/**
 * A retrieval leg — one independent source of candidate rows.
 *
 * `lexical` (Postgres full-text search) and `sparse` (learned-sparse bge-m3)
 * are two DIFFERENT legs whose scores both arrive in `lexicalScore`. That
 * shared slot is why this type exists. `trigram` (pg_trgm word similarity) is
 * a third lexical leg in that slot, seen only on a service started with
 * `HYBRID_LEXICAL_LEG=trigram`.
 */
export type RetrievalLeg = 'dense' | 'lexical' | 'sparse' | 'trigram' | 'rerank';

/**
 * An advisory flag on a retrieval response: the call SUCCEEDED, but not in the
 * shape you asked for. Same `{ code, message }` core as {@link ResponseWarning},
 * so one reader handles both lists. Treat an unknown `code` as informational.
 *
 * Codes today:
 *   - `RERANK_DEGRADED` — `rerank: true` was asked for and the cross-encoder
 *     did not fully order the result. `reason` is `timeout`, `error`,
 *     `unavailable` (no reranker on this server) or `backfilled` (it scored
 *     fewer rows than the result holds). Chunks without a `rerankScore` are in
 *     fused order.
 *   - `BUDGET_SOFT_CAP` — the org's remaining budget fell below its soft cap.
 *
 * Never carries the query or any chunk text.
 */
export interface RetrievalWarning {
  code: string;
  message: string;
  /** Typed as `string`, not a union: the server may add reasons. */
  reason?: string;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /**
   * The legs that returned CANDIDATE rows — not the legs you asked for, and
   * not the legs whose rows survived into `chunks`.
   *
   * ⚠ The unit differs by leg. `dense`, `lexical`, `sparse` and `trigram` count rows the
   * leg returned into the server's fusion POOL, before RRF and before the
   * final top-K slice. `rerank` counts rows in the RESPONSE — the returned
   * chunks carrying a `rerankScore`. So `topK: 1` against a hybrid retrieve
   * whose lexical leg returned 50 rows that all lost the fusion gives you one
   * dense chunk and `legs === ['dense','lexical']`. Do not read a leg name as
   * "this leg is represented in `chunks`"; read it as "this leg is alive".
   * Whether a leg's candidates win slots is ranking, not health.
   *
   * `rerank` is here only when the cross-encoder really scored rows. The
   * rerank rung is fail-safe: a timeout or a down reranker returns the fused
   * order, and the response then carries a `RERANK_DEGRADED` entry in
   * {@link RetrieveResult.warnings} (older services stayed silent). Its absence
   * from `legs` is the other way to tell rerank did not run.
   *
   * ⚠ OPTIONAL because an older deployment omits it, so a present-check is
   * not a version check. `client.retrieve.retrieveMulti()` carries its own
   * {@link RetrieveMultiResult.legs} from 0.33.0 on, absent on older services.
   * A degraded rerank is also reported in {@link RetrieveResult.warnings}.
   *
   * ⚠ `undefined` means the SERVICE is older than this field, never that no
   * legs ran. Gate on the `retrievalLegs` capability, not on the field. At
   * boot, with the rest of what your build requires:
   *
   * ```ts
   * await client.capabilities.negotiate({
   *   consumer: 'my-app',
   *   require: ['retrievalLegs'],
   * });
   * ```
   *
   * which throws `CapabilityNegotiationError` in `strict` mode when the
   * service is reachable and positively lacks it, and logs loudly instead in
   * `warn` mode or when the service cannot be reached at all. Prefer
   * `createCapabilityCheck` (`./capability-check.js`) if you want the
   * once-per-process wrapper consumers share. For a plain boolean
   * at some other moment, read the document:
   * `(await client.capabilities.get()).capabilities.retrievalLegs === true`.
   *
   * ⚠ Read it as a SET. Today a hybrid retrieve runs dense plus exactly one
   * lexical leg, so `['dense','lexical']` and `['dense','sparse']` are the
   * common shapes — plus `rerank` when the cross-encoder scored rows, and
   * minus any leg that returned zero rows, which is the case you are watching
   * for. The declared next change fuses all three. Never key on `legs.length`
   * or `legs[1]`.
   */
  legs?: RetrievalLeg[];
  /**
   * Present only when something degraded (see {@link RetrievalWarning}).
   * Absent on success and on deployments older than this field.
   */
  warnings?: RetrievalWarning[];
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
  /**
   * Chunks this corpus won a slot for in the FINAL `chunks` array, after
   * fusion, the optional rerank and the `limit` cap.
   *
   * ⚠ `matched` says what the corpus FOUND; `contributed` says what survived.
   * `matched: 8, contributed: 0` means the corpus was queried and DID match and
   * then reached you with nothing — worth surfacing rather than assuming an
   * attachment simply had no relevant text.
   *
   * Optional: absent when talking to an ai-service older than this release.
   */
  contributed?: number;
}

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
   *    so the service rebuilds ranks over one global pool per leg and re-runs
   *    RRF. `score` is that global RRF value, on the same scale as before.
   *  • `score` — a single corpus, or `mode: 'dense'`, where `score` is already
   *    comparable. Unchanged from previous releases.
   *
   * Optional: absent when talking to an ai-service older than this release.
   */
  fusion?: 'score' | 'cross-corpus-rrf';
  /**
   * The legs that returned candidate rows, as a SET: the union of every
   * per-corpus retrieve's legs, plus `rerank` when the post-fusion
   * cross-encoder really scored rows. A corpus that errored contributes no
   * legs. Same units and reading rules as {@link RetrieveResult.legs}.
   *
   * Optional: absent when talking to an ai-service older than this release.
   */
  legs?: RetrievalLeg[];
  /** Same as {@link RetrieveResult.warnings}; deduplicated across corpora. */
  warnings?: RetrievalWarning[];
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

export interface RouteResult {
  /** Always one of the supplied candidate ids. */
  routeId: string;
  /** Justification, or a `fallback: ...` explanation when the router degraded. */
  reason: string;
  /** True ⇒ the default route was used, not a model choice. Absent from older servers. */
  fallback?: boolean;
  /** Why the router degraded; only with `fallback: true`. */
  fallbackCause?: 'router_call_failed' | 'router_unparseable' | 'router_invalid_route';
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
  effortLevel?: Wire.EffortLevel;
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
