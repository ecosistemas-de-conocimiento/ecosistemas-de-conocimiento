// `req.ip` must come from the single trusted ingress hop, not from whatever
// the caller writes at the left of `X-Forwarded-For`. Under `trustProxy: true`
// the leftmost (caller-chosen) entry won; under one trusted hop the entry the
// ingress appended wins.

import { describe, expect, it, vi } from 'vitest';

describe('trustProxy — one hop', () => {
  it('ignores caller-written X-Forwarded-For entries beyond the ingress hop', async () => {
    vi.resetModules();
    const { buildServer, TRUSTED_PROXY_HOPS } = await import('../server.js');
    expect(TRUSTED_PROXY_HOPS).toBe(1);
    const app = await buildServer();
    app.get('/__test/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      // spoofed by the caller, then appended by the ingress
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    });
    expect(res.json()).toEqual({ ip: '10.0.0.2' });
    await app.close();
  });
});
