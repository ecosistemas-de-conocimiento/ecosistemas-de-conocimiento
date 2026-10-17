// 🔴 A REDIS OUTAGE MUST DEGRADE RATE LIMITING, NOT TAKE DOWN /v1.
//
// THE DEFECT THIS PINS: `@fastify/rate-limit` defaults `skipOnError` to FALSE,
// which RETHROWS whatever the store throws. Once the limiter was pointed at a
// shared Redis (the fix for per-replica buckets), that default quietly promoted
// Redis to a hard dependency of every single /v1 request — including the ones
// that never touch Redis for anything else.
//
// MEASURED against a closed port, before the fix: every request on every /v1
// route answered `500 {"message":"Reached the max retries per request limit"}`
// after 4.0 s. Not a slow path, not a degraded limit — the whole versioned API
// down, because a rate limiter could not count.
//
// Redis is not in the critical path of answering a request and must not be able
// to put itself there. So: fail OPEN. While the store is unreachable the check
// is skipped, `x-ratelimit-*` headers are absent, and requests are answered on
// their own merits — 200 for a good key, 401 for a bad one, and an
// `x-ratelimit-remaining` frozen at the maximum. The cost is
// explicit: for the length of the outage a caller can exceed the documented cap,
// which is exactly why `createRateLimitRedis` logs one warn when Redis goes.
//
// SABOTAGE (measured): remove `skipOnError: true` from `src/server.ts` and both
// assertions below go RED with `500` and a body of "Reached the max retries per
// request limit" — the production defect, reproduced in ~1 s.
//
// 🔴 THE ENV WRITES BELOW MUST RUN BEFORE `../server.js` IS IMPORTED, which is
// why this file has NO static import of it: `src/config/env.ts` snapshots
// `process.env` at module-evaluation time, and static imports are hoisted above
// every statement in the module body. `import()` inside the test is the seam.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';

// A port nothing listens on. `127.0.0.1` (not `localhost`) so the connection is
// REFUSED immediately rather than spending the DNS/IPv6 fallback budget first.
const DEAD_REDIS = 'redis://127.0.0.1:6399';
const APP_TOKEN = 'test-key';

const saved = {
  redisUrl: process.env['REDIS_URL'],
  rateLimitRedis: process.env['RATE_LIMIT_REDIS'],
};

beforeAll(() => {
  process.env['REDIS_URL'] = DEAD_REDIS;
  // Opt the Redis store IN — the unit default is the in-process LRU, which has
  // no store error to fail on and would make this file assert nothing.
  process.env['RATE_LIMIT_REDIS'] = '1';
});

afterAll(() => {
  if (saved.redisUrl === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = saved.redisUrl;
  if (saved.rateLimitRedis === undefined) delete process.env['RATE_LIMIT_REDIS'];
  else process.env['RATE_LIMIT_REDIS'] = saved.rateLimitRedis;
});

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('/v1 rate limiter with an unreachable Redis', () => {
  it('still answers an authenticated request 200, with no rate-limit headers', async () => {
    const app = await makeApp();
    try {
      const startedAt = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      const elapsedMs = performance.now() - startedAt;
      expect(res.statusCode, `body: ${res.body}`).toBe(200);
      // 🔴 THE WALL-CLOCK BOUND IS PART OF THE CONTRACT, not a nicety. Failing
      // open is worth little if every request first spends seconds waiting for
      // a Redis that is not coming: the original defect was 4.0 s per request,
      // and an over-generous `retryStrategy` cap reproduced the same symptom at
      // 5 s while still returning 200. `enableOfflineQueue` parks each command
      // until the next reconnect ATTEMPT, so the backoff cap in
      // `createRateLimitRedis` IS this number. 2.5 s is loose enough for a
      // loaded CI box and far below the 4.0 s that started this.
      expect(elapsedMs, `request took ${elapsedMs.toFixed(0)}ms with Redis down`)
        .toBeLessThan(2_500);
      expect(res.json()).toMatchObject({ v1: true, org: 'test-org' });
      // Failing open means the counters genuinely did not run. The plugin's
      // skip path still emits `x-ratelimit-*`, but pinned at the MAXIMUM and
      // never decrementing — so a second request reporting the same number is
      // what tells "the store was skipped" apart from "Redis was reachable
      // after all", which would make this whole file vacuous.
      expect(res.headers['x-ratelimit-remaining']).toBe(String(V1_DEFAULT_RATE_LIMIT_MAX));
      const again = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(again.statusCode).toBe(200);
      expect(again.headers['x-ratelimit-remaining']).toBe(String(V1_DEFAULT_RATE_LIMIT_MAX));
      // …and the SECOND request is the one that used to blow the budget: the
      // reconnect counter keeps climbing, so an uncapped backoff makes each
      // successive request slower than the last.
      // Correlation still works while the store is down.
      expect(res.headers['x-request-id']).toBeTruthy();
    } finally {
      await app.close();
    }
  }, 30_000);

  it('still rejects a bad key with 401 rather than a store 500', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: 'Bearer not-a-real-key' },
      });
      expect(res.statusCode, `body: ${res.body}`).toBe(401);
    } finally {
      await app.close();
    }
  });
});
