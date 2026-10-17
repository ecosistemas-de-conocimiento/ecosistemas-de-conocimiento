// `buildServer` must build the server from the `Config` VALUE it was handed,
// not from the `env` module singleton (review finding 3).
//
// THE DEFECT. Three reads survived the config-as-values lane: `env.API_KEYS`
// in `v1RateLimitKey`, `env.REDIS_URL` in `createRateLimitRedis` and
// `env.LOG_LEVEL` in the Fastify options. A caller that hands in a runtime got
// a server that agreed with it about some settings and with `process.env`
// about the rest — the failure mode being invisible in the suite, where the
// two usually match, and load-bearing anywhere two servers share one process.
//
// Each case below is written so that reverting the one read it covers back to
// `env.<X>` turns it RED.

import { describe, expect, it } from 'vitest';

import { V1_DEFAULT_RATE_LIMIT_MAX } from './server-limits.js';
import { buildServer, createRateLimitRedis, v1RateLimitKey } from './server.js';
import { createTestRuntime } from './testing/runtime.js';

import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

/** `createRateLimitRedis` only ever calls `warn`/`info` on this. */
const silentLog = { warn: () => undefined, info: () => undefined } as unknown as FastifyBaseLogger;

function fakeRequest(authorization?: string): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as FastifyRequest;
}

describe('buildServer reads its configuration from runtime.config', () => {
  it('takes the logger level from the config, not from env.LOG_LEVEL', async () => {
    // The suite runs with LOG_LEVEL=silent, so 'warn' can only have come from
    // the injected value.
    const runtime = createTestRuntime({ config: { LOG_LEVEL: 'warn' } });
    const app = await buildServer(runtime);
    try {
      expect(app.log.level).toBe('warn');
    } finally {
      await app.close();
      await runtime.close();
    }
  });

  it('points the rate-limit Redis client at the config REDIS_URL', () => {
    const runtime = createTestRuntime({ config: { REDIS_URL: 'redis://127.0.0.1:6399' } });
    const client = createRateLimitRedis(silentLog, runtime.config);
    try {
      // `lazyConnect`, so this opens nothing — `options` records the target.
      expect(client.options.port).toBe(6399);
      expect(client.options.host).toBe('127.0.0.1');
    } finally {
      client.disconnect();
    }
  });

  it('buckets rate-limit keys against the config API_KEYS', () => {
    const runtime = createTestRuntime({
      config: { API_KEYS: { 'injected-key': { org: 'o', project: 'p', role: 'app' } } },
    });
    // Known to the injected config → its own `k:` bucket.
    expect(v1RateLimitKey(runtime.config, fakeRequest('Bearer injected-key'))).toMatch(/^k:/);
    // Known to `env` (the suite's API_KEYS) but NOT to this config → the
    // unauthenticated bucket. This is the assertion that reverses under the
    // defect.
    expect(v1RateLimitKey(runtime.config, fakeRequest('Bearer test-key'))).toBe('ip:203.0.113.7');
    expect(v1RateLimitKey(runtime.config, fakeRequest())).toBe('ip:203.0.113.7');
  });

  it('wires that key function into the live limiter', async () => {
    // An EMPTY config key set, while `env` still knows `test-key` (auth reads
    // `env`, so the request is still served). Under the fix the authenticated
    // request shares the unauthenticated `ip:` bucket, so it sees the counter
    // the 401 already spent. Under the defect it gets a private `k:` bucket
    // and reports one more remaining.
    const runtime = createTestRuntime({ config: { API_KEYS: {} } });
    const app = await buildServer(runtime);
    try {
      const rejected = await app.inject({ method: 'GET', url: '/v1/' });
      expect(rejected.statusCode).toBe(401);
      const served = await app.inject({
        method: 'GET',
        url: '/v1/',
        headers: { authorization: 'Bearer test-key' },
      });
      expect(served.statusCode).toBe(200);
      expect(Number(served.headers['x-ratelimit-remaining'])).toBe(V1_DEFAULT_RATE_LIMIT_MAX - 2);
    } finally {
      await app.close();
      await runtime.close();
    }
  });
});
