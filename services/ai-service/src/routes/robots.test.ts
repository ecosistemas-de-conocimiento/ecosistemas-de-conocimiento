// Wire-level checks for the crawler policy.
//
// The pure predicate is covered in `src/robots.test.ts`. What matters here is
// the MOUNTING: that `/robots.txt` is reachable without a bearer token, that it
// is not counted by the `/v1` rate limiter, and that the `X-Robots-Tag` header
// reaches responses the route itself never produces.

import { describe, expect, it } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from '../server-limits.js';

async function makeApp() {
  // Imported lazily so env validation runs against the test env.
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('GET /robots.txt', () => {
  it('serves real text/plain with no bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('User-agent: *\nDisallow: /\n');
    await app.close();
  });

  it('disallows everything on the production host too', async () => {
    const app = await makeApp();
    for (const host of [
      'ai.dev.example.org',
      'ai.stage.example.org',
      'ai-demo-0.dev.example.org',
      'ai.example.org',
    ]) {
      const res = await app.inject({ method: 'GET', url: '/robots.txt', headers: { host } });
      expect(res.statusCode, host).toBe(200);
      expect(res.body, host).toBe('User-agent: *\nDisallow: /\n');
    }
    await app.close();
  });
});

describe('X-Robots-Tag', () => {
  it('is set on robots.txt, on an unauthenticated route, and on a 401', async () => {
    const app = await makeApp();
    for (const url of ['/robots.txt', '/health', '/v1/']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'ai.example.org' } });
      expect(res.headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    await app.close();
  });
});

describe('robots.txt is outside the /v1 rate limiter', () => {
  it('answers past the global cap while an authenticated /v1 route is capped', async () => {
    const app = await makeApp();

    // Well past the 100/min global bucket. Every one must still be a 200 —
    // a crawler cannot exhaust a tenant's allowance by polling the policy.
    const overCap = V1_DEFAULT_RATE_LIMIT_MAX + 50;
    for (let i = 0; i < overCap; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.statusCode, `robots.txt request ${i + 1}`).toBe(200);
    }

    // Contrast, so the assertion above is a real gate and not a limiter that
    // happens to be inert: the same instance DOES cap an authenticated /v1
    // route. If this stops 429-ing, the test above proves nothing.
    const auth = { authorization: 'Bearer test-key' };
    let capped = false;
    for (let i = 0; i < overCap; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/', headers: auth });
      if (res.statusCode === 429) {
        capped = true;
        break;
      }
    }
    expect(capped, '/v1 should be rate limited').toBe(true);

    // ...and the crawler path is still open after the tenant's bucket is spent.
    const after = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(after.statusCode).toBe(200);

    await app.close();
  });
});
