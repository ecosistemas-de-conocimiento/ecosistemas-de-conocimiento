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
import { HttpClient } from './http.js';
import { IngestAPI } from './ingest.js';
import { RegistryAPI } from './registry.js';
import { RetrieveAPI } from './retrieve.js';
import { RouteAPI } from './route.js';
import { TenantAPI } from './tenant.js';
import { TextToSqlAPI } from './text-to-sql.js';
import { openEvents, type EventStream } from './events.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface AIClientOptions {
  /** Base URL of the ai-service deployment (no trailing slash needed). */
  baseUrl: string;
  /** Per-project bearer token. */
  apiKey: string;
  /** Injectable fetch (tests / polyfills). Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Hard request timeout in ms. Defaults to 30 seconds. */
  timeoutMs?: number;
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
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        'AIClient: no global fetch found and none was injected via opts.fetch — Node 18+ required.',
      );
    }
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      fetchImpl,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.registry = new RegistryAPI(this.http);
    this.generate = new GenerateAPI(this.http);
    this.ingest = new IngestAPI(this.http);
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
// Capability negotiation (ADR-0004). `capabilityModeFromEnv` is the shared rule
// — strict in production, warn everywhere else, `AI_CAPABILITY_MODE` overrides.
export {
  CapabilitiesAPI,
  CapabilityNegotiationError,
  capabilityModeFromEnv,
  type CapabilityDocument,
  type CapabilityLogger,
  type CapabilityMode,
  type NegotiateOptions,
  type NegotiationResult,
  type NegotiationStatus,
} from './capabilities.js';
export { EmbedAPI } from './embed.js';
export { GenerateAPI } from './generate.js';
export { IngestAPI } from './ingest.js';
export { RegistryAPI } from './registry.js';
export { RetrieveAPI } from './retrieve.js';
export { RouteAPI } from './route.js';
export {
  TenantAPI,
  type ReadinessCheck,
  type ReadinessCheckId,
  type ReadinessReport,
  type SetBudgetResult,
  type ProvisionUnitType,
  type ProvisionTenantRequest,
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
