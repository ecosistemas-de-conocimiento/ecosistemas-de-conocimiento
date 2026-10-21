// GENERATED FILE — DO NOT EDIT.
//
// Derived from the Zod schemas in ai-service `src/contract/` by
// `npm run contract:types`. `npm run contract:check` fails when this file
// is out of date, so editing it by hand is a change that survives exactly
// until the next CI run.
//
// These are the REQUEST bodies, expanded to plain structural TypeScript so
// this package keeps its zero-dependency contract — there is no `zod`
// import here and there must never be one.
//
// Response shapes are NOT generated: the server does not validate its own
// responses with Zod, so there is no schema to derive them from. They stay
// hand-written in `../types.ts`.

/** Mirrors the `effort_level` pgEnum so the API surface stays in lockstep. */
export type EffortLevel = "quick" | "standard" | "deep" | "maximum";

/**
 * A validator entry is either a builtin's name (string) or an inline rule the
 * service interprets generically (`{ type, ...params }`). `passthrough()`
 * keeps the extra fields — the service stores them verbatim and the runtime
 * validator interpreter reads them.
 */
export type Validator = string | {
  [x: string]: unknown;
  type: string;
};

export type InlineSpecOverride = {
  promptTemplate?: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  effortLevel?: EffortLevel;
  effortProfile?: Record<string, unknown>;
  responseSchema?: unknown;
  responseSchemaStrict?: boolean;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
};

export type IncludeContextItem = {
  corpus: string;
  query: string;
  filter?: Record<string, unknown>;
  asOf?: string;
  mode?: "dense" | "hybrid";
  rerank?: boolean;
  topK?: number;
  mmr?: number;
} | {
  name: string;
};

export type Unit = {
  unitKey: string;
  unitType?: string;
  input?: Record<string, unknown>;
  dependsOn?: Record<string, string>;
  specOverride?: InlineSpecOverride;
  /**
   * Per-unit spec **FLOOR**. Consulted only AFTER the active
   * `registry_entries` row, so registering the unit-type WINS over it.
   *
   * This is where a caller's BUILT-IN belongs — a shipped default prompt,
   * effort tier or response schema that must work with zero registry config
   * while still letting a project take ownership by registering the
   * unit-type. Putting a built-in in `specOverride` instead makes the
   * registry row resolve and then be discarded, which is a bug that surfaces
   * far from its cause.
   *
   * Unlike `specOverride`, a floor does NOT suppress registry provenance:
   * `traces.prompt_version` still records which registered prompt answered.
   */
  specDefault?: InlineSpecOverride;
  /**
   * Per-unit **system prompt**, delivered to the model as a real
   * `{ role: 'system' }` message ahead of the rendered user prompt.
   *
   * Literal text — NOT a Handlebars template. It is passed through
   * byte-for-byte, so an embedded JSON schema / brace-heavy contract is safe.
   * (The registry-level `metaPromptTemplate` IS rendered; see
   * `src/services/generation/system-prompt.ts` for the precedence table.)
   *
   * Omit it and the request behaves exactly as it did before this field
   * existed: a single `user` message, no `system` role.
   */
  systemPrompt?: string;
};

export type GenerateRequest = {
  units: Unit[];
  effortLevel?: EffortLevel;
  promptOverride?: string;
  modelOverride?: string;
  effortOverrides?: Record<string, Record<string, unknown>>;
  /**
   * Batch-wide system prompt. Applies to every unit that does not carry its
   * own `unit.systemPrompt`. Literal text, never rendered. Persisted on
   * `generation_requests.meta_prompt_override`.
   */
  systemPromptOverride?: string;
  includeContext?: IncludeContextItem[];
  clientRequestId?: string;
  callbackUrl?: string;
  requestedBy?: string;
  metadata?: Record<string, unknown>;
};

export type GenerateSyncRequest = {
  unit: Unit;
  effortLevel?: EffortLevel;
  modelOverride?: string;
  /** Same semantics as on `/v1/generate`; loses to `unit.systemPrompt`. */
  systemPromptOverride?: string;
  includeContext?: IncludeContextItem[];
  requestedBy?: string;
};

export type ProjectConfigPatch = {
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  effortProfiles?: Record<string, unknown> | null;
  contextRules?: Record<string, unknown> | null;
  callbackUrl?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RegistryEntryCreate = {
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
};

export type SetBudgetRequest = {
  /** Hard monthly cap in USD. 0 is legal — it means "configured, but frozen". */
  limitUsd: number;
  /**
   * Top the live `remaining` counter back up to the new cap. Default false:
   * lowering a cap must not silently hand the org free spend, and raising one
   * shouldn't retroactively refund what was already used.
   */
  refill?: boolean;
};

/** One registry entry to register while provisioning. */
export type ProvisionUnitType = {
  version: string;
  promptTemplate: string;
  unitType: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  defaultEffort?: EffortLevel | null;
  effortProfiles?: Record<string, unknown> | null;
  responseSchema?: Record<string, unknown> | null;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Provisioning activates by default — an inactive entry provisions nothing. */
  activate?: boolean;
};

export type ProvisionTenantRequest = {
  budget?: SetBudgetRequest;
  unitTypes?: ProvisionUnitType[];
};

export type IngestDocument = {
  text: string;
  id?: string;
  title?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * Temporal validity of this document as a half-open interval
   * `[validFrom, validTo)`, ISO-8601 datetimes. Omit a side for "unbounded";
   * omit both (the default, and what every existing consumer sends) for
   * "always valid" — byte-identical to pre-0012 behaviour.
   *
   * These are stamped onto every chunk at ingest so `POST /v1/retrieve` can
   * take an `asOf` and drop superseded content BEFORE ranking rather than
   * after. The service assigns no meaning to the interval beyond ordering:
   * a consumer decides what supersession means in its own domain.
   *
   * To retire a document without re-embedding it, use
   * `PATCH /v1/corpus/:corpus/documents/:externalId/validity`.
   */
  validFrom?: string;
  validTo?: string;
  /**
   * Per-DOCUMENT language — a Postgres text-search config name (`'spanish'`,
   * `'english'`, `'simple'`, …), validated against the installed whitelist (a
   * bad value is rejected here, not at `to_tsvector`). Stored on the document
   * row for a FUTURE per-chunk stemming path (per-chunk regconfig + query
   * fan-out). It does NOT drive the lexical `text_search` regconfig today —
   * that is a PER-CORPUS setting (see the corpus-level `language` field
   * below), which IS live: a corpus created with `language: 'spanish'` stems
   * its lexical leg in Spanish. Per-document language is deliberately
   * orthogonal to that. Purely additive and optional.
   */
  language?: string;
  /**
   * Per-DOCUMENT chunking configuration. Overrides the batch-level
   * `chunkConfig` for this document only, which is the granularity that
   * actually matters: one corpus routinely mixes documents whose addressable
   * unit is a numbered section with documents that are ordinary prose, and a
   * corpus-level setting cannot express that.
   *
   * Same shape as the batch-level field — see `chunkConfigSchema`.
   */
  chunkConfig?: Record<string, unknown>;
};

export type IngestRequest = {
  corpus: string;
  documents: IngestDocument[];
  embeddingModel?: string;
  /**
   * CORPUS-LEVEL default language — a Postgres text-search config
   * (`regconfig`) name DIRECTLY: `'spanish'`, `'english'`, `'simple'`, …
   * (not an ISO locale code). Stored on the corpus verbatim. This DRIVES the
   * lexical leg's stemming: a corpus created with `language: 'spanish'`
   * builds and queries its `text_search` tsvector in Spanish. Applied only
   * when the corpus is FIRST created (corpora are auto-created on first
   * ingest; an existing corpus's stored config wins — reconfigure it via
   * `PATCH /v1/corpora/:name`). Omitted ⇒ `'simple'`. Additive and optional;
   * an unknown name is rejected at validation time, before any corpus is
   * created.
   */
  language?: string;
  /**
   * Webhook POSTed at terminal-per-doc + batch-progress + batch-completion
   * transitions, signed per the callback contract
   * (`plan/tecnología/ai-infra/callback-contract.md`). The exact set of
   * events fired:
   * - `ingest.completed` — once per successfully ingested doc
   * - `ingest.failed`    — once per doc that failed
   * - `ingest.progress`  — every 10 docs OR every 30s on batches >5 docs
   * Captured on the `ingest_requests` row at enqueue time so the worker can
   * dispatch without re-reading the original HTTP request.
   */
  callbackUrl?: string;
  /**
   * Batch-level chunking configuration — see `chunkConfigSchema`. Applies to
   * every document in this request that does not carry its own
   * `chunkConfig`. Absent ⇒ the corpus's configured strategy, i.e.
   * byte-identical to the behaviour before this field existed.
   */
  chunkConfig?: Record<string, unknown>;
};

export type CorpusCreateRequest = {
  /** Corpus name, unique within the caller's `(org, project)`. */
  name: string;
  embeddingModel?: string;
  language?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CorpusUpdateRequest = {
  embeddingModel?: string;
  language?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CorpusAliasRequest = {
  target: string;
};

export type DocumentValidityRequest = {
  validFrom?: string | null;
  validTo?: string | null;
};

/** A conversation turn passed to the rewrite step. Ordered oldest → newest. */
export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * The rewrite (query-condensation) directive. Optional on the request; when
 * present the service rewrites `query` into a standalone search query BEFORE
 * fan-out, and FAILS SAFE to the raw `query` on the first turn (no history) or
 * any error. `instruction` carries ALL natural language — the service adds none.
 */
export type RetrieveRewrite = {
  /**
   * Consumer-owned system instruction for the rewrite (e.g. "rewrite the last
   * question as a standalone search query, resolving pronouns; answer with only
   * the query, in the same language"). The service passes this through verbatim
   * as the rewrite call's system message — locale and wording stay with the
   * consumer (ADR-0001 / content-agnostic).
   */
  instruction: string;
  /**
   * Conversation turns (oldest → newest), EXCLUDING the current question. Only
   * the last few non-system turns are used. Absent/empty ⇒ nothing to resolve
   * ⇒ the raw `query` is used unchanged.
   */
  history?: ChatTurn[];
  /** Output token cap for the rewrite. Default 80 — a rewritten query is short. */
  maxTokens?: number;
};

export type RetrieveRequest = {
  corpus: string;
  query: string;
  topK?: number;
  mmr?: number;
  /**
   * Optional metadata constraint applied **before** ranking, on every leg.
   * Per key: a value ⇒ jsonb containment (`@>`); `{ "$in": [v1, …] }` ⇒
   * `metadata[key]` equals one of 1–500 strings/numbers. Keys AND together.
   * Absent or `{}` ⇒ no clause. NULL metadata never matches a non-empty
   * filter; jsonb is type-sensitive (`5` ≠ `"5"`). `$in` needs the
   * `metadataFilterIn` capability. See `metadataFilterSchema`.
   */
  filter?: Record<string, unknown>;
  /**
   * Point-in-time constraint, ISO-8601. When present, only chunks whose
   * validity interval contains `asOf` are eligible — applied as a SQL
   * predicate on the candidate set, alongside `filter` and BEFORE any
   * ranking, so a superseded chunk can never displace a current one and can
   * never appear in the result.
   *
   * Chunks with no validity bounds (the default, and every chunk ingested
   * before migration 0012) are ALWAYS eligible: an unbounded interval
   * contains every instant. That is what keeps this additive — a corpus
   * that never sets validity behaves identically with and without `asOf`.
   *
   * Absent ⇒ no temporal predicate at all (today's behaviour).
   */
  asOf?: string;
  /**
   * Ranking mode.
   * - `dense` (default): cosine top-K over the embedding index. Identical
   * to the behaviour before this parameter existed.
   * - `hybrid`: run a dense leg AND a lexical (`tsvector`/`ts_rank_cd`)
   * leg over the same filtered candidate set, then fuse with Reciprocal
   * Rank Fusion. Fixes exact-identifier queries — codes, numbered
   * references, any short literal token — which dense embeddings
   * systematically miss because those tokens carry almost no
   * distributional signal.
   *
   * NOTE FOR CONSUMERS: in `hybrid` mode `score` is an RRF score (small,
   * typically 0.01–0.05), NOT a cosine similarity. Any consumer that
   * thresholds on `score` must read `denseScore` instead, which is still the
   * cosine value when the chunk was found by the dense leg. This is why
   * hybrid is opt-in rather than the default.
   */
  mode?: "dense" | "hybrid";
  /**
   * RRF damping constant. Higher = flatter fusion (rank differences matter
   * less). 60 is the value from the original RRF paper and a good default;
   * exposed for eval sweeps, not for routine use. Ignored unless
   * `mode: 'hybrid'`.
   */
  rrfK?: number;
  /**
   * Opt into cross-encoder reranking. After retrieval (dense or hybrid+RRF),
   * a capped top-N pool is re-scored by a cross-encoder (self-hosted
   * `bge-reranker-v2-m3` behind the `RERANK_URL` seam) and re-ordered before
   * the final top-K slice, surfacing `rerankScore` on each chunk.
   *
   * NO-OP unless the SERVER has `RERANK_ENABLED=true` and a configured
   * `RERANK_URL`: on any environment where rerank isn't wired, `rerank: true`
   * degrades to the un-reranked order. FAILS SAFE to the fused order on any
   * rerank error/timeout — reranking is a relevance-polish rung, never a
   * correctness gate, so it must not turn a slow reranker into a failed
   * query. Neither is silent: the response carries a `RERANK_DEGRADED`
   * entry in `warnings` naming the reason, and `legs` omits `rerank`.
   *
   * Mutually exclusive with `mmr`: if both are set, rerank wins and `mmr` is
   * ignored (they optimise opposite things — relevance vs diversity — so
   * chaining them doubles cost for murky benefit).
   *
   * ⚠ CONSUMERS: when rerank is on, `score` is the cross-encoder score
   * (typically a 0–1 sigmoid), a different scale again from RRF and cosine.
   * Threshold on `rerankScore` (== `score` here), not on `denseScore`.
   */
  rerank?: boolean;
  /**
   * Override the rerank model for this request (for A/B). Absent ⇒ the
   * server's `RERANK_MODEL`. Only USED when `rerank` is set, but always
   * CHECKED: under `RERANK_PROVIDER=deepinfra` a model outside the server's
   * rerank allowlist is a 400 even when `rerank` is absent or false
   * (fail-closed — a refused model is refused, not silently ignored).
   */
  rerankModel?: string;
};

export type RetrieveMultiRequest = {
  /** Corpus names to fan out across, all under the caller's `(org, project)`. */
  corpora: string[];
  query: string;
  /** Per-corpus fetch depth. Default 10 — matches single `/v1/retrieve`. */
  topK?: number;
  /** Final cap on the fused, deduped result. Absent ⇒ `topK`. */
  limit?: number;
  /** Forwarded to every per-corpus retrieve — see `retrieveRequestSchema`. */
  mmr?: number;
  filter?: Record<string, unknown>;
  /**
   * Per-corpus metadata filter, keyed by a name in `corpora`. For a corpus
   * listed here, its entry REPLACES `filter` for that corpus only (no
   * merging — repeat any shared keys you still want). Corpora not listed
   * use `filter` as before. Same shape and validation as `filter`.
   *
   * Use case: a shared corpus searched unfiltered plus a per-user corpus
   * restricted to an allowed set, in ONE fused hybrid call:
   * `{ corpora: ['shared', 'drafts'],
   * corpusFilters: { drafts: { docId: { $in: ['12', '34'] } } } }`.
   *
   * A key that is not in `corpora` is a 400: a typo would otherwise retrieve
   * that corpus UNFILTERED. Older servers reject this field (the schema is
   * strict) — require the `metadataFilterIn` capability before sending it.
   */
  corpusFilters?: Record<string, Record<string, unknown>>;
  asOf?: string;
  mode?: "dense" | "hybrid";
  rrfK?: number;
  /**
   * Opt into cross-encoder reranking, applied **once, AFTER cross-corpus
   * fusion** — not per corpus. The fan-out fuses every leg by score and
   * dedupes; the reranker then re-scores a capped top-N pool of those fused
   * candidates and re-orders before the final `limit`, surfacing
   * `rerankScore` on each returned chunk.
   *
   * FUSION CAVEAT (why this is a distinct design from single `/v1/retrieve`):
   * the pool the reranker sees is drawn from MULTIPLE corpora. That is fine —
   * a cross-encoder scores each (query, chunk-text) pair on its own, with no
   * dependence on which corpus the chunk came from — but it does mean the
   * reranker, not per-corpus score, decides the final head order across
   * corpora. `corpus` provenance is preserved on every returned chunk.
   *
   * NO-OP unless the SERVER has `RERANK_ENABLED=true` and a configured
   * `RERANK_URL`: where rerank isn't wired, `rerank: true` degrades to the
   * fused order. FAILS SAFE to the fused order on any rerank error/timeout —
   * never a 500. Either way the response says so: a `RERANK_DEGRADED`
   * warning, and no `rerank` in `legs`.
   *
   * Mutually exclusive with `mmr`: when rerank is active, `mmr` is NOT
   * forwarded to the per-corpus legs (rerank wins, mirroring single
   * `/v1/retrieve`). They optimise opposite things — relevance vs diversity.
   *
   * ⚠ CONSUMERS: when rerank is on, `score` is the cross-encoder score
   * (typically a 0–1 sigmoid), a different scale again from RRF and cosine.
   * Threshold on `rerankScore` (== `score` here), not on `denseScore`.
   */
  rerank?: boolean;
  /**
   * Override the rerank model for this request (for A/B). Absent ⇒ the
   * server's `RERANK_MODEL`. Only USED when `rerank` is set, but always
   * CHECKED: under `RERANK_PROVIDER=deepinfra` a model outside the server's
   * rerank allowlist is a 400 even when `rerank` is absent or false
   * (fail-closed — a refused model is refused, not silently ignored).
   */
  rerankModel?: string;
  /** Optional query-rewrite directive — see `retrieveRewriteSchema`. */
  rewrite?: RetrieveRewrite;
};

export type EmbedRequest = {
  input: string | string[];
  model?: string;
};

export type RouteChatMessage = ChatTurn;

export type RouteCandidate = {
  id: string;
  description: string;
  schema?: Record<string, unknown>;
};

export type RouteRequest = {
  question: string;
  candidates: RouteCandidate[];
  history?: ChatTurn[];
  /**
   * Returned (with a fallback reason) on any error / ambiguity / invalid
   * routeId. When omitted the fail-safe target is `candidates[0].id`.
   */
  defaultRouteId?: string;
  /** Optional override of the resolved effort tier (defaults to `quick`). */
  effortLevel?: EffortLevel;
  /** Optional explicit model override (rare; the registry/effort tier wins). */
  modelOverride?: string;
};
