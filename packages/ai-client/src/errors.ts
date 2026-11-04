// Error class hierarchy for @edc/ai-client.
//
// Mirrors the server-side typed errors (`SpecResolutionError`,
// `IdempotencyConflictError`, `BudgetExceeded`, ...) so a consumer can do
// `try { ... } catch (e) { if (e instanceof BudgetExceededError) ... }`
// without parsing response bodies by hand.
//
// All concrete errors inherit from `AIServiceError`, which carries the raw
// HTTP `status`, the `body` we received, and — since 0.17.0 — the server's
// stable `code` (`ERR_*`), `retryable` and `retryAfterMs`. The mapping in
// `errorFromResponse` reads the `error` discriminator ai-service stamps, in
// EITHER of its two envelope shapes (see `WIRE_ERRORS` below).

export interface ErrorBody {
  /**
   * The FLAT envelope's discriminator. Deliberately still typed `string`:
   * widening it to `string | { code, message }` for the nested envelope would
   * be a compile break for every consumer that reads this field, and the
   * nested shape is read through the index signature instead
   * (`nestedEnvelope`, below).
   */
  error?: string;
  message?: string;
  [k: string]: unknown;
}

/** The nested envelope `{ error: { code, message } }`, when the body is one. */
function nestedEnvelope(body: ErrorBody): { code?: string; message?: string } | undefined {
  const raw = (body as { error?: unknown }).error;
  return raw !== null && typeof raw === 'object' ? (raw as { code?: string; message?: string }) : undefined;
}

/**
 * The taxonomy facts a server error carries that are NOT part of any class's
 * positional constructor. Passed as a trailing optional argument so every
 * pre-0.17.0 construction site keeps compiling and behaving identically.
 */
export interface ErrorMeta {
  /** The server's stable machine string, `ERR_*`. */
  code?: string | undefined;
  /** Is the same request worth retrying unchanged? */
  retryable?: boolean | undefined;
  /** Server's stated wait in ms, when it gave one. */
  retryAfterMs?: number | undefined;
}

/**
 * Recover the server's `ERR_` string from a body that carries it.
 *
 * Two places it can live, and only two:
 *   · flat  — `ProviderUnavailable` repeats it as a top-level `code` field.
 *   · nested — `{ error: { code } }`, where `code` is the `ERR_` string with
 *     its prefix stripped, so it is re-prefixed here.
 *
 * The `ERR_` guard matters: Fastify's own validation errors put an unrelated
 * `FST_ERR_*` string on `code`, and that is not a taxonomy code.
 */
function codeFromBody(body: ErrorBody): string | undefined {
  const flat = body['code'];
  if (typeof flat === 'string' && flat.startsWith('ERR_')) return flat;
  const nested = nestedEnvelope(body);
  if (nested !== undefined && typeof nested.code === 'string') {
    return nested.code.startsWith('ERR_') ? nested.code : `ERR_${nested.code}`;
  }
  return undefined;
}

export class AIServiceError extends Error {
  readonly status: number;
  readonly body: ErrorBody;
  /**
   * The server's stable machine string, `ERR_*`, when one is known — either
   * carried on the wire or supplied from `WIRE_ERRORS`. `undefined` for the
   * handful of discriminators ai-service emits without a taxonomy class, and
   * for anything this client could not recognise at all.
   */
  readonly code: string | undefined;
  /** Is the same request worth retrying unchanged? Defaults to `false`. */
  readonly retryable: boolean;
  /**
   * Server's stated wait in ms, when it gave one. Set for `RateLimitError`
   * (429) and `ProviderUnavailableError` (503); `undefined` elsewhere.
   */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, status: number, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message);
    this.name = 'AIServiceError';
    this.status = status;
    this.body = body;
    this.code = meta.code ?? codeFromBody(body);
    this.retryable = meta.retryable ?? false;
    this.retryAfterMs = meta.retryAfterMs;
  }
}

/**
 * 400 family parent, new in 0.17.0.
 *
 * Every other status family had a class; 400 did not, so a request rejected as
 * malformed arrived as a bare `AIServiceError` and the only way to recognise
 * one was `err.status === 400`. It still catches everything ai-service answers
 * with fastify-sensible's generic `{statusCode, error: 'Bad Request', message}`
 * — Zod rejections, a missing corpus name, a body that failed validation. Six
 * TAXONOMY classes used to land here too; they now
 * send their own discriminator and `code` and resolve to their own class.
 *
 * Widening only: nothing was an instance of this before it existed, and a
 * consumer matching `instanceof AIServiceError` or `err.status === 400` is
 * unaffected.
 */
export class BadRequestError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'BadRequestError';
  }
}

export class AuthError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 401, body, meta);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 403, body, meta);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 404, body, meta);
    this.name = 'NotFoundError';
  }
}

/**
 * 409 family parent, new in 0.17.0.
 *
 * ai-service has SIX distinct 409s (idempotency, plus five corpus/alias
 * uniqueness and immutability refusals). Until 0.17.0 five of them arrived as
 * an untyped `AIServiceError` and could not be told apart at all. They now have
 * both a class each AND this shared parent, so a consumer can branch coarsely
 * ("something already exists") or precisely, without a status literal.
 *
 * Widening only: nothing was an instance of this before it existed.
 */
export class ConflictError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 409, body, meta);
    this.name = 'ConflictError';
  }
}

/**
 * The named corpus does not exist in this (org, project).
 *
 * ⚠ Parent widened in 0.17.0 from `AIServiceError` to `NotFoundError`. This
 * class was UNREACHABLE before: `errorFromResponse` matched on a string
 * discriminator only, so ai-service's nested `{ error: { code:
 * 'CORPUS_NOT_FOUND' } }` fell through to the 404 status fallback and every
 * consumer got a `NotFoundError`. Extending `NotFoundError` is what keeps that
 * true now that the nested envelope IS matched — a consumer branching on
 * `instanceof NotFoundError` still catches it, and gains the narrower class.
 */
export class CorpusNotFoundError extends NotFoundError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'CorpusNotFoundError';
  }
}

export class SpecResolutionError extends AIServiceError {
  readonly resolutionCause: string;
  constructor(message: string, cause: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'SpecResolutionError';
    this.resolutionCause = cause;
  }
}

export class DependencyCycleError extends AIServiceError {
  readonly cycle: string[];
  constructor(message: string, cycle: string[], body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
}

export class CrossBatchDependencyError extends AIServiceError {
  readonly missing: string[];
  constructor(message: string, missing: string[], body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'CrossBatchDependencyError';
    this.missing = missing;
  }
}

export class BudgetExceededError extends AIServiceError {
  readonly org: string;
  readonly requested: number;
  readonly remaining: number;
  readonly shortfallUsd: number;
  constructor(
    message: string,
    args: { org: string; requested: number; remaining: number; shortfallUsd: number },
    body: ErrorBody = {},
    meta: ErrorMeta = {},
  ) {
    super(message, 402, body, meta);
    this.name = 'BudgetExceededError';
    this.org = args.org;
    this.requested = args.requested;
    this.remaining = args.remaining;
    this.shortfallUsd = args.shortfallUsd;
  }
}

/**
 * Fail-closed budget rejection (ADR-0003 D5): the org has NO budget configured
 * in ai-service, so generation/embed is refused (402) rather than silently
 * spending. Distinct from `BudgetExceededError` (which means a configured cap
 * ran out) so a consumer can surface "ask the platform to provision a budget"
 * vs "top up". Additive — consumers catching `AIServiceError` are unaffected.
 */
export class BudgetNotConfiguredError extends AIServiceError {
  readonly org: string;
  constructor(message: string, org: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 402, body, meta);
    this.name = 'BudgetNotConfiguredError';
    this.org = org;
  }
}

/**
 * Fail-closed budget rejection, config-fault flavour: the org DOES have a
 * budget row, but the effort profile ai-service resolved for the call carries a
 * zero or non-finite `estimatedCostUsdPerCall`, so no hold could be placed and
 * the cap could not bind. ai-service refuses (402) rather than serve a call it
 * cannot meter.
 *
 * Distinct from `BudgetNotConfiguredError` because the remedy is different and
 * the usual advice would be WRONG here: the budget does not need provisioning
 * or topping up — an ADMIN has to fix `estimatedCostUsdPerCall` on the
 * project/registry effort profile. Surface `message`; it names the field and
 * the offending value.
 *
 * `estimatedCostUsdPerCall` is `null` when the resolved value was `NaN` or
 * `±Infinity` (JSON cannot carry those); the exact value is in `message`.
 *
 * Additive — consumers catching `AIServiceError` are unaffected, and a client
 * older than this class degrades to a plain `AIServiceError` with the same
 * status and message.
 */
export class BudgetMisconfiguredError extends AIServiceError {
  readonly org: string;
  readonly estimatedCostUsdPerCall: number | null;
  constructor(
    message: string,
    org: string,
    estimatedCostUsdPerCall: number | null,
    body: ErrorBody = {},
    meta: ErrorMeta = {},
  ) {
    super(message, 402, body, meta);
    this.name = 'BudgetMisconfiguredError';
    this.org = org;
    this.estimatedCostUsdPerCall = estimatedCostUsdPerCall;
  }
}

/**
 * The request never produced a response: it was cancelled, or it ran out of
 * time. `status` is 0 — nothing was answered, so there is no HTTP status to
 * report.
 *
 * 🔴 This exists as a TYPE because the transport must be able to tell it apart
 * from a transient failure. It used to be a bare `AIServiceError`, and the
 * timeout path did not even reach that: the timer aborted with a plain
 * `new Error(...)`, undici rejected with that reason verbatim, and the abort
 * detector matched only `AbortError`/`TimeoutError` by name. So a timeout
 * looked like an ordinary network fault and was RETRIED — a 100 ms timeout
 * became three attempts, and the caller got a plain `Error`, not a typed one.
 *
 * `reason` says which, because the remedy differs: `timeout` means the service
 * or the network is slow (raise `timeoutMs`, or check the deployment);
 * `cancel` means this process asked to stop and nothing is wrong.
 *
 * ⚠ Named `reason`, NOT `cause`. `Error.cause` is the standard error-chaining
 * slot, and this package walks it (`classifyBudgetFailure`); putting a string
 * discriminant there would both shadow the chain and hand the walker a
 * non-error to inspect.
 */
export class RequestAbortedError extends AIServiceError {
  readonly reason: 'timeout' | 'cancel';
  constructor(reason: 'timeout' | 'cancel', message: string, body: ErrorBody = {}) {
    super(message, 0, body);
    this.name = 'RequestAbortedError';
    this.reason = reason;
  }
}

export class IdempotencyConflictError extends ConflictError {
  readonly existingRequestId: string;
  constructor(
    message: string,
    existingRequestId: string,
    body: ErrorBody = {},
    meta: ErrorMeta = {},
  ) {
    super(message, body, meta);
    this.name = 'IdempotencyConflictError';
    this.existingRequestId = existingRequestId;
  }
}

/**
 * 429 from ai-service's `/v1` rate limiter.
 *
 * `retryAfterMs` is the SERVER'S OWN stated wait — the number a client must
 * honour instead of running a fixed backoff ladder that can expire before the
 * server would have accepted. It is read from the JSON body
 * (`errorResponseBuilder` sets `retryAfterMs: ctx.ttl`) and falls back to the
 * `Retry-After` response header, which is `Math.ceil(ttl / 1000)` of the same
 * value. `0` means the server gave no usable hint at all.
 *
 * Additive: extends `AIServiceError` with the same `status`/`body`, so a
 * consumer that catches `AIServiceError` is unaffected.
 */
export class RateLimitError extends AIServiceError {
  /** Server's stated wait in ms; `0` when it gave none. */
  override readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 429, body, { ...meta, retryAfterMs, retryable: meta.retryable ?? true });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// 0.17.0: a class per server discriminator
// ---------------------------------------------------------------------------
//
// Every class below was previously an untyped `AIServiceError` (or, for the
// 401/404 ones, the status-family class named in its doc comment). They are
// ADDITIVE: each extends what its instances already were, so no consumer
// branch that matched before stops matching. None of them carries extra
// fields, because none of the server classes puts any on the wire — the
// service's `bodyFields()` is empty for all of them, and `message` is the whole
// payload. `code` (`ERR_*`) is supplied by `WIRE_ERRORS`.

/**
 * The LLM provider is unavailable: ai-service's circuit breaker is open and
 * the call was never dialled. 503, RETRYABLE, and `retryAfterMs` is the
 * breaker's own cool-down — honour it instead of a fixed backoff ladder.
 *
 * Reachable from BOTH transports. On `/v1/generate*` it is a 503 with a
 * `Retry-After` header; mid-stream it is a terminal `error` frame carrying
 * `retryAfterMs`, where there is no status line and no header to read.
 */
export class ProviderUnavailableError extends AIServiceError {
  /** Server's stated cool-down in ms; `0` when it gave none. */
  override readonly retryAfterMs: number;
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    const wait = meta.retryAfterMs ?? (typeof body['retryAfterMs'] === 'number' ? (body['retryAfterMs'] as number) : 0);
    super(message, 503, body, { ...meta, retryAfterMs: wait, retryable: meta.retryable ?? true });
    this.name = 'ProviderUnavailableError';
    this.retryAfterMs = wait;
  }
}

/**
 * The upstream LLM provider exceeded ai-service's request timeout (504 on the
 * JSON transports, a terminal frame mid-stream). `ERR_PROVIDER_TIMEOUT`.
 *
 * `truncated` is `true` when ai-service cut the provider off with its own
 * deadline — in any pass, refine and extra samples included — and did NOT bill
 * the call (current server behaviour). It is `false` on the older
 * two-field body, which a server still sends when a process shutdown cuts a
 * call; that call WAS billed for the tokens the provider produced.
 */
export class ProviderTimeoutError extends AIServiceError {
  /** The provider was cut off by the request timeout and the call was not billed. */
  readonly truncated: boolean;
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 504, body, { ...meta, retryable: meta.retryable ?? true });
    this.name = 'ProviderTimeoutError';
    this.truncated = body['truncated'] === true;
  }
}

/**
 * The bearer token is a KNOWN key that has EXPIRED — distinct from a wrong or
 * missing one, because the remedy is rotation, not a credential hunt.
 * Extends `AuthError`, which is what this 401 already was.
 */
export class ApiKeyExpiredError extends AuthError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'ApiKeyExpiredError';
  }
}

/**
 * The prompt template failed to render — a Handlebars parse error, or a
 * variable the template requires and the request did not supply. 400: the
 * caller's input is at fault, and retrying it unchanged cannot help.
 */
export class RenderError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'RenderError';
  }
}

/** A registry write conflicted with an existing entry. 400, per the service. */
export class RegistryConflictError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'RegistryConflictError';
  }
}

/** The named registry entry does not exist. Extends `NotFoundError`. */
export class RegistryNotFoundError extends NotFoundError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'RegistryNotFoundError';
  }
}

/** A callback URL failed ai-service's SSRF guard. */
export class CallbackUrlBlockedError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'CallbackUrlBlockedError';
  }
}

/**
 * 400 from `POST /v1/ingest`: the request carried a `callbackUrl`, but this
 * API key has no `callbackSecret` in ai-service, so no callback could be
 * signed. A deployment misconfiguration — fix the key, do not retry.
 * New in 0.24.0.
 */
export class CallbackSecretMissingError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'CallbackSecretMissingError';
  }
}

/**
 * 404 from `GET /v1/ingest/:ingestId`: no ingest with that id exists in the
 * caller's org/project. Extends `NotFoundError`, so a `catch` on that (or on
 * status 404) keeps working. New in 0.24.0; servers before it answered 200
 * `status: 'processing'` for an unknown id.
 */
export class IngestNotFoundError extends NotFoundError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'IngestNotFoundError';
  }
}

/**
 * `language` is not an installed Postgres text-search config name. The message
 * names the value and the expected form — surface it verbatim.
 */
export class InvalidTextSearchConfigError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'InvalidTextSearchConfigError';
  }
}

/** A document's validity interval is malformed or inverted. */
export class InvalidValidityIntervalError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'InvalidValidityIntervalError';
  }
}

/**
 * The requested embedding model emits vectors of a different width than the
 * deployment's `chunks.embedding` column. A deployment-level mismatch: every
 * embed for the corpus would fail, so ai-service refuses up front.
 */
export class EmbeddingDimensionMismatchError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, 400, body, meta);
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * An alias points at a corpus that does not exist in this (org, project).
 * Distinct from `CorpusNotFoundError`: the corpus the CALLER named was found,
 * the alias TARGET was not. Extends `NotFoundError`.
 */
export class TargetCorpusNotFoundError extends NotFoundError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'TargetCorpusNotFoundError';
  }
}

/** The named document does not exist in the named corpus. */
export class DocumentNotFoundError extends NotFoundError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'DocumentNotFoundError';
  }
}

/** The alias name is already taken by a corpus — one shared namespace. */
export class AliasNameConflictError extends ConflictError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'AliasNameConflictError';
  }
}

/** A corpus with that name already exists. */
export class CorpusAlreadyExistsError extends ConflictError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'CorpusAlreadyExistsError';
  }
}

/** The corpus name is already taken by an alias — one shared namespace. */
export class CorpusNameIsAliasError extends ConflictError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'CorpusNameIsAliasError';
  }
}

/**
 * The corpus already has embedded chunks, so its `embeddingModel` is locked:
 * changing it would leave the existing vectors embedded with the old model.
 * Remedy (in `message`): delete + re-ingest.
 */
export class EmbeddingModelChangeNotAllowedError extends ConflictError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'EmbeddingModelChangeNotAllowedError';
  }
}

/**
 * `chunkSize` cannot be LOWERED on a corpus that already has chunks — the
 * existing ones were split at the larger size. Raising it is allowed.
 */
export class ChunkSizeShrinkNotAllowedError extends ConflictError {
  constructor(message: string, body: ErrorBody = {}, meta: ErrorMeta = {}) {
    super(message, body, meta);
    this.name = 'ChunkSizeShrinkNotAllowedError';
  }
}

/**
 * The subset of `Response.headers` this module needs. Typed structurally so a
 * test can pass a plain object and a browser/Node `Headers` both fit.
 */
export interface ResponseHeadersLike {
  get(name: string): string | null | undefined;
}

/**
 * Read the server's stated wait, body first, header second.
 *
 * 🔴 The header used to be UNREACHABLE: `HttpClient.json()` threw
 * `errorFromResponse(status, parsedBody)` and DISCARDED the `Response`, so no
 * consumer of this package could see any response header. Both products that
 * built their own ingest gate had to document that and read the body only. The
 * `Response` is now threaded through, so the header is a real fallback for any
 * deployment whose body shape predates `retryAfterMs`.
 *
 * Only `Retry-After` is extracted — the full header set is NOT retained on the
 * error. An error object is a thing people log, and a header snapshot is a
 * surface with no upside here.
 */
function retryAfterMsFrom(body: ErrorBody, headers?: ResponseHeadersLike): number {
  const fromBody = body.retryAfterMs;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  const raw = headers?.get('retry-after');
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const seconds = Number(raw.trim());
    // RFC 9110 allows delay-seconds OR an HTTP-date. ai-service sends seconds.
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Wire taxonomy: one table, both envelopes
// ---------------------------------------------------------------------------
//
// ai-service sends errors in TWO envelope shapes (`src/errors/base.ts` in the
// service repo):
//
//   flat    `{ error: '<ClassName>', ...fields, message }`   — most routes
//   nested  `{ error: { code: '<SCREAMING>', message } }`    — /v1/corpora,
//                                                              /v1/corpus
//
// The nested envelope's `code` IS the `ERR_` string minus its prefix, so the
// two can never drift. Until 0.17.0 this module read `body.error` as a STRING
// only: every nested-envelope class fell through unmatched, its real message
// was REPLACED by a synthetic "ai-service request failed (status 409)", and
// six 409s plus three 404s arrived indistinguishable. Both shapes parse now.
//
// `WIRE_ERRORS` is the single source of truth. Each entry:
//
//   key    the discriminator ON THE WIRE — the class name for a flat body, the
//          SCREAMING code for a nested one. Never both: a server class sends
//          one envelope.
//   reach  whether that key ACTUALLY reaches the wire. Spelling parity is not
//          reachability, and conflating the two is how a table can be 100%
//          correct and still leave a consumer unable to branch. See the
//          `Reachability` type below for what each value means and how the
//          counts were measured.
//   code   the server's stable `ERR_` string, or `null` for the two
//          discriminators ai-service emits WITHOUT a taxonomy class:
//          `api_key_expired` (the auth plugin) and `RateLimitExceeded` (the
//          rate-limit plugin). Those two have no `ERR_` string to carry.
//          (`ProviderTimeout` was a third until the server
//          gave it the `ERR_PROVIDER_TIMEOUT` taxonomy class.)
//   ctor   the class to build. Absent for the seven classes that read extra
//          body fields; those are built by the `switch` in `errorFromResponse`
//          and are listed here for their `code` alone.
//
// `scripts/check-error-parity.mjs` diffs the `code` column against every
// `ERR_` string declared in the service's `src/`, so a class added there
// without a mapping here fails the check instead of degrading silently.

/** A thin error class: `message` plus the raw body is all it needs. */
type ThinErrorCtor = new (message: string, body?: ErrorBody, meta?: ErrorMeta) => AIServiceError;

/**
 * Does this entry's discriminator reach a caller, measured against a running
 * ai-service — NOT inferred from the table agreeing with the server's spelling.
 *
 *   'typed'       the discriminator reaches the wire and resolves to its class.
 *   'flattened'   a route catches the class and re-sends it through
 *                 fastify-sensible (`reply.badRequest` / `reply.notFound`),
 *                 which emits `{statusCode, error: 'Bad Request' | 'Not Found',
 *                 message}`. The taxonomy discriminator is GONE by the time the
 *                 body is serialised, and the envelope carries no `code`, so
 *                 the class is NOT branchable — only the status family
 *                 (`BadRequestError` / `NotFoundError`) and the message survive.
 *
 *                 ✅ NO ENTRY USES THIS ANY MORE. Six did until ai-service
 *                 removed the seven route sites that
 *                 flattened them; the value is KEPT so the next route that
 *                 reintroduces the pattern has an honest word for it rather
 *                 than being recorded as 'typed'.
 *   'unverified'  mapped and believed correct, but not exercised end-to-end in
 *                 the harness that measured the others. Not a claim of breakage.
 *
 * `expose = false` classes are not here at all — they never reach a caller and
 * live in `SERVER_ONLY_ERROR_CODES`.
 *
 * ⚠ That transition needed NO client change, and this is why: `errorFromResponse`
 * resolves a flat body by its `error` discriminator, and failing that by a
 * body-carried `code` (see `DISCRIMINATOR_BY_CODE`). The six classes send both.
 * Any 0.17.0-or-later consumer got the precise class the moment the server
 * deployed, with no republish.
 */
export type Reachability = 'typed' | 'flattened' | 'unverified';

export interface WireErrorEntry {
  /** The server's `ERR_` string, or `null` when the server declares none. */
  readonly code: string | null;
  /** Class to construct; absent when `errorFromResponse` builds it by hand. */
  readonly ctor?: ThinErrorCtor;
  /** Measured, not assumed — see `Reachability`. Required on every entry. */
  readonly reachable: Reachability;
}

/**
 * `ERR_` codes that exist on the server but can NEVER reach a caller: both
 * classes declare `expose = false`, so ai-service answers a generic 500 and
 * the detail goes only to its own logs. Listed so the parity check accounts
 * for every server code explicitly rather than allow-listing by silence.
 */
export const SERVER_ONLY_ERROR_CODES: readonly string[] = [
  'ERR_SPARSE_EMBED_NOT_CONFIGURED',
  'ERR_RERANK_NOT_CONFIGURED',
  // Two more rerank DEPLOYMENT faults, same `expose = false` reasoning as the
  // one above: both mean the operator misconfigured the rung, neither is
  // anything a caller can act on, and both messages quote configuration.
  //   CREDENTIAL_MISSING — a hosted provider with no RERANK_API_KEY.
  //   ENDPOINT_INVALID   — RERANK_URL that cannot address a model for the
  //                        configured provider (e.g. a full DeepInfra
  //                        inference URL where the API base is wanted).
  // They refuse BEFORE the network rather than 401/404-ing into the rerank
  // fail-safe, which would leave a response indistinguishable from rerank off.
  'ERR_RERANK_CREDENTIAL_MISSING',
  'ERR_RERANK_ENDPOINT_INVALID',
  // The PII minimiser is the one model-server capability that must FAIL CLOSED.
  // rerank degrades to the fused order and sparse degrades to the tsvector leg,
  // but a minimiser that silently no-ops ships raw PII to the provider — so it
  // refuses the call instead. Both stay `expose = false` deliberately: the
  // message can quote the text that failed to scrub, which is the last thing
  // that should cross the wire.
  'ERR_PII_MINIMISATION_FAILED',
  'ERR_PII_NER_NOT_CONFIGURED',
];

export const WIRE_ERRORS: Readonly<Record<string, WireErrorEntry>> = {
  // ── flat envelope, extra body fields → built by the switch below ────────
  BudgetExceeded: { code: 'ERR_BUDGET_EXCEEDED', reachable: 'typed' },
  BudgetNotConfigured: { code: 'ERR_BUDGET_NOT_CONFIGURED', reachable: 'typed' },
  // Needs a budget row that exists but cannot be priced — not reproducible in
  // the harness that measured the rest, so recorded as unverified, not typed.
  BudgetMisconfigured: { code: 'ERR_BUDGET_MISCONFIGURED', reachable: 'unverified' },
  IdempotencyConflict: { code: 'ERR_IDEMPOTENCY_CONFLICT', reachable: 'typed' },
  SpecResolutionError: { code: 'ERR_SPEC_RESOLUTION', reachable: 'typed' },
  DependencyCycleError: { code: 'ERR_DEPENDENCY_CYCLE', reachable: 'typed' },
  CrossBatchDependencyError: { code: 'ERR_DEPENDENCY_OUT_OF_BATCH', reachable: 'typed' },
  ProviderUnavailable: {
    code: 'ERR_PROVIDER_UNAVAILABLE',
    ctor: ProviderUnavailableError,
    reachable: 'typed',
  },

  // ── flat envelope, message-only ────────────────────────────────────────
  RenderError: { code: 'ERR_RENDER', ctor: RenderError, reachable: 'typed' },

  // ── flat envelope + `code`, WAS flattened until the server's route-errors change
  // These six extend the server's `CodedEnvelopeError`, so their body is
  // `{error: '<ClassName>', code: 'ERR_*', message}` and BOTH resolution passes
  // in `errorFromResponse` find them. Pinned server-side in
  // `src/errors/wire-golden.test.ts`.
  //
  // ⚠ `RegistryConflictError` answers 400, NOT the 409 its name suggests. That
  // was true while it was flattened and is still true: the class declares 400,
  // which is what `POST /v1/registry/…/versions` has answered since M3. Branch
  // on the class or on `code`, never on the status.
  RegistryConflictError: {
    code: 'ERR_REGISTRY_CONFLICT',
    ctor: RegistryConflictError,
    reachable: 'typed',
  },
  // 404. Was `reply.notFound`, i.e. a generic NotFoundError.
  RegistryNotFoundError: {
    code: 'ERR_REGISTRY_NOT_FOUND',
    ctor: RegistryNotFoundError,
    reachable: 'typed',
  },
  // 400 from POST /v1/ingest and POST /v1/generate — the SSRF guard's rejection.
  CallbackUrlBlockedError: {
    code: 'ERR_CALLBACK_URL_BLOCKED',
    ctor: CallbackUrlBlockedError,
    reachable: 'typed',
  },
  // 400 from POST /v1/ingest — `callbackUrl` from a key with no callbackSecret.
  // Server-side unit-tested through the route; not yet measured on a deploy.
  CallbackSecretMissingError: {
    code: 'ERR_CALLBACK_SECRET_MISSING',
    ctor: CallbackSecretMissingError,
    reachable: 'unverified',
  },
  // 404 from GET /v1/ingest/:ingestId. Same status as before 0.24.0 never
  // existed: the route used to answer 200 `processing` for an unknown id.
  IngestNotFoundError: {
    code: 'ERR_INGEST_NOT_FOUND',
    ctor: IngestNotFoundError,
    reachable: 'unverified',
  },
  // 400 from PATCH /v1/corpora/:name. Still hard to provoke through the wire:
  // `corpusUpdateSchema` rejects an unknown `language` with its own 400 before
  // the service-level gate can throw. Typed if it ever does.
  InvalidTextSearchConfigError: {
    code: 'ERR_INVALID_TEXT_SEARCH_CONFIG',
    ctor: InvalidTextSearchConfigError,
    reachable: 'typed',
  },
  // 400 from PATCH /v1/corpus/:name/documents/:externalId/validity.
  InvalidValidityIntervalError: {
    code: 'ERR_INVALID_VALIDITY_INTERVAL',
    ctor: InvalidValidityIntervalError,
    reachable: 'typed',
  },
  // 400 from POST /v1/corpora, PATCH /v1/corpora/:name and POST /v1/ingest.
  EmbeddingDimensionMismatchError: {
    code: 'ERR_EMBEDDING_DIMENSION_MISMATCH',
    ctor: EmbeddingDimensionMismatchError,
    reachable: 'typed',
  },

  // ── nested envelope: `{ error: { code, message } }` ─────────────────────
  // KEPT, not migrated to the flat shape. It is what every consumer of
  // `/v1/corpora` and `/v1/corpus` parses, and this client resolves it to the
  // precise class. `POST /v1/retrieve` used to answer `CORPUS_NOT_FOUND` with
  // fastify-sensible's FLAT envelope instead — one class, two shapes. It sends
  // the nested one now, so every route agrees.
  CORPUS_NOT_FOUND: {
    code: 'ERR_CORPUS_NOT_FOUND',
    ctor: CorpusNotFoundError,
    reachable: 'typed',
  },
  TARGET_CORPUS_NOT_FOUND: {
    code: 'ERR_TARGET_CORPUS_NOT_FOUND',
    ctor: TargetCorpusNotFoundError,
    reachable: 'typed',
  },
  DOCUMENT_NOT_FOUND: {
    code: 'ERR_DOCUMENT_NOT_FOUND',
    ctor: DocumentNotFoundError,
    reachable: 'typed',
  },
  ALIAS_NAME_CONFLICT: {
    code: 'ERR_ALIAS_NAME_CONFLICT',
    ctor: AliasNameConflictError,
    reachable: 'typed',
  },
  CORPUS_ALREADY_EXISTS: {
    code: 'ERR_CORPUS_ALREADY_EXISTS',
    ctor: CorpusAlreadyExistsError,
    reachable: 'typed',
  },
  CORPUS_NAME_IS_ALIAS: {
    code: 'ERR_CORPUS_NAME_IS_ALIAS',
    ctor: CorpusNameIsAliasError,
    reachable: 'typed',
  },
  EMBEDDING_MODEL_LOCKED: {
    code: 'ERR_EMBEDDING_MODEL_LOCKED',
    ctor: EmbeddingModelChangeNotAllowedError,
    reachable: 'typed',
  },
  CHUNK_SIZE_LOCKED: {
    code: 'ERR_CHUNK_SIZE_LOCKED',
    ctor: ChunkSizeShrinkNotAllowedError,
    reachable: 'typed',
  },

  // ── no taxonomy class on the server, so no `ERR_` string ────────────────
  ProviderTimeout: { code: 'ERR_PROVIDER_TIMEOUT', ctor: ProviderTimeoutError, reachable: 'typed' },
  api_key_expired: { code: null, ctor: ApiKeyExpiredError, reachable: 'typed' },
  RateLimitExceeded: { code: null, reachable: 'typed' },
};

/**
 * `ERR_` string → wire discriminator, derived from `WIRE_ERRORS` so the two can
 * never drift.
 *
 * This was the forward-compatibility hook for the six then-'flattened' entries,
 * and it paid off: ai-service's route-errors change gives those six a body
 * carrying the `ERR_` string, so every consumer already on 0.17.0 or later
 * resolves them to the precise class with no republish. It stays for the next
 * envelope that carries a `code` without a discriminator this client knows.
 */
const DISCRIMINATOR_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WIRE_ERRORS)
    .filter(([, entry]) => entry.code !== null)
    .map(([discriminator, entry]) => [entry.code as string, discriminator]),
);

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * The wire discriminator and the caller-facing message, from either envelope.
 *
 * The nested envelope carries its own `message` INSIDE the `error` object. The
 * pre-0.17.0 code read `body.message` only, found nothing, and substituted
 * `ai-service request failed (status N)` — throwing away the one field that
 * told an operator which corpus, alias or document was at fault.
 */
function discriminate(
  body: ErrorBody,
  status: number,
): { discriminator: string | undefined; message: string } {
  const nested = nestedEnvelope(body);
  const fallback = `ai-service request failed (status ${status})`;
  if (nested !== undefined) {
    return {
      discriminator: typeof nested.code === 'string' ? nested.code : undefined,
      message:
        typeof nested.message === 'string' && nested.message.length > 0
          ? nested.message
          : (body.message ?? fallback),
    };
  }
  return {
    discriminator: typeof body.error === 'string' ? body.error : undefined,
    message: body.message ?? fallback,
  };
}

/**
 * The wire discriminator a body's taxonomy `code` implies, when the body's own
 * `error` field did not name one this client knows.
 *
 * Reuses `codeFromBody`, which already normalises the two places a code can
 * live and rejects Fastify's unrelated `FST_ERR_*` strings.
 */
function discriminatorFromCode(body: ErrorBody): string | undefined {
  const code = codeFromBody(body);
  return code !== undefined ? DISCRIMINATOR_BY_CODE[code] : undefined;
}

/**
 * Convert a non-2xx HTTP response into the most specific error class
 * available. `headers` is optional and used only to recover the server's
 * `Retry-After` when the body carries no `retryAfterMs`.
 *
 * Resolution order: the wire discriminator (either envelope), then a taxonomy
 * `code` carried in the body, then a status-code fallback (400/401/403/404/409),
 * then a plain `AIServiceError`. Every arm carries the
 * server's `code` when `WIRE_ERRORS` knows one, so a consumer can branch on
 * `err.code` even for a class this client version predates.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: ResponseHeadersLike,
): AIServiceError {
  const safeBody: ErrorBody =
    body && typeof body === 'object' ? (body as ErrorBody) : { message: String(body ?? '') };
  const { discriminator: wireDiscriminator, message } = discriminate(safeBody, status);
  // Resolution order: the wire discriminator first; failing that, a taxonomy
  // `code` the body happens to carry. The second pass is what lets a generic
  // envelope (fastify-sensible's `error: 'Bad Request'`) still resolve to a
  // precise class IF the server includes the `ERR_` string — see
  // `DISCRIMINATOR_BY_CODE`.
  const discriminator =
    wireDiscriminator !== undefined && wireDiscriminator in WIRE_ERRORS
      ? wireDiscriminator
      : discriminatorFromCode(safeBody) ?? wireDiscriminator;
  const entry = discriminator !== undefined ? WIRE_ERRORS[discriminator] : undefined;
  const meta: ErrorMeta = entry?.code != null ? { code: entry.code } : {};

  // Rate limits are checked BEFORE the discriminator switch so a 429 is typed
  // even from a deployment whose body carries no `error` field at all.
  if (status === 429 || discriminator === 'RateLimitExceeded') {
    return new RateLimitError(message, retryAfterMsFrom(safeBody, headers), safeBody, meta);
  }

  switch (discriminator) {
    case 'BudgetExceeded':
      return new BudgetExceededError(
        message,
        {
          org: String(safeBody['org'] ?? ''),
          requested: Number(safeBody['requested'] ?? 0),
          remaining: Number(safeBody['remaining'] ?? 0),
          shortfallUsd: Number(safeBody['shortfallUsd'] ?? 0),
        },
        safeBody,
        meta,
      );
    case 'BudgetNotConfigured':
      return new BudgetNotConfiguredError(message, String(safeBody['org'] ?? ''), safeBody, meta);
    case 'BudgetMisconfigured':
      return new BudgetMisconfiguredError(
        message,
        String(safeBody['org'] ?? ''),
        typeof safeBody['estimatedCostUsdPerCall'] === 'number'
          ? (safeBody['estimatedCostUsdPerCall'] as number)
          : null,
        safeBody,
        meta,
      );
    case 'IdempotencyConflict':
      return new IdempotencyConflictError(
        message,
        String(safeBody['existingRequestId'] ?? ''),
        safeBody,
        meta,
      );
    case 'SpecResolutionError':
      return new SpecResolutionError(message, String(safeBody['cause'] ?? ''), safeBody, meta);
    case 'DependencyCycleError':
      return new DependencyCycleError(
        message,
        Array.isArray(safeBody['cycle']) ? (safeBody['cycle'] as string[]) : [],
        safeBody,
        meta,
      );
    case 'CrossBatchDependencyError':
      return new CrossBatchDependencyError(
        message,
        Array.isArray(safeBody['missing']) ? (safeBody['missing'] as string[]) : [],
        safeBody,
        meta,
      );
  }

  // Every remaining mapped discriminator is a message-only class.
  if (entry?.ctor !== undefined) {
    const wait =
      entry.ctor === ProviderUnavailableError
        ? { retryAfterMs: retryAfterMsFrom(safeBody, headers) }
        : {};
    return new entry.ctor(message, safeBody, { ...meta, ...wait });
  }

  switch (status) {
    case 400:
      return new BadRequestError(message, safeBody, meta);
    case 401:
      return new AuthError(message, safeBody, meta);
    case 403:
      return new ForbiddenError(message, safeBody, meta);
    case 404:
      return new NotFoundError(message, safeBody, meta);
    case 409:
      return new ConflictError(message, safeBody, meta);
  }
  return new AIServiceError(message, status, safeBody, meta);
}
