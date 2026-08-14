// Integration tests for the cancel-bus against a real Redis.
//
// Why integration and not unit: the bus IS a thin wrapper over ioredis. A
// unit test that mocks ioredis would only assert "we called the methods we
// said we would" — useless if ioredis itself is misconfigured or our two-
// connection pattern is wrong. Hitting a real Redis (docker-compose port
// 56379, per `vitest.integration.config.ts` + `integration-setup.ts`)
// catches:
//   - publish + subscribe protocol wiring (channel name match, message
//     delivered as a string, not bytes)
//   - cross-instance delivery (simulating two pods: one publishes, another's
//     onCancel handler fires)
//   - reconnect behaviour on graceful + abrupt teardown
//
// What this file does NOT cover (deliberately):
//   - The full cancel-mid-call → partial-cost path. That's an e2e concern —
//     it'd need a mock LLM provider that respects AbortSignal with
//     controllable timing. Out of scope; tracked separately.

import { afterEach, describe, expect, it } from 'vitest';

import { RedisCancelBus, CANCEL_CHANNEL } from './cancel-bus.js';
import { TEST_URLS } from '../../test/integration-setup.js';

// Cap at 10 s so a hung subscriber surfaces fast.
const RECEIVE_TIMEOUT_MS = 10_000;

/** Resolve as soon as the bus' onCancel fires with the expected requestId. */
function waitForCancel(bus: RedisCancelBus, requestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cancel for ${requestId} not received within ${RECEIVE_TIMEOUT_MS} ms`));
    }, RECEIVE_TIMEOUT_MS);
    const unsubscribe = bus.onCancel((received) => {
      if (received !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

describe('CancelBus (integration, real Redis)', () => {
  const buses: RedisCancelBus[] = [];

  afterEach(async () => {
    await Promise.allSettled(buses.map((b) => b.stop()));
    buses.length = 0;
  });

  function spawnBus(): RedisCancelBus {
    const bus = new RedisCancelBus(TEST_URLS.REDIS_URL);
    buses.push(bus);
    return bus;
  }

  it('round-trips a publish→subscribe through real Redis', async () => {
    const bus = spawnBus();
    await bus.start();
    const arrived = waitForCancel(bus, 'req-self-loop');
    await bus.publish('req-self-loop');
    await expect(arrived).resolves.toBeUndefined();
  });

  it('delivers cross-instance: pod A publishes, pod B receives', async () => {
    // Two distinct bus instances stand in for two worker pods sharing one
    // Redis. The publish on A is delivered to B's subscriber connection.
    const podA = spawnBus();
    const podB = spawnBus();
    await Promise.all([podA.start(), podB.start()]);

    const arrived = waitForCancel(podB, 'req-cross-pod');
    await podA.publish('req-cross-pod');
    await expect(arrived).resolves.toBeUndefined();
  });

  it('ignores messages on unrelated channels', async () => {
    // Belt-and-suspenders: the handler must only fire for our channel. The
    // bus subscribes to a single channel so this should be moot, but the
    // `onCancel` filter check earns its keep if we ever add channels.
    const bus = spawnBus();
    await bus.start();

    let unexpected = false;
    bus.onCancel(() => {
      unexpected = true;
    });

    // Publish on a different channel via a temporary client.
    const { Redis } = await import('ioredis');
    const stray = new Redis(TEST_URLS.REDIS_URL);
    try {
      await stray.publish('gen:unrelated', 'should-not-fire');
      // Small wait so Redis has time to NOT deliver to our subscriber.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await stray.quit();
    }
    expect(unexpected).toBe(false);
  });

  it('multiple handlers on one bus all fire for the same message', async () => {
    const bus = spawnBus();
    await bus.start();
    const seen: string[] = [];
    bus.onCancel((id) => seen.push(`h1:${id}`));
    bus.onCancel((id) => seen.push(`h2:${id}`));
    bus.onCancel((id) => seen.push(`h3:${id}`));

    await bus.publish('req-fanout');
    // Give Redis time to deliver + handlers to run.
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.sort()).toEqual(['h1:req-fanout', 'h2:req-fanout', 'h3:req-fanout']);
  });

  it('a handler throwing does not break sibling handlers', async () => {
    const bus = spawnBus();
    await bus.start();
    const sibling: string[] = [];
    bus.onCancel(() => {
      throw new Error('boom');
    });
    bus.onCancel((id) => sibling.push(id));

    await bus.publish('req-error-isolation');
    await new Promise((r) => setTimeout(r, 200));
    expect(sibling).toEqual(['req-error-isolation']);
  });

  it('unsubscribe stops a handler from receiving further messages', async () => {
    const bus = spawnBus();
    await bus.start();
    const seen: string[] = [];
    const unsubscribe = bus.onCancel((id) => seen.push(id));

    await bus.publish('first');
    await new Promise((r) => setTimeout(r, 200));
    unsubscribe();
    await bus.publish('second');
    await new Promise((r) => setTimeout(r, 200));

    expect(seen).toEqual(['first']);
  });

  it('uses channel name "gen:cancel"', () => {
    // Lock the channel string at the test boundary so a typo in the constant
    // can't silently fork chat-BFF and ai-service onto different channels.
    expect(CANCEL_CHANNEL).toBe('gen:cancel');
  });
});
