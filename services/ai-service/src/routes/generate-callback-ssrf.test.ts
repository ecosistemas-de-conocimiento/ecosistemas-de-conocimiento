// Enqueue-time SSRF enforcement on POST /v1/generate (audit finding [HIGH]
// SSRF, commit "sec(ssrf-callback): guard tenant-supplied callback URLs").
//
// The route must refuse a blocked `callbackUrl` BEFORE the orchestrator
// persists or enqueues anything. The observable effect asserted here is that
// `enqueueGeneration` is NEVER invoked for a blocked URL — not merely that the
// response is a 400. (Delivery-time re-validation is pinned separately in
// `src/services/callbacks/emit-ssrf.test.ts`.)
//
// Mutation check: remove the `assertSafeCallbackUrl` call from the route → the
// metadata/loopback cases enqueue and return 200 → RED.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueGenerationMock = vi.fn();

vi.mock('../services/generation/orchestrator.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/generation/orchestrator.js')
  >('../services/generation/orchestrator.js');
  return {
    ...actual,
    enqueueGeneration: (...args: unknown[]) => enqueueGenerationMock(...args),
  };
});

/**
 * Build a server on a FRESH module graph.
 *
 * `allowPrivate` is set on `process.env` *before* `vi.resetModules()` on
 * purpose: `src/config/env.ts` parses `process.env` once at module load, so a
 * test that mutated the already-imported `env` object would be talking to a
 * different instance than the freshly-imported server graph — and would pass
 * whatever the guard did.
 */
async function makeApp(allowPrivate = false) {
  if (allowPrivate) {
    process.env.CALLBACK_ALLOW_PRIVATE = '1';
  } else {
    delete process.env.CALLBACK_ALLOW_PRIVATE;
  }
  vi.resetModules();
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  enqueueGenerationMock.mockReset();
  enqueueGenerationMock.mockResolvedValue({ requestId: 'req-1', accepted: 1 });
});

afterEach(() => {
  delete process.env.CALLBACK_ALLOW_PRIVATE;
  vi.clearAllMocks();
});

function post(app: Awaited<ReturnType<typeof makeApp>>, callbackUrl: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/generate',
    headers: { authorization: 'Bearer test-key' },
    payload: { units: [{ unitKey: 'k-1' }], callbackUrl },
  });
}

describe('POST /v1/generate — callbackUrl SSRF guard at enqueue time', () => {
  it('metadata endpoint: 400, and NOTHING is enqueued', async () => {
    const app = await makeApp();
    const res = await post(app, 'http://169.254.169.254/latest/meta-data/');
    expect(res.statusCode).toBe(400);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('loopback: 400, and NOTHING is enqueued', async () => {
    const app = await makeApp();
    const res = await post(app, 'http://127.0.0.1:9/cb');
    expect(res.statusCode).toBe(400);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('private range via IPv4-mapped IPv6: 400, and NOTHING is enqueued', async () => {
    const app = await makeApp();
    const res = await post(app, 'http://[::ffff:10.0.0.7]/cb');
    expect(res.statusCode).toBe(400);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('control: a public callbackUrl passes through to the orchestrator', async () => {
    const app = await makeApp();
    const res = await post(app, 'http://203.0.113.7/cb');
    expect(res.statusCode).toBe(200);
    expect(enqueueGenerationMock).toHaveBeenCalledTimes(1);
    const [reqArg] = enqueueGenerationMock.mock.calls[0] as [{ callbackUrl?: string }];
    expect(reqArg.callbackUrl).toBe('http://203.0.113.7/cb');
    await app.close();
  });

  it('CALLBACK_ALLOW_PRIVATE=1: a docker-network callbackUrl enqueues again', async () => {
    const app = await makeApp(true);
    const res = await post(app, 'http://172.18.0.4:3003/cb');
    expect(res.statusCode).toBe(200);
    expect(enqueueGenerationMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('CALLBACK_ALLOW_PRIVATE=1 still refuses the metadata endpoint', async () => {
    const app = await makeApp(true);
    const res = await post(app, 'http://169.254.169.254/latest/meta-data/');
    expect(res.statusCode).toBe(400);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });
});
