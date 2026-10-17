// 🔴 A REJECTED REQUEST MUST COST THE CALLER SOMETHING.
//
// THE DEFECT THIS PINS: `v1.addHook('onRequest', requireAuth)` was registered
// BEFORE `v1.register(rateLimitPlugin)`. Same-stage hooks run in registration
// order and a hook that replies short-circuits the rest of the chain, so the
// 401 was sent before the limiter's own `onRequest` hook ever ran. Rejections
// were therefore UNLIMITED — free to the caller, and one full API-key lookup
// each to this service, on a route that anyone on the internet can reach
// without a credential.
//
// MEASURED before the fix, 200 injects per case against one instance:
//   valid key          {200: 99, 429: 101}   ← the limiter worked here
//   expired/unknown key {401: 200}           ← and only here
//   garbage token       {401: 200}
//
// The fix is an ORDER, not a feature: the limiter registers first, and
// `v1RateLimitKey` (server.ts) derives the bucket from the Authorization
// header instead of from `req.auth`, so it no longer needs auth to have run.
//
// SABOTAGE (all measured, all RED):
//   move `v1.addHook('onRequest', app.requireAuth)` back above the
//     `v1.register(rateLimitPlugin, ...)` call   → zero 429s in every case here
//   `keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip` (the old line)
//     → the X-Forwarded-For case below goes red: a rotated header mints a
//       fresh bucket per request, which is the same non-limit in a new place
//   drop the `k:` branch from `v1RateLimitKey`
//     → the last test here goes red: a valid key gets 429 off the rejection
//       flood's bucket, because both now key on the address. (Note that
//       `routes/rate-limit-key.test.ts` stays GREEN under that sabotage — a
//       fixed socket peer decrements monotonically just like a key does, so
//       the file next door does not cover this.)

import { describe, expect, it } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';

const OVER_CAP = 200;

async function makeApp() {
  // Each `buildServer()` registers the plugin afresh, and the in-process store
  // is per-registration — so one app per case is one empty bucket per case.
  const { buildServer } = await import('../server.js');
  return buildServer();
}

/** Inject `OVER_CAP` requests and tally the status codes. */
async function tally(
  app: Awaited<ReturnType<typeof makeApp>>,
  headersFor: (i: number) => Record<string, string>,
): Promise<Record<number, number>> {
  const counts: Record<number, number> = {};
  for (let i = 0; i < OVER_CAP; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/v1/', headers: headersFor(i) });
    counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
  }
  return counts;
}

describe('/v1 rate limit — rejected requests are limited too', () => {
  it.each([
    ['an unknown (e.g. expired, rotated-out) key', 'Bearer no-longer-a-real-key'],
    ['a garbage token', 'Bearer ../../etc/passwd%00'],
    // A prototype-chain name: `v1RateLimitKey` must file this under the
    // unauthenticated namespace, not mint a `k:` bucket from `Object.prototype`.
    ['a prototype-chain name', 'Bearer __proto__'],
    ['a malformed authorization header', 'Basic dXNlcjpwYXNz'],
  ])('caps %s at the documented maximum', async (_label, authorization) => {
    const app = await makeApp();
    try {
      const counts = await tally(app, () => ({ authorization }));
      // Up to the cap the answer is the honest one: 401.
      expect(counts[401], `statuses: ${JSON.stringify(counts)}`).toBe(
        V1_DEFAULT_RATE_LIMIT_MAX,
      );
      // Past it, the caller is throttled instead of served for free. This is
      // the assertion the defect failed: it was 0.
      expect(counts[429], `statuses: ${JSON.stringify(counts)}`).toBe(
        OVER_CAP - V1_DEFAULT_RATE_LIMIT_MAX,
      );
      expect(counts[200]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('caps a missing authorization header too', async () => {
    const app = await makeApp();
    try {
      const counts = await tally(app, () => ({}));
      expect(counts[401]).toBe(V1_DEFAULT_RATE_LIMIT_MAX);
      expect(counts[429]).toBe(OVER_CAP - V1_DEFAULT_RATE_LIMIT_MAX);
    } finally {
      await app.close();
    }
  });

  it('X-Forwarded-For rotation cannot mint fresh buckets for rejections', async () => {
    // 🔴 THE HALF THAT MAKES THE CAP REAL. `trustProxy: true` makes `req.ip`
    // the leftmost X-Forwarded-For entry — a value the caller writes. Keying
    // the unauthenticated bucket on it would leave the flood above capped only
    // for an attacker who declines to send a header. `v1RateLimitKey` keys on
    // the raw socket peer, which the caller cannot choose.
    const app = await makeApp();
    try {
      const counts = await tally(app, (i) => ({
        authorization: 'Bearer no-longer-a-real-key',
        'x-forwarded-for': `198.51.100.${i % 254}`,
      }));
      expect(counts[429], `statuses: ${JSON.stringify(counts)}`).toBe(
        OVER_CAP - V1_DEFAULT_RATE_LIMIT_MAX,
      );
    } finally {
      await app.close();
    }
  });

  it('a flood of rejections does not spend a valid key’s bucket', async () => {
    // ANTI-VACUITY, and the reason the two namespaces exist. If rejections and
    // configured keys shared one bucket, the cap above would be a way to lock
    // every tenant out of /v1 from an unauthenticated socket.
    const app = await makeApp();
    try {
      await tally(app, () => ({ authorization: 'Bearer no-longer-a-real-key' }));
      const res = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: 'Bearer test-key' },
      });
      expect(res.statusCode, `body: ${res.body}`).toBe(200);
      // A pristine bucket: the valid key's very first request.
      expect(res.headers['x-ratelimit-remaining']).toBe(String(V1_DEFAULT_RATE_LIMIT_MAX - 1));
    } finally {
      await app.close();
    }
  });
});
