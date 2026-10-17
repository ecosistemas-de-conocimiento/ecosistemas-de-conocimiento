// The Config VALUE. One object, built from `process.env`, passed down.
//
// WHY THIS FILE EXISTS (phase 2, row 8 — "config as values, not singletons").
// Before it, three different populations of code read configuration three
// different ways: `env` (the zod-parsed module singleton in `env.ts`), bare
// `process.env` reads scattered through `server.ts` and `telemetry/config.ts`,
// and module-scope objects built at IMPORT time from `env` — a Redis client, a
// BullMQ queue, a cancel bus. The last group is the expensive one: a module
// that constructs a client on import cannot be given a different one, so tests
// reach for `vi.mock`, and "which Redis is this talking to?" has no answer you
// can read off a call site.
//
// 🔴 THIS FILE OWNS NO SCHEMA. `src/config/env.ts` is lane D's file and stays
// the single place a variable is declared, defaulted and validated. `Config`
// is `Env` PLUS the two groups of settings that were being read raw off
// `process.env` elsewhere (OpenTelemetry, the rate-limit store switch). Adding
// a variable is still an `env.ts` change and only an `env.ts` change.
//
// 🔴 ONE EXCEPTION, AND IT IS A BUG FIX: `NODE_ENV` IS RE-READ FROM `source`.
// `env` is parsed once at import; `loadConfig()` is called late, per call, and
// two of its outputs used to disagree about which environment this is —
// `rateLimitRedisStore` read `source['NODE_ENV']` LIVE while `config.NODE_ENV`
// carried the frozen import-time value. `createRuntime` keys its `mockQueues`
// default off the latter, so one Config value could say "use the Redis rate
// limit store" (live: not test) and "use in-memory queues" (frozen: test) in
// the same breath. `readNodeEnv` is now the single live read and BOTH fields
// derive from it. The schema still lives in `env.ts`; this only re-reads a
// value the suite mutates after import.
//
// 🔴 `loadConfig()` IS A FUNCTION, AND CALLED LATE ON THE DEFAULT PATH.
// `buildServer()` and `createRuntime()` default to `loadConfig()` per call, not
// to a module-scope constant. That is deliberate and load-bearing for the
// suite: `routes/rate-limit-shared-store.integration.test.ts` and
// `routes/rate-limit-fail-open.test.ts` set `RATE_LIMIT_REDIS` in a `beforeAll`
// and then build a server, and `telemetry/otel.test.ts` mutates the OTel
// variables between cases. A constant captured at import would freeze the value
// those tests set afterwards. Production calls it exactly once, in `index.ts`.

import { env, type Env } from './env.js';
import { readTelemetryConfig, type TelemetryConfig } from '../telemetry/config.js';

export type { Env } from './env.js';

export interface Config extends Env {
  /** OpenTelemetry settings — see `src/telemetry/config.ts` for why they are read there. */
  otel: TelemetryConfig;
  /**
   * Should the /v1 rate limiter keep its counters in Redis (shared across
   * replicas) or in this process's memory?
   *
   * Redis everywhere EXCEPT the unit-test environment. CI's `test` and `build`
   * jobs run with no Redis service container, and ~30 unit files import
   * `server.ts` transitively. With `skipOnError: true` an unreachable Redis
   * makes `@fastify/rate-limit` skip the check and emit NO `x-ratelimit-*`
   * headers at all — which turns `routes/limits.test.ts` and
   * `routes/rate-limit-key.test.ts` red for a reason that has nothing to do
   * with either fix they pin, and it would make every unit run pay a connect
   * timeout per request on the way there.
   *
   * `RATE_LIMIT_REDIS` is the explicit escape hatch in both directions: the
   * integration test that proves cross-replica sharing sets it to `1`, and an
   * operator debugging a single box can set `0`.
   */
  rateLimitRedisStore: boolean;
}

type NodeEnv = Env['NODE_ENV'];

const NODE_ENV_VALUES: readonly string[] = ['development', 'test', 'production'];

/**
 * The live `NODE_ENV`, falling back to the import-time parsed value.
 *
 * An unset or unrecognised `NODE_ENV` falls back to `env.NODE_ENV`, which is
 * where zod already applied the `'development'` default and would already have
 * rejected a bad value at boot. So this never widens what the schema accepts —
 * it only lets a LATE mutation (which the suite does, per file) be seen.
 */
function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  const raw = source['NODE_ENV'];
  return raw !== undefined && NODE_ENV_VALUES.includes(raw) ? (raw as NodeEnv) : env.NODE_ENV;
}

function readRateLimitRedisStore(
  source: Record<string, string | undefined>,
  nodeEnv: NodeEnv,
): boolean {
  const explicit = source['RATE_LIMIT_REDIS'];
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return nodeEnv !== 'test';
}

/**
 * Build the Config value. `env` supplies every declared+validated variable;
 * this adds the settings whose names are not ours to choose (the OTel spec
 * names) or whose scope is one subsystem (the rate-limit store switch).
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const nodeEnv = readNodeEnv(source);
  return {
    ...env,
    NODE_ENV: nodeEnv,
    otel: readTelemetryConfig(source),
    rateLimitRedisStore: readRateLimitRedisStore(source, nodeEnv),
  };
}
