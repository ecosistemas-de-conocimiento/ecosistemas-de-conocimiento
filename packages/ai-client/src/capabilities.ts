// Capability negotiation (ADR-0004) — the consumer half.
//
// ── The problem ───────────────────────────────────────────────────────────
// ai-service and its consumers are version-coupled in BOTH directions, and
// every environment (dev / stage / prod / demo-0) runs its own ai-service. The
// only control on promotion order used to be a human remembering a runbook, and
// it failed twice in one week:
//
//   • service ahead of consumer — SILENT. A capability goes live that the
//     consumer isn't ready for; output degrades, HTTP 200, no error anywhere.
//   • consumer ahead of service — LOUD BUT LATE. The consumer asserts a
//     capability the service lacks, so every call throws mid-user-action for a
//     condition that was fully knowable at deploy time.
//
// ── The fix ───────────────────────────────────────────────────────────────
// The consumer declares what it requires, asks the service once at boot, and
// refuses to start with an actionable message when something it needs is
// absent. The mistake surfaces at deploy time, to the person deploying, instead
// of at 3pm to a user mid-action.
//
// It lives in the shared client on purpose: a contract that lives in no shared
// place gets re-implemented and silently regressed per consumer. That is the
// same lesson the hand-folded system prompt taught, at the same cost.
//
// ── Strict in every environment (0.32.0) ──────────────────────────────────
// ai-service is a REQUIRED dependency, and a hard dependency fails boot: there
// is no degraded mode and no per-environment downgrade. Every non-ok outcome
// throws `CapabilityNegotiationError`:
//
//   reachable + says it lacks capability X   → throws (`missing`)
//   reachable + predates the endpoint (404)  → throws (`unsupported`)
//   unreachable / timing out / 5xx / unclear → throws (`unreachable`), but only
//     after a bounded startup retry window, so a briefly restarting ai-service
//     does not fail the boot. The orchestrator restarts the consumer after that.

import type { HttpClient } from './http.js';

/**
 * The document served by `GET /v1/capabilities`.
 *
 * Names, and only names. No version, build id, or commit hash: compatibility is
 * decided on capability names, so a build identifier would decide nothing while
 * inviting someone to trust it or hand-maintain it. The caller already knows
 * which deployment it asked — it holds the URL.
 */
export interface CapabilityDocument {
  /** Capability name → whether that deployment has it. */
  capabilities: Record<string, boolean>;
}

/**
 * Strict schema-constrained output (`responseSchemaStrict: true` on a unit's
 * `specOverride` / `specDefault`). A deployment that has it also publishes one
 * name per model it will run strictly: `strictStructuredOutput:<model id>`.
 */
export const STRICT_STRUCTURED_OUTPUT_CAPABILITY = 'strictStructuredOutput';

/**
 * Capability name for org delegation (`AIClientOptions.org` / `X-AI-Org`).
 * Require it before sending the header: an older server ignores the header
 * and puts every sub-tenant in the key's own org.
 */
export const ORG_DELEGATION_CAPABILITY = 'orgDelegation';

/**
 * Capability name for the `$in` operator in a retrieve `filter`
 * (`{ docId: { $in: ['12', '34'] } }`) and for `RetrieveMultiRequest.corpusFilters`.
 * Require it before sending either: an older server reads `$in` as plain jsonb
 * containment and answers 200 with ZERO chunks.
 */
export const METADATA_FILTER_IN_CAPABILITY = 'metadataFilterIn';

/**
 * The capability names to `require` before sending `responseSchemaStrict: true`
 * to `model`: the feature name, plus the per-model name when a model is given.
 *
 * ```ts
 * await client.capabilities.negotiate({
 *   consumer: 'my-app',
 *   require: [...strictStructuredOutputCapabilities('openai/gpt-4o-mini')],
 * })
 * ```
 */
export function strictStructuredOutputCapabilities(model?: string): string[] {
  return model
    ? [STRICT_STRUCTURED_OUTPUT_CAPABILITY, `${STRICT_STRUCTURED_OUTPUT_CAPABILITY}:${model}`]
    : [STRICT_STRUCTURED_OUTPUT_CAPABILITY];
}

/** Minimal logger shape; any pino/console-like object satisfies it. */
export interface CapabilityLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface NegotiateOptions {
  /**
   * Consumer name for the error message ("edc-web", "edc-backend", …). It is
   * read by whoever is mid-deploy, who may not know which app is failing.
   */
  consumer: string;
  /** Capability names this consumer cannot run without. */
  require: readonly string[];
  /**
   * Total attempts before concluding "unreachable" and throwing. Defaults to 5.
   * With the defaults the startup window is at most about 40 s (inferred from
   * the defaults: 4 backoff waits of 1+2+4+8 s, plus 5 attempts of at most 5 s).
   */
  attempts?: number;
  /** Base backoff in ms between attempts (doubles each time). Defaults to 1000. */
  retryDelayMs?: number;
  /** Deadline for EACH probe attempt, in ms. Defaults to 5000. */
  attemptTimeoutMs?: number;
  logger?: CapabilityLogger;
  signal?: AbortSignal;
}

export type NegotiationStatus = 'ok' | 'missing' | 'unsupported' | 'unreachable';

export interface NegotiationResult {
  status: NegotiationStatus;
  /** Required names the service does not have. Empty unless status is missing/unsupported. */
  missing: string[];
  /** The full document, when we got one. */
  document?: CapabilityDocument;
  /** Human-facing explanation — already actionable; log or throw it as-is. */
  message: string;
}

/**
 * Thrown by `negotiate()` on every outcome except `ok`: a required capability
 * is absent, or ai-service could not be reached within the startup window.
 * Carries the structured facts so a consumer can log them
 * as fields as well as prose.
 */
export class CapabilityNegotiationError extends Error {
  readonly consumer: string;
  readonly baseUrl: string;
  readonly missing: string[];
  readonly status: NegotiationStatus;

  constructor(
    message: string,
    args: {
      consumer: string;
      baseUrl: string;
      missing: string[];
      status: NegotiationStatus;
    },
  ) {
    super(message);
    this.name = 'CapabilityNegotiationError';
    this.consumer = args.consumer;
    this.baseUrl = args.baseUrl;
    this.missing = args.missing;
    this.status = args.status;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CapabilitiesAPI {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  /**
   * Fetch the capability document. Throws on any non-200 — use `negotiate()`
   * for the boot-time check, which classifies failures instead of throwing.
   */
  async get(signal?: AbortSignal): Promise<CapabilityDocument> {
    return this.http.json<CapabilityDocument>({
      method: 'GET',
      path: '/v1/capabilities',
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Boot-time check. Resolves only with status `ok`; throws
   * `CapabilityNegotiationError` on every other outcome.
   */
  async negotiate(opts: NegotiateOptions): Promise<NegotiationResult> {
    const attempts = Math.max(1, opts.attempts ?? 5);
    const baseDelay = Math.max(0, opts.retryDelayMs ?? 1000);
    const timeoutMs = opts.attemptTimeoutMs ?? 5000;
    const log = opts.logger ?? console;
    const required = [...opts.require];

    const result = await this.probe({ attempts, baseDelay, timeoutMs, required, signal: opts.signal });
    const decorated = this.explain(result, opts.consumer);

    if (decorated.status === 'ok') {
      log.info?.(
        `[ai-client] capability check passed for ${opts.consumer}: ` +
          `${required.length} required, ai-service at ${this.baseUrl}.`,
      );
      return decorated;
    }

    throw new CapabilityNegotiationError(decorated.message, {
      consumer: opts.consumer,
      baseUrl: this.baseUrl,
      missing: decorated.missing,
      status: decorated.status,
    });
  }

  /** One classified attempt-loop. No logging, no throwing — pure diagnosis. */
  private async probe(args: {
    attempts: number;
    baseDelay: number;
    timeoutMs: number;
    required: string[];
    signal?: AbortSignal | undefined;
  }): Promise<NegotiationResult> {
    let lastReason = 'no attempt was made';

    for (let attempt = 1; attempt <= args.attempts; attempt++) {
      let res: Response;
      try {
        res = await this.http.raw({
          method: 'GET',
          path: '/v1/capabilities',
          // 🔴 ONE ladder, not two. This loop already retries with backoff AND
          // classifies each outcome (404 = positive absence, 5xx = unclear),
          // which the transport cannot do. Leaving the transport's own retry
          // on multiplied the ladders: `attempts` here x `attempts` there = 9
          // requests for a default 3, and every wait compounded the same way.
          retry: { attempts: 1 },
          timeoutMs: args.timeoutMs,
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt < args.attempts) await sleep(args.baseDelay * 2 ** (attempt - 1));
        continue;
      }

      // 404 is positive knowledge, not a transport failure: this deployment
      // does not serve the endpoint, so it predates ADR-0004 and cannot have
      // any capability added since. Retrying cannot change that.
      if (res.status === 404) {
        return { status: 'unsupported', missing: [...args.required], message: '' };
      }

      if (!res.ok) {
        // 5xx, 401 from a proxy in front, 429 — all of them mean "we could not
        // read the document", NOT "the capability is absent". Never conclude
        // absence from an answer we don't understand.
        lastReason = `HTTP ${res.status} from GET /v1/capabilities`;
        if (attempt < args.attempts) await sleep(args.baseDelay * 2 ** (attempt - 1));
        continue;
      }

      let doc: CapabilityDocument;
      try {
        doc = (await res.json()) as CapabilityDocument;
      } catch (err) {
        lastReason = `response was not JSON (${err instanceof Error ? err.message : String(err)})`;
        if (attempt < args.attempts) await sleep(args.baseDelay * 2 ** (attempt - 1));
        continue;
      }

      if (!doc || typeof doc !== 'object' || typeof doc.capabilities !== 'object') {
        // Something answered, but it isn't ai-service (a proxy, an index page,
        // a wrong base URL). Unclear ⇒ not fatal.
        lastReason = 'response was not a capability document';
        if (attempt < args.attempts) await sleep(args.baseDelay * 2 ** (attempt - 1));
        continue;
      }

      const missing = args.required.filter((name) => doc.capabilities[name] !== true);

      return {
        status: missing.length === 0 ? 'ok' : 'missing',
        missing,
        document: doc,
        message: '',
      };
    }

    return { status: 'unreachable', missing: [], message: lastReason };
  }

  /**
   * Turn a diagnosis into the sentence someone mid-deploy can act on: which
   * consumer, which capability, which environment, and what to do next. The point of the ADR is that the error tells you the fix
   * instead of making you infer it.
   */
  private explain(
    result: NegotiationResult,
    consumer: string,
  ): NegotiationResult {
    const suffix = ' Refusing to start.';

    switch (result.status) {
      case 'ok':
        return result;

      case 'missing':
        return {
          ...result,
          message:
            `${consumer} requires ai-service ${plural(result.missing.length)} ` +
            `${quoteList(result.missing)}; the ai-service at ${this.baseUrl} does not have ` +
            `${result.missing.length > 1 ? 'them' : 'it'}. Deploy ai-service to this ` +
            `environment first, then this app ` +
            `(plan/tecnología/ai-infra/ai-service-promotion-checklist.md).${suffix}`,
        };

      case 'unsupported':
        return {
          ...result,
          message:
            `${consumer} requires ai-service ${plural(result.missing.length)} ` +
            `${quoteList(result.missing)}, but ai-service at ${this.baseUrl} does not serve ` +
            `GET /v1/capabilities — it predates ADR-0004, so it cannot have them. ` +
            `Deploy ai-service to this environment first (or check AI_SERVICE_URL points ` +
            `at ai-service at all).${suffix}`,
        };

      case 'unreachable':
        return {
          ...result,
          message:
            `${consumer} could not reach ai-service at ${this.baseUrl} to check ` +
            `capabilities (${result.message}). ai-service is a required dependency; check ` +
            `that it is running and that AI_SERVICE_URL points at it.${suffix}`,
        };
    }
  }
}

function quoteList(names: string[]): string {
  if (names.length === 0) return '(none)';
  return names.map((n) => `\`${n}\``).join(', ');
}

function plural(n: number): string {
  return n === 1 ? 'capability' : 'capabilities';
}
