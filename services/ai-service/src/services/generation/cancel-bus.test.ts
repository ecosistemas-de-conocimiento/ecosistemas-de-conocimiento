// The cancel bus logs its errors through the logger's `err` serializer
// (`errors/log-safe.ts`), never as raw text on the console. ioredis is
// replaced by an in-memory stand-in; the cross-pod behaviour against a real
// Redis is `cancel-bus.integration.test.ts`.

import type { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));

vi.mock('ioredis', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Redis extends Emitter {
    publishError: Error | null = null;
    constructor() {
      super();
      fakes.instances.push(this as unknown as Record<string, unknown>);
    }
    async subscribe() {}
    async publish() {
      if (this.publishError) throw this.publishError;
      return 1;
    }
    async quit() {}
    disconnect() {}
  }
  return { Redis };
});

const { RedisCancelBus } = await import('./cancel-bus.js');
const { capturedLog } = await import('../../testing/captured-log.js');

const ROW_TEXT = 'Juana Pérez declaró en la audiencia';
const leaky = () => Object.assign(new Error(`Failed query: select … params: ${ROW_TEXT}`), { code: '57014' });

afterEach(() => {
  fakes.instances.length = 0;
  vi.restoreAllMocks();
});

async function started() {
  const consoleCalls = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  const { log, lines } = capturedLog();
  const bus = new RedisCancelBus('redis://fake', log);
  await bus.start();
  const [pub, sub] = fakes.instances as unknown as [
    EventEmitter & { publishError: Error | null },
    EventEmitter,
  ];
  return { bus, pub, sub, lines, consoleCalls };
}

describe('🔴 RedisCancelBus logs no raw error text', () => {
  it.each([
    [
      'a subscriber error',
      async ({ sub }: Awaited<ReturnType<typeof started>>) => {
        sub.emit('error', leaky());
      },
      '[cancel-bus] subscriber error',
    ],
    [
      'a failed publish',
      async ({ bus, pub }: Awaited<ReturnType<typeof started>>) => {
        pub.publishError = leaky();
        await bus.publish('req-1');
      },
      '[cancel-bus] publish failed',
    ],
    [
      'a handler that throws',
      async ({ bus, sub }: Awaited<ReturnType<typeof started>>) => {
        bus.onCancel(() => {
          throw leaky();
        });
        sub.emit('message', 'gen:cancel', 'req-1');
      },
      '[cancel-bus] handler threw',
    ],
  ])('%s', async (_what, provoke, msg) => {
    const ctx = await started();
    await provoke(ctx);
    for (const spy of ctx.consoleCalls) expect(spy).not.toHaveBeenCalled();
    expect(ctx.lines).toHaveLength(1);
    const line = JSON.parse(ctx.lines[0]!) as { msg: string; err: Record<string, unknown> };
    expect(line.msg).toBe(msg);
    expect(line.err).toMatchObject({ type: 'Error', code: '57014' });
    expect(ctx.lines[0]).not.toContain('Juana');
  });
});
