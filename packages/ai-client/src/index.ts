// Public surface of @edc/ai-client.
//
// Single import target for consuming apps. Construction is `new AIClient({
// baseUrl, apiKey })`; everything else hangs off sub-API instances on the
// client. Zero production deps — uses the platform `fetch` and a small
// hand-rolled SSE parser.

import { AdminAPI } from './admin.js';
import { BudgetAPI } from './budget.js';
import { CapabilitiesAPI } from './capabilities.js';
import { CorporaAPI } from './corpora.js';
import { EmbedAPI } from './embed.js';
import { GenerateAPI } from './generate.js';
import { HttpClient, type RetryPolicy } from './http.js';
import { IngestAPI } from './ingest.js';
import {
  configureIngestGate,
  ingestGateScopeFor,
  type IngestGateConfig,
} from './ingest-gate.js';
import { RegistryAPI } from './registry.js';
import { RetrieveAPI } from './retrieve.js';
import { RouteAPI } from './route.js';
import { TenantAPI } from './tenant.js';
import { TextToSqlAPI } from './text-to-sql.js';
import { openEvents, type EventStream } from './events.js';

export interface AIClientOptions {
  /** Base URL of the ai-service deployment (no trailing slash needed). */
  baseUrl: string;
  /** Per-project bearer token. */
  apiKey: string;
  /**
   * Org delegation: act on behalf of a sub-tenant. Sent as `X-AI-Org` on
   * every request of this client. Only for a key configured server-side with
   * `delegateOrgPrefix`; the server then acts as org `<prefix><org>`, so
   * budget, usage and corpora belong to that org. Use one client per org.
   *
   * Must match `^[a-z0-9-]{1,48}$` (checked here, and again by the server).
   * A key without a prefix gets 403 `org_delegation_forbidden`.
   *
   * 🔴 Require {@link ORG_DELEGATION_CAPABILITY} in `capabilities.negotiate`
   * first: an ai-service older than the feature IGNORES the header, so every
   * sub-tenant would silently share the key's own org.
   *
   * `budget.get(org)` takes the FULL effective org (`<prefix><org>`).
   */
  org?: string;
  /** Injectable fetch (tests / polyfills). Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /**
   * Hard request timeout in ms, PER ATTEMPT. Defaults to 30 seconds. A call
   * can override it (`http.json({ timeoutMs })`, `generate.sync(req, { timeoutMs })`).
   *
   * An explicit value is never shortened by the retry budget
   * (`retry.maxElapsedMs`): every attempt gets all of it, and the budget only
   * decides whether another attempt starts. So a retried GET can take up to
   * about `retry.maxElapsedMs + timeoutMs`; bound the whole thing with
   * `signal` (e.g. `AbortSignal.timeout(ms)`) when you need a hard ceiling.
   * Left unset, the 30 s default IS cut to the budget remaining, so the call
   * takes at most `retry.maxElapsedMs` (30 s) in total. `Infinity` disables
   * the deadline.
   */
  timeoutMs?: number;
  /**
   * Retry policy for transient failures of IDEMPOTENT requests
   * (see {@link RetryPolicy}). Defaults to {@link DEFAULT_RETRY_POLICY}:
   * 3 attempts, 250 ms base, equal jitter, `Retry-After` honoured.
   * `{ attempts: 1 }` disables retry for this client.
   */
  retry?: Partial<RetryPolicy>;
  /**
   * Budget for the process-wide ingest gate that admits every
   * `POST /v1/ingest` this package sends. Partial — anything omitted keeps
   * `DEFAULT_INGEST_GATE_CONFIG`, whose numbers are sized against ai-service's
   * real 100/min-per-key limit. See `./ingest-gate.ts`.
   *
   * Applied to this client's gate SCOPE, so it is safe to set from one place at
   * startup. `configureIngestGate` does the same thing without a client, and is
   * the better hook when the config lives in an app's boot module.
   */
  ingestGate?: Partial<IngestGateConfig>;
  /**
   * Which process-wide gate this client's ingests share.
   *
   * Defaults to a non-reversible id derived from `(baseUrl, apiKey)`, because
   * ai-service's limiter is keyed on the API key: two clients holding different
   * keys have two independent server-side buckets, and one shared gate would
   * halve each one's throughput and let a 429 on one key park the other. Set it
   * explicitly only to force two clients to share a gate, or to split one.
   */
  ingestGateScope?: string;
}

export class AIClient {
  readonly registry: RegistryAPI;
  readonly generate: GenerateAPI;
  readonly ingest: IngestAPI;
  /** Corpus control plane — create/list/get/update/delete corpora. */
  readonly corpora: CorporaAPI;
  readonly retrieve: RetrieveAPI;
  readonly embed: EmbedAPI;
  readonly budget: BudgetAPI;
  readonly admin: AdminAPI;
  /** Tenant provisioning (admin) + readiness self-diagnosis (any role). */
  readonly tenant: TenantAPI;
  /**
   * Boot-time capability negotiation (ADR-0004). Call `negotiate()` once at
   * startup, when AI is enabled, so a wrong promotion order fails at deploy
   * time with an actionable message instead of silently degrading or throwing
   * mid-user-action.
   */
  readonly capabilities: CapabilitiesAPI;
  private readonly _route: RouteAPI;
  private readonly _textToSql: TextToSqlAPI;
  /** Exposed for advanced callers and tests. */
  readonly http: HttpClient;

  constructor(opts: AIClientOptions) {
    if (!opts.baseUrl) throw new TypeError('AIClient: baseUrl is required');
    if (!opts.apiKey) throw new TypeError('AIClient: apiKey is required');
    if (opts.org !== undefined && !/^[a-z0-9-]{1,48}$/.test(opts.org)) {
      throw new TypeError('AIClient: org must match ^[a-z0-9-]{1,48}$');
    }
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        'AIClient: no global fetch found and none was injected via opts.fetch — Node 18+ required.',
      );
    }
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      ...(opts.org !== undefined ? { org: opts.org } : {}),
      fetchImpl,
      // Passed through only when SET: an explicit value is never clamped by the
      // retry budget, the default is (see `RetryPolicy.maxElapsedMs`).
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.retry ? { retry: opts.retry } : {}),
    });
    this.registry = new RegistryAPI(this.http);
    this.generate = new GenerateAPI(this.http);
    const gateScope = opts.ingestGateScope ?? ingestGateScopeFor(opts.baseUrl, opts.apiKey);
    if (opts.ingestGate) configureIngestGate(opts.ingestGate, gateScope);
    this.ingest = new IngestAPI(this.http, gateScope);
    this.corpora = new CorporaAPI(this.http);
    this.retrieve = new RetrieveAPI(this.http);
    this.embed = new EmbedAPI(this.http);
    this.budget = new BudgetAPI(this.http);
    this.admin = new AdminAPI(this.http);
    this.tenant = new TenantAPI(this.http);
    this.capabilities = new CapabilitiesAPI(this.http, opts.baseUrl);
    this._route = new RouteAPI(this.http);
    this._textToSql = new TextToSqlAPI(this.http);
  }

  /**
   * Capability router — classify `question` onto exactly one of the supplied
   * candidate ids. Fail-safe server-side: a successful response always carries
   * a `routeId` that is one of the candidates (the fallback when the model
   * errs/ambiguates). See {@link RouteAPI}.
   */
  route(req: import('./types.js').RouteRequest): Promise<import('./types.js').RouteResult> {
    return this._route.route(req);
  }

  /**
   * Generate a read-only SELECT for `question` over `{tableName, columns}` and
   * validate it with the pure client-side guard. Returns the validated SQL
   * string + `valid` flag; the PRODUCT executes it against its own database
   * (ai-service never runs SQL). See {@link TextToSqlAPI}.
   */
  textToSql(
    req: import('./types.js').TextToSqlRequest,
  ): Promise<import('./types.js').TextToSqlResult> {
    return this._textToSql.textToSql(req);
  }

  /**
   * Subscribe to the SSE stream for a generation channel. Channel format:
   * `request:<requestId>:generations` (mirrors `client.generate.enqueue`'s
   * return value).
   */
  events(channel: string): EventStream {
    return openEvents({ http: this.http, channel });
  }
}

// Re-export everything the consumer might want to import individually.
export * from './types.js';
export * from './errors.js';
export { toCredits } from './credits.js';
export type { EventStream } from './events.js';
export {
  AdminAPI,
  type OpenRouterCreditsSnapshot,
  type AliasCorpusResult,
} from './admin.js';
export { BudgetAPI } from './budget.js';
export { CorporaAPI } from './corpora.js';
// Capability negotiation (ADR-0004). Strict in every environment since 0.32.0:
// every outcome except `ok` throws.
export {
  CapabilitiesAPI,
  CapabilityNegotiationError,
  STRICT_STRUCTURED_OUTPUT_CAPABILITY,
  strictStructuredOutputCapabilities,
  ORG_DELEGATION_CAPABILITY,
  METADATA_FILTER_IN_CAPABILITY,
  type CapabilityDocument,
  type CapabilityLogger,
  type NegotiateOptions,
  type NegotiationResult,
  type NegotiationStatus,
} from './capabilities.js';
// The boot-time capability check WRAPPER around `capabilities.negotiate` —
// the once-per-process latch, the fail-boot-when-unconfigured rule and the test
// reset seam that all four consumers hand-rolled.
export {
  createCapabilityCheck,
  type CapabilityCheck,
  type CapabilityCheckLogger,
  type CapabilityCheckOptions,
  type CapabilityNegotiator,
} from './capability-check.js';
// Budget-failure classification (402). Classify → decide disclosure → log.
// No user-facing copy and no framework: the Spanish sentence stays in the
// product, the classification and the disclosure rule live here.
export {
  classifyBudgetFailure,
  budgetFailureFromWire,
  budgetFailureFromFrame,
  budgetFailureLogFields,
  isRequesterBudgetOwner,
  mayDiscloseBudgetAmounts,
  BUDGET_FAILURE_LOG_MESSAGE,
  BUDGET_NOT_CONFIGURED_WIRE,
  BUDGET_EXCEEDED_WIRE,
  BUDGET_MISCONFIGURED_WIRE,
  type BudgetFailure,
  type BudgetFailureKind,
} from './budget-failure.js';
// Response guards every consumer hand-rolled: fail loud when the system prompt
// was not applied, and log the advisory `warnings[]` (budget soft cap) once.
export {
  assertSystemPromptApplied,
  SystemPromptNotAppliedError,
  SYSTEM_PROMPT_NOT_APPLIED_LOG_MESSAGE,
  type AssertSystemPromptAppliedArgs,
  type SystemPromptGuardLogger,
} from './system-prompt.js';
export {
  logResponseWarnings,
  RESPONSE_WARNING_LOG_MESSAGE,
  type ResponseWarningLogger,
} from './response-warnings.js';
// The passage-length contract in characters, per corpus `chunkSize`.
export { maxChunkChars, DEFAULT_CHUNK_SIZE, CHARS_PER_TOKEN } from './chunk-bound.js';
export { EmbedAPI } from './embed.js';
export { GenerateAPI, type GenerateSyncOptions } from './generate.js';
export {
  GENERATE_STREAM_CONFORMANCE_CASES,
  type GenerateStreamConformanceCase,
} from './stream-conformance.js';
export {
  openGenerateStream,
  openRawGenerateStream,
  type GenerateStream,
  type GenerateStreamOptions,
} from './stream.js';
export {
  IngestAPI,
  type IngestCallOptions,
  type EnqueueAllOptions,
} from './ingest.js';
// Process-wide, 429-aware ingest gate. Every `client.ingest.enqueue*` call goes
// through it automatically — these exports are for CONFIGURING it (once, at
// startup) and for catching its typed failures. See `./ingest-gate.ts`.
export {
  IngestGate,
  IngestRateLimitExhaustedError,
  IngestBatchTooLargeError,
  configureIngestGate,
  getIngestGate,
  ingestGateScopeFor,
  chunkDocuments,
  rateLimitRetryAfterMs,
  MAX_DOCS_PER_INGEST_REQUEST,
  DEFAULT_INGEST_GATE_CONFIG,
  DEFAULT_INGEST_GATE_SCOPE,
  DEFAULT_INGEST_BUSY_MESSAGE,
  _resetIngestGatesForTests,
  _setIngestGateForTests,
  type IngestGateConfig,
  type IngestGateEvent,
  type IngestLane,
  type IngestCallMeta,
  type IngestResultLike,
} from './ingest-gate.js';
// Opt-in coalescing batcher for BULK ingests (debounce + batch, last write wins
// per document id). Safe only once your callback join keys on `docId` — see
// `./ingest-batcher.ts`.
export {
  IngestBatcher,
  IngestBatcherFullError,
  type IngestBatcherOptions,
  type IngestBatchFailure,
  type IngestBatchRequest,
} from './ingest-batcher.js';
// Transient-failure retry for IDEMPOTENT requests. `DEFAULT_RETRY_POLICY` is
// the shipped policy; `AIClientOptions.retry` overrides it per client and
// `JsonRequestOptions.retry` per call.
export { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_MS, type RetryPolicy } from './http.js';
export { RegistryAPI } from './registry.js';
export { RetrieveAPI, type RetrieveCallOptions } from './retrieve.js';
// Retrieval outcome rule (audit P2): a typed 404 or a 200 with no
// chunks is `empty`; every other failure throws `RetrievalUnavailableError`.
// Plus the `grounding` provenance helper, the fleet's Spanish sentences, and
// conformance cases a consumer runs against its own wrapper.
export {
  RetrievalUnavailableError,
  toRetrievalOutcomeError,
  groundingOf,
  GROUNDING_FIELD,
  RETRIEVAL_EMPTY_MESSAGE,
  RETRIEVAL_UNAVAILABLE_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  type EmptyRetrievalReason,
  type Grounding,
  type RetrievalOutcome,
  type RetrievalUnavailableInit,
  type RetrievalUnavailableKind,
} from './retrieval-outcome.js';
export {
  RETRIEVAL_CONFORMANCE_CASES,
  RETRIEVAL_CONFORMANCE_TIMEOUT_MS,
  retrievalConformanceFetch,
  checkRetrievalConformance,
  type RetrievalConformanceCase,
  type RetrievalConformanceResponse,
} from './retrieval-conformance.js';
export { RouteAPI } from './route.js';
export {
  TenantAPI,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessReport,
  type SetBudgetResult,
  type ProvisionItemResult,
  type ProvisionTenantResult,
} from './tenant.js';
// `DEFAULT_SQL_PROMPT` is exported so a consumer can read the built-in it is
// about to replace — and so ai-service's own render tests can assert it survives
// Handlebars escaping unmangled. `TEXT_TO_SQL_REQUIRED_CAPABILITY` is the name to
// put in `capabilities.negotiate({ require: [...] })`.
export {
  TextToSqlAPI,
  TEXT_TO_SQL_UNIT_TYPE,
  TEXT_TO_SQL_REQUIRED_CAPABILITY,
  DEFAULT_SQL_PROMPT,
} from './text-to-sql.js';
// Pure read-only SQL guard — products validate generated SQL WITHOUT a
// round-trip. `isReadOnlySelect` is the boolean check; `guardReadOnlySelect`
// also normalises (fence strip + LIMIT append) and returns a structured result.
export {
  isReadOnlySelect,
  guardReadOnlySelect,
  DEFAULT_SQL_ROW_LIMIT,
  type SqlGuardResult,
} from './sql-guard.js';
