// The /v1 rate limiter must count ONE bucket per API key across ALL replicas.
//
// THE DEFECT THIS PINS: `@fastify/rate-limit` defaults to a per-process LRU
// store. ai-service runs more than one container, so the documented cap of
// "100 requests per minute per API key" was really 100 × (number of replicas),
// and it loosened silently every time a deploy added capacity. Nothing
// failed, nothing logged; the only symptom was a limit that did not limit.
//
// THE PROOF: two `buildServer()` instances stand in for two replicas — each
// `register(rateLimitPlugin)` builds its OWN store, which is exactly what two
// containers have. Replica A spends 5 requests on one key; replica B then
// makes its FIRST request with the SAME key and must see the bucket already
// 5 deep.
//
// SABOTAGE (measured): delete the `redis:` option in `src/server.ts` and
// replica B reports `x-ratelimit-remaining: 99` — a fresh bucket — instead of
// 94. That is the production defect, reproduced.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';
import { TEST_URLS } from '../test/integration-setup.js';

const TOKEN = 'dev-key-app';
// Must match `createRateLimitRedis()` in `src/server.ts`.
const KEY_PREFIX = 'ai-service:ratelimit:';

let probe: Redis;

async function makeReplica() {
  // NOT `vi.resetModules()`: two replicas must be two plugin registrations,
  // not two module registries. A fresh registry would also give each one its
  // own copy of every service module, which is not what two containers share.
  const { buildServer } = await import('../server.js');
  return buildServer();
}

async function remainingFor(app: Awaited<ReturnType<typeof makeReplica>>) {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  const header = res.headers['x-ratelimit-remaining'];
  // 🔴 A MISSING HEADER MEANS THE ASSERTIONS BELOW ARE ABOUT NOTHING.
  // `Number(undefined)` is NaN, and every `expect(NaN).toBe(n)` reads as a
  // plain value mismatch rather than as "the limiter never ran". Note what a
  // fail-open does NOT look like: with `skipOnError: true` (server.ts) an
  // unreachable Redis still SENDS this header, pinned at the maximum and never
  // decrementing — which is why the tests below assert exact counts rather
  // than mere presence.
  expect(header, 'x-ratelimit-remaining missing — the limiter never ran').toBeDefined();
  return Number(header);
}

beforeAll(async () => {
  // Opt the shared store IN for this file. `server.ts` reads this inside
  // `buildServer()`, and defaults to the in-process LRU under NODE_ENV=test
  // because the CI `test`/`build` jobs have no Redis service. In `beforeAll`
  // rather than at module scope: vitest evaluates every file's module body
  // before running any of them, so a top-level write leaked this switch into
  // files that had not started yet — the same process-global hazard the
  // `afterAll` below already guards on the way out.
  process.env['RATE_LIMIT_REDIS'] = '1';
  probe = new Redis(TEST_URLS.REDIS_URL, { maxRetriesPerRequest: 1 });
  // Start from an empty bucket regardless of what earlier files did — every
  // key this limiter writes lives under our prefix, so this touches nothing
  // else in the throwaway Redis.
  const keys = await probe.keys(`${KEY_PREFIX}*`);
  if (keys.length > 0) await probe.del(...keys);
});

afterAll(async () => {
  await probe.quit().catch(() => undefined);
  // `process.env` is process-global and the integration suite runs every file
  // in ONE worker process. Leaving this set would silently move the other
  // integration files onto the shared store — and onto this file's already
  // half-spent bucket, which is how a 429 appears in a test that never asked
  // about rate limiting.
  delete process.env['RATE_LIMIT_REDIS'];
});

describe('/v1 rate limit — one bucket per API key across replicas', () => {
  it('replica B sees the consumption replica A already spent', async () => {
    const replicaA = await makeReplica();
    const replicaB = await makeReplica();
    try {
      const seenByA: number[] = [];
      for (let i = 0; i < 5; i += 1) seenByA.push(await remainingFor(replicaA));

      // Replica A alone: a plain monotonic countdown.
      expect(seenByA).toEqual([
        V1_DEFAULT_RATE_LIMIT_MAX - 1,
        V1_DEFAULT_RATE_LIMIT_MAX - 2,
        V1_DEFAULT_RATE_LIMIT_MAX - 3,
        V1_DEFAULT_RATE_LIMIT_MAX - 4,
        V1_DEFAULT_RATE_LIMIT_MAX - 5,
      ]);

      // ── THE ASSERTION ────────────────────────────────────────────────────
      // Replica B's FIRST request. Shared store ⇒ 94. Per-process store ⇒ 99.
      const firstOnB = await remainingFor(replicaB);
      expect(firstOnB).toBe(V1_DEFAULT_RATE_LIMIT_MAX - 6);
    } finally {
      await replicaA.close();
      await replicaB.close();
    }
  });

  it('writes its counters under the ai-service rate-limit key prefix', async () => {
    // Guards the prefix in `createRateLimitRedis()`. If it drifts, the test
    // above still passes (both replicas drift together) but the wipe in
    // `beforeAll` silently stops working and a `redis-cli --scan` for this
    // service's limiter finds nothing.
    //
    // 🔴 IT SPENDS ITS OWN REQUEST. It used to read the keys the test above
    // had left behind, so running this file with `-t` on this test alone, or
    // reordering the two, asserted `0 > 0` and went red for a reason that has
    // nothing to do with the prefix. A test that only passes after another
    // test is not a gate on anything.
    const replica = await makeReplica();
    try {
      await remainingFor(replica);
      const keys = await probe.keys(`${KEY_PREFIX}*`);
      expect(keys.length, 'no counters under the expected prefix').toBeGreaterThan(0);
    } finally {
      await replica.close();
    }
  });
});
