import { Redis } from 'ioredis';

import type { Config } from '../config/config.js';

// The BullMQ Redis connection — built from a Config VALUE, never at module
// scope. BullMQ requires `maxRetriesPerRequest: null` on the connection it uses
// for blocking commands.
//
// 🔴 THIS MODULE MUST NOT CONSTRUCT A CLIENT AT IMPORT TIME, AND IT NO LONGER
// CAN. Until phase 2 it exported `export const redisConnection = new Redis(...)`,
// which dialled on IMPORT for anyone who touched it — 30 of the ~101 unit-test
// files reach it transitively (`queues.ts`, `routes/health.ts`, both workers) —
// and CI's `build` and `test` jobs have no Redis service container. The
// mitigation was `lazyConnect: true` (kept below, and still load-bearing);
// making the client a factory return value removes the hazard's cause rather
// than its symptom, because a factory nobody calls opens nothing.
//
// What the old `lazyConnect` comment recorded, kept because the failure mode is
// not obvious: without it every one of those files opened a client that
// reconnected forever against a refused port, and ioredis prints each failure
// with `console.error` ("[ioredis] Unhandled error event"). Vitest ships every
// console call from a worker to the main process over RPC
// (`onUserConsoleLog`). Those retries fire on a timer, so they land AFTER the
// file's last test — while the worker is being torn down. When one is still in
// flight at teardown the run dies with
//   EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
// which vitest reports as an unhandled error and exits 1 with EVERY TEST GREEN.
// CI gates on the runner's exit code, and `deploy-dev` needs `build`, so a
// fully green suite blocked the deploy. Measured on this tree:
// 2 failures in 40 local runs, 8 in 30 under a 4-core pin.
//
// Lazy is safe in production because nothing needs a connection at construction
// time. The BullMQ Queue/Worker objects call `client.connect()` themselves when
// they see status 'wait' (bullmq/classes/redis-connection.js `waitUntilReady`),
// and ioredis auto-connects on the first command (`sendCommand`), which covers
// `/health/ready`'s ping. Proven at runtime: booting the service against a real
// Redis leaves the client 'ready' and `/health/ready` reports `redis.ok`.
//
// In test mode `createQueues()` hands back in-memory mocks and no worker is
// started, so the unit suite never dials Redis at all.
export function createRedisConnection(config: Pick<Config, 'REDIS_URL'>): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}

// Queue names are centralised here so workers and producers can't drift.
export const QUEUE_NAMES = {
  /** Single queue: one job per generation unit. Job `name` carries org+unitType. */
  generation: 'generation',
  /** One job per ingest document (chunk + embed + insert). Decisions §14. */
  ingest: 'ingest',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
