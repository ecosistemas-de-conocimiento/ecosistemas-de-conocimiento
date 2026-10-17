// `loadConfig()` must not return two fields that disagree about NODE_ENV.
//
// THE DEFECT (review finding 2). `config.NODE_ENV` was spread in from `env`,
// which zod parses ONCE at import; `rateLimitRedisStore` read
// `source['NODE_ENV']` live. So a suite that sets `process.env.NODE_ENV` after
// import — or any late call — got one Config value saying "not test" (the
// Redis rate-limit store) and "test" (in-memory queues, via `createRuntime`'s
// `mockQueues` default off `config.NODE_ENV`) at the same time.
//
// Sabotage: put `...env` after `NODE_ENV: nodeEnv` in `loadConfig`, or hand
// `readRateLimitRedisStore` `source` again instead of `nodeEnv` — either makes
// the "agree" cases below RED.

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const original = process.env['NODE_ENV'];

afterEach(() => {
  if (original === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = original;
});

describe('loadConfig — NODE_ENV is read live, and read once', () => {
  it('reflects a mutation made after this module was imported', () => {
    // The import above already froze `env.NODE_ENV` at 'test'.
    expect(loadConfig().NODE_ENV).toBe('test');
    process.env['NODE_ENV'] = 'production';
    expect(loadConfig().NODE_ENV).toBe('production');
  });

  it('derives rateLimitRedisStore from the SAME value it reports', () => {
    for (const [nodeEnv, expectedStore] of [
      ['test', false],
      ['production', true],
      ['development', true],
    ] as const) {
      process.env['NODE_ENV'] = nodeEnv;
      const config = loadConfig();
      expect(config.NODE_ENV).toBe(nodeEnv);
      expect(config.rateLimitRedisStore).toBe(expectedStore);
    }
  });

  it('honours an explicit source object over process.env', () => {
    process.env['NODE_ENV'] = 'test';
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.NODE_ENV).toBe('production');
    expect(config.rateLimitRedisStore).toBe(true);
  });

  it('falls back to the parsed value when the live one is absent or invalid', () => {
    delete process.env['NODE_ENV'];
    expect(loadConfig().NODE_ENV).toBe('test');
    expect(loadConfig({ NODE_ENV: 'staging' }).NODE_ENV).toBe('test');
  });

  it('RATE_LIMIT_REDIS still overrides in both directions', () => {
    expect(loadConfig({ NODE_ENV: 'test', RATE_LIMIT_REDIS: '1' }).rateLimitRedisStore).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', RATE_LIMIT_REDIS: '0' }).rateLimitRedisStore).toBe(
      false,
    );
  });
});
