// Mutation test for the rate-limit keying fix (audit finding [HIGH]
// rate-limit keying, commit "sec(ratelimit-key)").
//
// The defect: `requireAuth` ran as a `preHandler`, but @fastify/rate-limit
// checks buckets in its own `onRequest` hook — so `req.auth` was always
// undefined at `keyGenerator` time and every request bucketed by `req.ip`,
// which is attacker-controlled per-request via X-Forwarded-For under
// `trustProxy: true`. Rotating the spoofed IP minted a fresh bucket each
// request, making the documented per-key caps a no-op.
//
// Observable invariant: with ONE API key and a DIFFERENT spoofed client IP on
// every request, `x-ratelimit-remaining` must still decrement monotonically —
// one shared bucket that follows the key. Reverting auth to `preHandler`
// makes remaining stick at max−1 for every spoofed IP → RED.

import { describe, expect, it, vi } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';

async function makeApp() {
  // Fresh module registry = fresh in-memory rate-limit store.
  vi.resetModules();
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('/v1 rate limit — bucketed by API key, not by spoofable client IP', () => {
  it('X-Forwarded-For rotation cannot mint fresh buckets for one key', async () => {
    const app = await makeApp();
    const spoofedIps = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
    const remaining: number[] = [];
    for (const ip of spoofedIps) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: 'Bearer test-key', 'x-forwarded-for': ip },
      });
      expect(res.statusCode).toBe(200);
      remaining.push(Number(res.headers['x-ratelimit-remaining']));
    }
    // One shared bucket across all spoofed IPs. Under the defect each IP got
    // its own bucket and remaining stayed at max−1 for all three requests.
    expect(remaining).toEqual([
      V1_DEFAULT_RATE_LIMIT_MAX - 1,
      V1_DEFAULT_RATE_LIMIT_MAX - 2,
      V1_DEFAULT_RATE_LIMIT_MAX - 3,
    ]);
    await app.close();
  });
});
