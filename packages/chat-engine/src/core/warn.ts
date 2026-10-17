/**
 * The one way this package reports a failure it survives.
 *
 * Every best-effort step (condense, scope, ref resolve, retrieve, graph, title) keeps
 * its fallback — a turn never breaks on a context step — but the fallback is
 * never SILENT: it calls `warnEngine`, which writes ONE `console.warn` with
 *   1. a line for humans: `[chat-engine] <event> status=<n> (<ErrorName>)`
 *   2. a structured payload for machines and tests: `EngineWarning`.
 * Assert on / alert on `event`, never on the line's wording.
 *
 * 🔴 NAME AND STATUS ONLY. Never the error message, the user's text, the
 * query, a model output or document content: an upstream message can carry a
 * response body or a bearer token, and this runs inside hosts holding service
 * credentials.
 */

export type EngineWarningEvent =
  | 'condense.failed'
  | 'condense.unusable'
  | 'scope.failed'
  | 'ref.failed'
  | 'retrieve.failed'
  | 'retrieve.multi_unavailable'
  | 'graph.failed'
  | 'title.failed'
  | 'sync.docs.failed'
  | 'sync.ingest.failed'
  | 'backfill.entities.failed';

export interface EngineWarning {
  event: EngineWarningEvent;
  /**
   * `Error.name`, or `typeof` for a non-Error throw. Absent when nothing was
   * thrown. `UNSAFE_ERROR_NAME` when the name is not an identifier-like token.
   */
  errorName?: string;
  /** An integer `status` on the thrown value (HTTP status from the AI client). */
  status?: number;
}

/**
 * `Error.name` is writable by whoever threw — a custom error can put any text
 * there, including a message or a token. Only an identifier-like token of at
 * most 64 chars is logged; anything else is replaced WHOLE (stripping the bad
 * characters would still leak the letters).
 */
const SAFE_ERROR_NAME = /^[A-Za-z0-9_]{1,64}$/;
export const UNSAFE_ERROR_NAME = 'UnsafeErrorName';

export function describeError(err: unknown): Pick<EngineWarning, 'errorName' | 'status'> {
  const status = (err as { status?: unknown } | null)?.status;
  const rawName = err instanceof Error ? err.name : typeof err;
  return {
    errorName: SAFE_ERROR_NAME.test(rawName) ? rawName : UNSAFE_ERROR_NAME,
    ...(Number.isInteger(status) ? { status: status as number } : {}),
  };
}

/** Warn once for a survived failure. Pass `err` only when something was thrown. */
export function warnEngine(event: EngineWarningEvent, ...err: [] | [unknown]): void {
  const payload: EngineWarning = { event, ...(err.length ? describeError(err[0]) : {}) };
  const status = payload.status !== undefined ? ` status=${payload.status}` : '';
  const name = payload.errorName ? ` (${payload.errorName})` : '';
  console.warn(`[chat-engine] ${event}${status}${name}`, payload);
}
