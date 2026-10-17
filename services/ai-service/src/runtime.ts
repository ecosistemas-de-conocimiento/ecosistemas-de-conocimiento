// THE PROCESS RUNTIME — the objects that used to be module-scope singletons,
// built once from a Config VALUE and passed down.
//
// WHY (phase 2, row 8 — "config as values, not singletons"). Before this file,
// a handful of modules constructed long-lived, configuration-bearing objects at
// IMPORT time: `queue/connection.ts` opened an ioredis client, `queue/queues.ts`
// memoised a BullMQ queue + flow producer behind getters,
// `services/generation/cancel-bus.ts` cached a Redis pub/sub bus,
// `services/ai/router/cache.ts` handed out a process-wide LRU. Three
// consequences, all measured on this tree rather than theorised:
//
//   1. IMPORTING A MODULE OPENED A SOCKET. `connection.ts` dialled Redis for
//      every one of the ~30 unit files that reach it transitively, which is why
//      `lazyConnect: true` had to be added and pinned by a test.
//   2. NO CALL SITE NAMED ITS DEPENDENCY. "Which queue does `enqueueGeneration`
//      use?" was answered by a module-scope `let`, not by a signature.
//   3. TESTS SUBSTITUTED BY MUTATING GLOBALS — `_resetQueuesForTests()`,
//      `resetCancelBusForTests()` — so leakage between files was one missing
//      `afterEach` away.
//
// `createRuntime(config)` builds all of them, once, and hands back one value.
// `buildServer(runtime)` and `startWorkers(runtime)` take it; `src/index.ts`
// calls `loadConfig()` exactly once and threads the result. Tests call
// `createTestRuntime()` (see `src/testing/runtime.ts`), which is the same
// constructor with the mock switch on.
//
// ── WHAT IS DELIBERATELY *NOT* HERE ────────────────────────────────────────
// Four module-scope values were reviewed for this lane and left where they are,
// because none of them holds CONFIGURATION — they are process-level memoisation
// or process-level state, and moving them into `Runtime` would thread a runtime
// through the RAG retriever and the worker's per-job hot path for no config
// benefit and with a real risk of changing what is shared with what:
//
//   `services/ai/router/cache.ts`        an LRU of router responses. Takes no
//                                        config; its key already carries the
//                                        tenant. One per process is the point.
//   `services/ai/router/resilience.ts`   the circuit breaker. Sharing IS the
//                                        feature — a breaker constructed per
//                                        call counts to five alone and never
//                                        opens (see the warning on
//                                        `createProviderResilience`).
//   `services/ai/validators/json-schema.ts`  a compiled-Ajv instance. Pure.
//   `openapi/registry.ts`                a memoised, deterministic document.
//
// `services/ai/openrouter-credits.ts` likewise keeps its TTL cache: the cache
// IS the feature there, not an accident of module scope.
//
// 🔴 NOTHING DIALS AT *CONSTRUCTION* — THE FIRST OPERATION DOES. Be precise
// about this, because the shorter claim ("nothing here dials") is false the
// moment `mockQueues` is off: `createRedisConnection` returns a `lazyConnect`
// client and BullMQ opens its own connections on first use, so `createRuntime`
// itself opens no socket, but a real-queue runtime whose queues are then USED —
// or merely closed, since `close()` issues commands — will connect. Unit tests
// are safe because `mockQueues` defaults on under `NODE_ENV=test` and the
// queues are in-memory; the integration lane turns it off and has a Redis.
// This is also why a runtime `buildServer()` creates for itself must be closed
// with the app — see the ownership note on `buildServer`.

import type { Redis } from 'ioredis';

import { loadConfig, type Config } from './config/config.js';
import { createRedisConnection } from './queue/connection.js';
import { createQueues, type Queues } from './queue/queues.js';
import { createCancelBus, type CancelBus } from './services/generation/cancel-bus.js';
import { SHUTDOWN_ABORT_REASON } from './services/jobs/shutdown.js';

export interface Runtime {
  config: Config;
  /**
   * The shared BullMQ / readiness-probe Redis client. Always present and always
   * `lazyConnect`, so holding one costs nothing until something issues a
   * command — `/health/ready` pings it, and that must keep working in every
   * environment, which is why this is not switched off with the queues.
   */
  redis: Redis;
  queues: Queues;
  /**
   * Redis pub/sub fast path for cancellation. ONE per process: the HTTP cancel
   * route publishes on it and the in-process generation worker subscribes to
   * it, so they must be the same object. Constructed here, never started here —
   * `startGenerationWorker` calls `start()`.
   */
  cancelBus: CancelBus;
  /**
   * Aborted when the shutdown grace expires. ONE per process, and the HTTP
   * half of cooperative shutdown.
   *
   * 🔴 WHY THIS IS ON THE RUNTIME AND NOT IN `index.ts`. `SHUTDOWN_GRACE_MS`
   * bounded the BullMQ workers and NOTHING ELSE. MEASURED before this field
   * existed: a SIGTERM sent during a `/v1/generate/stream` with a 2 s grace let
   * the response complete NORMALLY 25 s later, because `app.close()` waits for
   * in-flight requests and it runs AFTER the grace has already elapsed. The
   * grace was a promise the HTTP path never made.
   *
   * The sync and stream route handlers compose this into the signal they
   * already hand the router (`AbortSignal.any`, alongside client-disconnect and
   * the wall-clock backstop in `services/ai/router/timeout-signal.ts`). When it
   * fires, the provider fetch aborts through the existing
   * `OpenRouterAbortError` path: the stream ends with the typed error frame,
   * sync returns its existing aborted mapping, and the trace row is written
   * `aborted` with the partial cost billed. `app.close()` then returns
   * promptly, which is what makes the "exit within grace + 5 s" claim true for
   * an HTTP-only pod.
   *
   * ⚠ It is on the RUNTIME because that is the one value every route already
   * has (`app.runtime`, decorated by `buildServer`). A module-scope controller
   * would be exactly the import-time singleton this file exists to remove, and
   * a test could not get a second one.
   */
  shutdownSignal: AbortSignal;
  /**
   * Abort `shutdownSignal` with `SHUTDOWN_ABORT_REASON`. Idempotent — a second
   * SIGTERM must not produce a second abort with a different reason. Called by
   * `index.ts` from a timer armed at signal receipt, NOT after `workers.stop()`
   * returns: `stop()` itself consumes the whole grace, so waiting for it would
   * make the HTTP bound `grace + settle + grace` instead of `grace`.
   */
  abortShutdown(): void;
  /** Close everything this runtime opened. */
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  /**
   * In-memory queues instead of BullMQ. Defaults to `config.NODE_ENV ===
   * 'test'`, which is exactly what `queues.ts` used to decide for itself off a
   * bare `process.env.NODE_ENV` read.
   */
  mockQueues?: boolean;
  /** Substitute the Redis client (tests, and the readiness-probe mutation test). */
  redis?: Redis;
  /** Substitute the cancel bus (tests use a no-op that opens no connection). */
  cancelBus?: CancelBus;
}

export function createRuntime(
  config: Config = loadConfig(),
  opts: CreateRuntimeOptions = {},
): Runtime {
  const mockQueues = opts.mockQueues ?? config.NODE_ENV === 'test';
  const redis = opts.redis ?? createRedisConnection(config);
  const queues = createQueues({ connection: mockQueues ? null : redis, mock: mockQueues });
  const cancelBus = opts.cancelBus ?? createCancelBus(config);
  const shutdownCtrl = new AbortController();

  return {
    config,
    redis,
    queues,
    cancelBus,
    shutdownSignal: shutdownCtrl.signal,
    abortShutdown: () => {
      if (!shutdownCtrl.signal.aborted) shutdownCtrl.abort(SHUTDOWN_ABORT_REASON);
    },
    close: async () => {
      await queues.close();
      await cancelBus.stop().catch(() => undefined);
      // `quit()` on a client that never dialled rejects with "Connection is
      // closed"; `disconnect()` is the no-op-safe teardown for the lazy case.
      if (redis.status === 'wait' || redis.status === 'end') redis.disconnect();
      else await redis.quit().catch(() => undefined);
    },
  };
}

// Fastify decoration. `buildServer()` calls `app.decorate('runtime', runtime)`,
// which is how every route reaches its queues and its Redis client without
// importing one. Declared here, next to the type it exposes.
declare module 'fastify' {
  interface FastifyInstance {
    runtime: Runtime;
  }
}
