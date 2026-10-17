// Wire mapping for the two `/v1/generate*` transports.
//
// Both mappers are pure functions over an error value: testable without
// booting Fastify, and side-by-side so the JSON transport and the SSE
// transport cannot drift.
//
// Neither one knows a single error CLASS any more. Each error declares its own
// `status` / `expose` / `midStream` / `toBody()` (see `src/errors/base.ts`), so
// adding a class needs no edit here — and, crucially, a class nobody
// remembered to add to the old `instanceof` chain no longer falls silently to
// a Fastify 500.
//
// `src/errors/wire-golden.test.ts` pins the exact (status, body) and
// (frame) each mapped class produces. That file is the wire contract
// `@edc/ai-client` reads — do not change a discriminator or a field
// name here without changing the client and every 0.16.0 consumer.

import { isAiServiceError } from './base.js';

/** A mapped JSON response: what to stamp on the reply, and what to send. */
export interface MappedGenerateError {
  status: number;
  body: Record<string, unknown>;
  /** Response headers the class requires (e.g. `Retry-After`). */
  headers?: Record<string, string>;
}

/** The terminal SSE `error` frame, minus the `type` the route adds. */
export interface StreamErrorFrame {
  code: string;
  message: string;
  /**
   * The stable machine string, when the error class defines one. Field-name
   * map across the two transports (the frame shape predates the ERR_ strings,
   * so the names differ while the VALUES are identical):
   *   stream frame `code`      ≡ /sync body `error` (the class-name taxonomy)
   *   stream frame `errorCode` ≡ /sync body `code`  (the ERR_ machine string)
   */
  errorCode?: string;
  /** Only set for retryable refusals; the frame omits it otherwise. */
  retryAfterMs?: number;
}

/**
 * Map a thrown orchestrator / resolver / cancel error onto a JSON response.
 * Returns `undefined` when the error is not ours, or is ours but marked
 * `expose = false`, so the caller can log it and rethrow — Fastify's 500
 * default then answers with a generic body and nothing internal reaches the
 * caller.
 */
export function mapGenerateError(err: unknown): MappedGenerateError | undefined {
  if (!isAiServiceError(err) || !err.expose) return undefined;
  return {
    status: err.status,
    body: err.toBody(),
    ...(err.headers ? { headers: err.headers } : {}),
  };
}

/**
 * Post-hijack error classification for the streamed route. We can't set an
 * HTTP status once the SSE headers are out, so a known error names itself in a
 * stable `code` string on the terminal frame instead.
 *
 * Only classes that declare `midStream` may do so. Everything else — including
 * our own exposed errors that are raised BEFORE the hijack and so cannot reach
 * here in practice — collapses to `INTERNAL` with a generic message, which
 * keeps the safe answer the default for any class added later.
 */
export function classifyStreamError(err: unknown): StreamErrorFrame {
  if (isAiServiceError(err) && err.expose && err.midStream) {
    return { code: err.wireError, ...err.streamFields(), message: err.message };
  }
  return { code: 'INTERNAL', message: 'generation failed' };
}
