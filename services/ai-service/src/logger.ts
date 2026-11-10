// Process-wide logger for code that runs OUTSIDE a request.
//
// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
//
// Fastify owns a pino logger and hands it to every route as `request.log`.
// Background work — the workers, the callback retry sweeper — has no request
// to borrow one from. The previous shape made the logger an OPTIONAL
// constructor dependency and optional-chained every call site:
//
//     deps.logger?.warn({ err }, 'sweep failed; will retry next interval');
//
// `src/index.ts` then called `startWorkers()` with no arguments, so no logger
// ever reached the sweeper and EVERY one of those lines silently evaporated.
// Measured: the sweeper was demonstrably
// running (3 index scans on `callback_deliveries` every 60.0s, matching its
// interval and per-sweep query count) while emitting not one log line.
//
// The failure that matters is not the missing counts line. It is that
// 'sweep failed; will retry next interval' was silenced too — so a
// permanently broken sweeper looked EXACTLY like a healthy quiet one. A
// watchdog whose own death is silent is not a watchdog.
//
// The fix is structural, not a wire. A background component resolves its
// logger as `deps.logger ?? rootLogger`, never `deps.logger?.`. Dropping the
// wiring again can then cost you request-scoped bindings — it can never cost
// you visibility. That is the property the regression test in
// `services/callbacks/sweeper.test.ts` pins.
//
// Note the sibling problem this deliberately does NOT solve with `console`:
// `cancel-bus.ts` reconnect notices go to `console.warn`, which bypasses
// pino entirely — no level filtering, no JSON, invisible to any level-based
// alert. Using a real pino instance here keeps background lines in the same
// stream, at the same level, in the same shape as request lines.

import pino, { type Logger } from 'pino';

import { env } from './config/env.js';
import { LOG_SAFE_OPTIONS } from './errors/log-safe.js';

/**
 * The minimum a background component needs to be honest about what it did.
 * Structural on purpose: pino loggers, Fastify's `app.log`, and a test spy
 * all satisfy it without importing anything.
 */
export interface ComponentLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/** A `ComponentLogger` that can also mint a labelled child. */
export interface FleetLogger extends ComponentLogger {
  child: (bindings: Record<string, unknown>) => FleetLogger;
}

/**
 * Root logger, configured to match the Fastify instance logger in
 * `server.ts` — same level from `LOG_LEVEL`, same redaction and `err`
 * serializer (`errors/log-safe.ts`) — so a line
 * written from a worker looks the same in Coolify's stream as one written
 * from a route.
 *
 * Under `LOG_LEVEL=silent` (the vitest default) this emits nothing, which
 * keeps test output clean without making silence the production default.
 */
export const rootLogger: Logger = pino({
  level: env.LOG_LEVEL,
  ...LOG_SAFE_OPTIONS,
});
