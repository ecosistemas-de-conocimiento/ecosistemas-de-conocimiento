/**
 * Retrieval outcome — the one rule for telling "no documents" from "retrieval
 * is down".
 *
 * Why it exists (audit `ai-reality-audit` §3 item 7, pattern P2):
 * every consumer caught retrieval errors and carried on, so a 401, a 429, a 5xx
 * or a dead network produced an ungrounded answer or "no requirement matches".
 * An outage read as an empty corpus. The rule, approved:
 *
 *   - 404 with a taxonomy code (`CORPUS_NOT_FOUND`, `TARGET_CORPUS_NOT_FOUND`,
 *     `DOCUMENT_NOT_FOUND`) → `{ kind: 'empty' }`. A new chat session with no
 *     corpus yet is normal, not an incident.
 *   - 200 with no chunks → `{ kind: 'empty', reason: 'no_match' }`.
 *   - 200 with chunks → `{ kind: 'hits' }`.
 *   - EVERYTHING else → throw `RetrievalUnavailableError`. The consumer answers
 *     5xx with `grounding: 'none'` in the answer's provenance and UI, and never
 *     falls back to an ungrounded answer (health-check-contract Rule 1:
 *     ai-service is required).
 *
 * ⚠ A 404 WITHOUT a taxonomy code is an outage. That is Fastify's "route not
 * found" — a wrong base URL, a proxy, or a deployment that predates the route.
 * Reading it as empty is exactly the bug this module exists to stop.
 *
 * ⚠ A caller-initiated cancel (`RequestAbortedError` with `reason: 'cancel'`)
 * is rethrown unchanged: the caller stopped, nothing is down.
 */

import {
  AIServiceError,
  CorpusNotFoundError,
  DocumentNotFoundError,
  RequestAbortedError,
  TargetCorpusNotFoundError,
} from './errors.js';

/** Why a retrieval legitimately found nothing. */
export type EmptyRetrievalReason = 'corpus_not_found' | 'document_not_found' | 'no_match';

/**
 * The typed result of `client.retrieve.retrieveOutcome` /
 * `retrieveMultiOutcome`. `result` is the full server response when there was
 * one (a 200), so `legs`, `corpora`, `query` and `rewritten` stay reachable.
 */
export type RetrievalOutcome<THit, TResult = unknown> =
  | { kind: 'hits'; hits: THit[]; result?: TResult; traceId?: string }
  | { kind: 'empty'; reason: EmptyRetrievalReason; result?: TResult; traceId?: string };

/**
 * What went wrong, coarse enough to branch on:
 *   - `auth`        401 / 403 — key wrong, expired, or lacking scope
 *   - `budget`      402 — the org's AI budget refused the call
 *   - `rate_limit`  429
 *   - `server`      5xx
 *   - `network`     fetch rejected (DNS, refused, reset)
 *   - `timeout`     the client's own deadline fired
 *   - `not_found`   404 with no taxonomy code (route missing — see module doc)
 *   - `corpus_failed` `/v1/retrieve/multi` answered 200 but a corpus errored
 *   - `invalid_response` a 200 whose body is not the retrieval shape
 *   - `bad_request` any other 4xx — a consumer bug, still not "empty"
 */
export type RetrievalUnavailableKind =
  | 'auth'
  | 'budget'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'corpus_failed'
  | 'invalid_response'
  | 'bad_request';

export interface RetrievalUnavailableInit {
  /** HTTP status from ai-service; `0` when no response arrived. */
  status: number;
  kind: RetrievalUnavailableKind;
  retryable: boolean;
  /** ai-service's `x-request-id`, when a response arrived. */
  traceId?: string | undefined;
  /** `/v1/retrieve/multi` only: the corpora whose diagnostics say `failed`. */
  failedCorpora?: string[] | undefined;
  message?: string | undefined;
  cause?: unknown;
}

/**
 * Retrieval could not run. The answer has NO grounding: surface it as 5xx and
 * mark the answer `grounding: 'none'` — never answer ungrounded instead.
 */
export class RetrievalUnavailableError extends Error {
  readonly status: number;
  readonly kind: RetrievalUnavailableKind;
  readonly retryable: boolean;
  readonly traceId: string | undefined;
  readonly failedCorpora: string[] | undefined;
  constructor(init: RetrievalUnavailableInit) {
    super(
      init.message ?? `ai-service retrieval unavailable (${init.kind}, status ${init.status})`,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'RetrievalUnavailableError';
    this.status = init.status;
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.traceId = init.traceId;
    this.failedCorpora = init.failedCorpora;
  }
}

function kindForStatus(status: number): RetrievalUnavailableKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'budget';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/**
 * Map an error thrown by any ai-client retrieval call onto the rule: an
 * `empty` outcome for the typed 404s, a `RetrievalUnavailableError` for the
 * rest. A caller cancel is returned unchanged so the caller can rethrow it.
 *
 * For consumers wrapping a call this package does not wrap (a raw fetch, an
 * older client): `catch (e) { const o = toRetrievalOutcomeError(e); if (o
 * instanceof Error) throw o; return o; }`.
 */
export function toRetrievalOutcomeError(
  err: unknown,
  traceId?: string,
): { kind: 'empty'; reason: EmptyRetrievalReason } | RetrievalUnavailableError | RequestAbortedError {
  if (err instanceof RetrievalUnavailableError) return err;
  if (err instanceof RequestAbortedError) {
    if (err.reason === 'cancel') return err;
    return new RetrievalUnavailableError({
      status: 0,
      kind: 'timeout',
      retryable: true,
      traceId,
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof CorpusNotFoundError || err instanceof TargetCorpusNotFoundError) {
    return { kind: 'empty', reason: 'corpus_not_found' };
  }
  if (err instanceof DocumentNotFoundError) return { kind: 'empty', reason: 'document_not_found' };
  if (err instanceof AIServiceError) {
    const kind = kindForStatus(err.status);
    return new RetrievalUnavailableError({
      status: err.status,
      kind,
      retryable: err.retryable || kind === 'rate_limit' || kind === 'server',
      traceId,
      message: err.message,
      cause: err,
    });
  }
  return new RetrievalUnavailableError({
    status: 0,
    kind: 'network',
    retryable: true,
    traceId,
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

// ---------------------------------------------------------------------------
// Grounding provenance
// ---------------------------------------------------------------------------

/**
 * What an answer stood on:
 *   - `retrieved` — retrieval returned passages
 *   - `empty`     — retrieval ran and legitimately found nothing
 *   - `none`      — retrieval did not run or failed; the answer is unsupported
 */
export type Grounding = 'retrieved' | 'empty' | 'none';

/** The field name every consumer uses for {@link Grounding} in an answer's provenance. */
export const GROUNDING_FIELD = 'grounding' as const;

/** `groundingOf(outcome)`; anything that is not an outcome (an error, `undefined`) is `none`. */
export function groundingOf(outcome: unknown): Grounding {
  if (outcome && typeof outcome === 'object' && 'kind' in outcome) {
    const kind = (outcome as { kind: unknown }).kind;
    if (kind === 'hits') return 'retrieved';
    if (kind === 'empty') return 'empty';
  }
  return 'none';
}

/**
 * Shown when retrieval ran and found nothing (`grounding: 'empty'`). Generic on
 * purpose (ADR-0001): a product may prefix its own noun ("del municipio"), but
 * must keep it distinct from the unavailable sentence.
 */
export const RETRIEVAL_EMPTY_MESSAGE =
  'No encontré información en los documentos disponibles para responder esto. Intenta reformular la pregunta o verifica que se hayan subido documentos relevantes.';

/**
 * The one "AI unavailable" sentence. It names the only action that resolves the
 * commonest cause (a missing budget row) and deliberately says nothing about
 * time: "try again in a few minutes" promised a recovery waiting cannot bring.
 */
export const AI_UNAVAILABLE_MESSAGE =
  'El servicio de IA no está disponible. Contacta a la persona que administra el sistema.';

/** Shown when retrieval could not run (`grounding: 'none'`). Same sentence. */
export const RETRIEVAL_UNAVAILABLE_MESSAGE = AI_UNAVAILABLE_MESSAGE;
