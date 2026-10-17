// `req.ip` must come from the trusted ingress hop(s), not from whatever the
// caller writes at the left of `X-Forwarded-For`. Under `trustProxy: true` the
// leftmost (caller-chosen) entry won, so anything keyed on `req.ip` could be
// dodged by rotating a spoofed header. With a hop COUNT, Fastify walks
// `X-Forwarded-For` from the right and stops after that many proxies, so the
// entry the ingress appended wins.
//
// Uses the injected-runtime harness and the `TRUSTED_PROXY_HOPS` config knob
// (default 1).

import { describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { createTestRuntime } from '../testing/runtime.js';

async function ipSeen(runtime: ReturnType<typeof createTestRuntime>, xff: string): Promise<string> {
  const app = await buildServer(runtime);
  try {
    app.get('/__test/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      headers: { 'x-forwarded-for': xff },
    });
    return (res.json() as { ip: string }).ip;
  } finally {
    await app.close();
    await runtime.close();
  }
}

describe('trustProxy — hop count', () => {
  it('defaults to one hop: ignores caller-written entries left of the ingress', async () => {
    const runtime = createTestRuntime();
    expect(runtime.config.TRUSTED_PROXY_HOPS).toBe(1);
    // spoofed by the caller, then appended by the ingress
    expect(await ipSeen(runtime, '203.0.113.9, 10.0.0.2')).toBe('10.0.0.2');
  });

  it('honours a configured hop count (e.g. CDN in front of the ingress)', async () => {
    const runtime = createTestRuntime({ config: { TRUSTED_PROXY_HOPS: 2 } });
    // spoofed, real client (appended by the CDN), CDN (appended by the ingress)
    expect(await ipSeen(runtime, '203.0.113.9, 198.51.100.4, 10.0.0.2')).toBe('198.51.100.4');
  });
});
