// ONE error taxonomy for ai-service.
//
// Before this module every error class declared its own ad-hoc shape and the
// route layer re-decided, per `instanceof` arm, what status and body it got.
// A new class therefore defaulted to a Fastify 500 — silently, because nothing
// forces a route to know about it. The taxonomy inverts that: the CLASS owns
// its wire contract, declared once, and the mappers are generic.
//
// Four properties, declared by every class:
//   `code`      the stable machine string, `ERR_*`. Logs, traces and metrics
//               group on this; a couple of classes also put it on the wire.
//   `status`    the HTTP status. The stream transport has no status line, so
//               there it only decides "was this the client's fault".
//   `retryable` is it worth asking again with the same input.
//   `expose`    may the message and fields reach the caller. FALSE means the
//               caller gets a generic 500 and the detail goes to pino only —
//               the same posture as the readiness-body redaction in
//               `routes/health-ready.test.ts`. Default TRUE, so a class that
//               can carry an upstream body snippet must say `expose = false`.
//
//               ⚠ `expose = false` only redacts because the /v1 error handler
//               ANSWERS that case itself (`server.ts`). Rethrowing to Fastify
//               does NOT redact: Fastify 5's `setErrorHeaders` reads
//               `error.status` before `error.statusCode`, and then puts
//               `error.message` and `error.code` on the body — so the rethrow
//               published both the real status and the full message. Pinned by
//               `src/errors/redaction.test.ts`.
//
// ── What is deliberately NOT in the hierarchy ─────────────────────────────
// The upstream-HTTP adapter errors — `OpenRouterHttpError`,
// `OpenRouterEmbeddingHttpError`, `SparseEmbedHttpError`, `RerankHttpError`,
// `OpenRouterCreditsError`, `OpenRouterAbortError` — stay plain `Error`
// subclasses. They already carry a `code` field whose meaning is THE
// UPSTREAM'S error code (`err.code` is read into an `errorCode` trace field in
// `services/ai/router/router.ts`, and `resilience.ts` keys retry decisions off
// it), so reusing that name for an `ERR_*` string would silently change what a
// retry ladder reads. They also never reach a caller: nothing maps them, so
// they land on Fastify's generic 500, which is the behaviour we want anyway.
// They describe an UPSTREAM's failure; this hierarchy describes OURS.

/**
 * Base class for every error ai-service raises about a request.
 *
 * Subclasses declare `code` and `status` once and inherit the wire mapping.
 * Override `bodyFields()` to add fields to the JSON body, `wireError` when the
 * discriminator on the wire differs from the class name, and `toBody()` only
 * when the whole envelope differs (see `NestedEnvelopeError`).
 */
export abstract class AiServiceError extends Error {
  /**
   * Brand, not `instanceof`. Two resolutions of the same module file produce
   * two distinct classes, and an `instanceof` chain misses one of them — the
   * exact hazard `classifyStreamError` used to paper over by duck-typing on
   * `err.name`. A plain own property survives that.
   */
  readonly isAiServiceError = true as const;

  /** Stable machine string, `ERR_*`. */
  abstract readonly code: string;

  /** HTTP status for the JSON transports. */
  abstract readonly status: number;

  /** Is the same request worth retrying unchanged? */
  readonly retryable: boolean = false;

  /** May `message` and `bodyFields()` reach the caller? */
  readonly expose: boolean = true;

  /**
   * Can this error be raised AFTER the SSE reply is hijacked? Only those
   * classes may name themselves in a terminal `error` frame; everything else
   * collapses to `INTERNAL`, so a class that becomes mid-stream-reachable has
   * to opt in deliberately rather than start leaking by accident.
   */
  readonly midStream: boolean = false;

  /** Response headers this error requires (e.g. `Retry-After`). */
  readonly headers?: Record<string, string> | undefined;

  /**
   * The `error` discriminator on the wire. Defaults to the class name, which
   * is what `@edc/ai-client`'s `errorFromResponse` switches on.
   */
  get wireError(): string {
    return this.name;
  }

  /** Class-specific body fields, merged between `error` and `message`. */
  protected bodyFields(): Record<string, unknown> {
    return {};
  }

  /** The JSON body this error sends. */
  toBody(): Record<string, unknown> {
    return { error: this.wireError, ...this.bodyFields(), message: this.message };
  }

  /**
   * Extra fields for the terminal SSE frame. The reply is hijacked before the
   * first byte, so anything a JSON caller would have read off the STATUS LINE
   * or a HEADER has to be re-expressed here or it is simply lost.
   */
  streamFields(): Record<string, unknown> {
    return {};
  }
}

/**
 * A flat-envelope error that ALSO puts its `ERR_` string on the wire:
 * `{ error: '<ClassName>', code: 'ERR_*', ...fields, message }`.
 *
 * Why a second flat base rather than putting `code` on every `toBody()`: the
 * classes `/v1/generate*` has always mapped (SpecResolutionError, RenderError,
 * the three budget classes, …) have a pinned body in `wire-golden.test.ts` and
 * consumers parsing it today; adding a field to those is a wire change with no
 * caller asking for it. The classes here are the opposite case — until this
 * commit a route caught each of them and re-sent it through fastify-sensible,
 * so NO consumer has ever seen their real envelope. Giving them `code` from
 * the first day they reach the wire means `@edc/ai-client`'s
 * `DISCRIMINATOR_BY_CODE` fallback resolves them even on a client version that
 * predates the class name, so a consumer can branch on `err.code` without a
 * client bump.
 */
export abstract class CodedEnvelopeError extends AiServiceError {
  override toBody(): Record<string, unknown> {
    return {
      error: this.wireError,
      code: this.code,
      ...this.bodyFields(),
      message: this.message,
    };
  }
}

/**
 * The RAG control-plane routes (`/v1/corpora`, `/v1/corpus`) predate the flat
 * envelope and send `{ error: { code, message } }` with a SCREAMING_SNAKE code.
 * Kept exactly as-is: consumers parse it, and unifying it would be a wire
 * break for no functional gain. Subclasses set `wireError` to that code.
 *
 * ── ONE CLASS, ONE ENVELOPE (was: a known exception) ──────────────────────
 * `CorpusNotFoundError` used to go out in TWO shapes: the nested one from
 * `/v1/corpora` and `/v1/corpus`, and fastify-sensible's flat
 * `{statusCode, error: 'Not Found', message}` from `routes/retrieve.ts`, which
 * caught the class and answered `reply.notFound(err.message)`.
 * `routes/registry.ts` did the same to its own two FLAT classes. Those catches
 * are gone: every route now rethrows and the ONE `/v1` error handler sends the
 * class's own `toBody()`, so a class has exactly one wire shape again.
 *
 * The nested envelope is KEPT for the eight classes that already use it. It is
 * older than the flat one, but it is the shape every consumer of `/v1/corpora`
 * and `/v1/corpus` parses today and `@edc/ai-client` resolves it to the
 * precise class (`WIRE_ERRORS` keys those entries by the SCREAMING code).
 * Converting them to flat would break every consumer on a client older than
 * 0.17.0 for no functional gain.
 *
 * `services/context/fetch.ts` still SWALLOWS `CorpusNotFoundError` to return an
 * empty context. That is not a second envelope — it is a deliberate non-error
 * path with no wire shape at all.
 */
export abstract class NestedEnvelopeError extends AiServiceError {
  /**
   * The envelope's `code` IS the `ERR_` string minus its prefix, so a class
   * declares the pair once and the two can never drift apart.
   */
  override get wireError(): string {
    return this.code.startsWith('ERR_') ? this.code.slice('ERR_'.length) : this.code;
  }

  override toBody(): Record<string, unknown> {
    return { error: { code: this.wireError, message: this.message } };
  }
}

/** Brand check — see `AiServiceError.isAiServiceError`. */
export function isAiServiceError(err: unknown): err is AiServiceError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isAiServiceError?: unknown }).isAiServiceError === true
  );
}
