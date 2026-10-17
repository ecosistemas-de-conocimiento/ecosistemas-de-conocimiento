// Who closes the Runtime a server is using (review finding 1).
//
// THE DEFECT. `buildServer()` with no argument built its own `Runtime` — a
// Redis client, BullMQ queues and a FlowProducer — and NOTHING ever closed it.
// `app.close()` closed only the rate-limit Redis client. Measured with
// `mockQueues` off against a refused Redis port: two Socket handles survived
// `app.close()` and the process exited 1 on the FlowProducer's ECONNREFUSED.
//
// The invariant has two halves, and only one of them is "close it":
//   created by buildServer → `app.close()` closes it.
//   INJECTED               → untouched, because the caller may reuse it.
//
// Sabotage: drop the `ownsRuntime` hook → case 1 RED. Register it
// unconditionally → case 2 RED.

import { describe, expect, it, vi } from 'vitest';

import { buildServer } from './server.js';
import { createTestRuntime } from './testing/runtime.js';

describe('buildServer runtime ownership', () => {
  it('closes the runtime it created for itself', async () => {
    const app = await buildServer();
    const { runtime } = app;
    // `lazyConnect` and never used: the client is parked, not closed.
    expect(runtime.redis.status).toBe('wait');
    await app.close();
    // `runtime.close()` is the only thing in this process that calls
    // `disconnect()` on it.
    expect(runtime.redis.status).toBe('end');
  });

  it('leaves an injected runtime alone — the caller closes it', async () => {
    const runtime = createTestRuntime();
    const close = vi.spyOn(runtime, 'close');
    const app = await buildServer(runtime);
    await app.close();
    expect(close).not.toHaveBeenCalled();
    expect(runtime.redis.status).toBe('wait');
    await runtime.close();
    expect(runtime.redis.status).toBe('end');
  });

  it('lets one injected runtime serve several servers', async () => {
    const runtime = createTestRuntime();
    const first = await buildServer(runtime);
    await first.close();
    // The defect this guards: closing the first server had it closed the
    // shared runtime, the second would be built on dead queues.
    const second = await buildServer(runtime);
    const res = await second.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    await second.close();
    await runtime.close();
  });
});
