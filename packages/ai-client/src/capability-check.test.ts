/**
 * The five decisions the four product forks each re-derived, pinned once.
 */

import { describe, expect, it, vi } from 'vitest';

import { createCapabilityCheck, type CapabilityNegotiator } from './capability-check.js';

// Typed against the real `negotiate` signature so `negotiate.mock.calls` is the
// argument tuple the helper actually passes, not the `[]` an untyped `vi.fn()`
// infers from a zero-parameter implementation.
type Negotiate = CapabilityNegotiator['capabilities']['negotiate'];

const negotiator = () => {
  const negotiate = vi.fn<Negotiate>(async () => ({
    status: 'ok' as const,
    missing: [],
    message: '',
  }));
  const client: CapabilityNegotiator = { capabilities: { negotiate } };
  return { client, negotiate };
};

const logger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });

describe('createCapabilityCheck', () => {
  it('negotiates once and passes consumer + list + mode through', async () => {
    const { client, negotiate } = negotiator();
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['ingestChunkCallback'],
      client: () => client,
      skipMessage: 'skipped',
      mode: () => 'strict',
    });
    const log = logger();
    await check.run(log);
    expect(negotiate).toHaveBeenCalledWith({
      consumer: 'chat',
      require: ['ingestChunkCallback'],
      mode: 'strict',
      logger: log,
    });
  });

  it('runs once per process — `onInit` re-fires on every hot reload', async () => {
    const { client, negotiate } = negotiator();
    const check = createCapabilityCheck({
      consumer: 'c',
      require: () => ['a'],
      client: () => client,
      skipMessage: 's',
    });
    await check.run(logger());
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(1);
    check.reset();
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
  });

  it('two checks do not silence each other — the latch is per instance', async () => {
    // A module-level flag (what a naive extraction would do) would make the
    // second check a no-op and leave a boot guard green having never run.
    const a = negotiator();
    const b = negotiator();
    const mk = (n: ReturnType<typeof negotiator>) =>
      createCapabilityCheck({
        consumer: 'c',
        require: () => ['x'],
        client: () => n.client,
        skipMessage: 's',
      });
    await mk(a).run(logger());
    await mk(b).run(logger());
    expect(a.negotiate).toHaveBeenCalledTimes(1);
    expect(b.negotiate).toHaveBeenCalledTimes(1);
  });

  // DRIFT: chat returned early on an empty list; a consumer app and a consumer app did not, so a
  // consumer requiring nothing still opened a connection at every boot.
  it('makes NO request when nothing is required', async () => {
    const { client, negotiate } = negotiator();
    const clientFn = vi.fn(() => client);
    await createCapabilityCheck({
      consumer: 'c',
      require: () => [],
      client: clientFn,
      skipMessage: 's',
    }).run(logger());
    expect(negotiate).not.toHaveBeenCalled();
    expect(clientFn).not.toHaveBeenCalled();
  });

  it('reads the list at CALL time, not at construction', async () => {
    // chat's list depends on PUBLIC_CHAT_BACKEND_URL; a captured array is
    // captured before any test hook can change it.
    let required: string[] = [];
    const { client, negotiate } = negotiator();
    const check = createCapabilityCheck({
      consumer: 'c',
      require: () => required,
      client: () => client,
      skipMessage: 's',
    });
    required = ['later'];
    await check.run(logger());
    expect(negotiate.mock.calls[0]![0]!.require).toEqual(['later']);
  });

  it('skips at info level when ai-service is not configured — AI is optional', async () => {
    const log = logger();
    await createCapabilityCheck({
      consumer: 'Frontend-Code',
      require: () => ['systemPrompt'],
      client: () => null,
      skipMessage: 'the offline path is supported',
    }).run(log);
    expect(log.info).toHaveBeenCalledWith('the offline path is supported');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('skips at error level where ai-service is a REQUIRED dependency, and still does not throw', async () => {
    // a consumer app's case. Boot must continue — gating boot on a dependency
    // crash-loops every replica; readiness reports 503 independently.
    const log = logger();
    await expect(
      createCapabilityCheck({
        consumer: 'edc-web',
        require: () => ['systemPrompt'],
        client: () => null,
        skipMessage: 'AI-SERVICE NOT CONFIGURED',
        skipLevel: 'error',
      }).run(log),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('AI-SERVICE NOT CONFIGURED');
  });

  it('falls back to warn when the logger has no info/error', async () => {
    const bare = { warn: vi.fn() };
    await createCapabilityCheck({
      consumer: 'c',
      require: () => ['x'],
      client: () => null,
      skipMessage: 'm',
    }).run(bare);
    expect(bare.warn).toHaveBeenCalledWith('m');
  });

  it('propagates a strict-mode negotiation throw — that is the whole point', async () => {
    const boom = new Error('missing capability');
    const client = {
      capabilities: { negotiate: vi.fn(async () => { throw boom; }) },
    } as unknown as CapabilityNegotiator;
    await expect(
      createCapabilityCheck({
        consumer: 'c',
        require: () => ['x'],
        client: () => client,
        skipMessage: 's',
      }).run(logger()),
    ).rejects.toBe(boom);
  });

  // 🔴 The latch used to be set BEFORE the await, so the one check a process
  // ever runs could be consumed by a boot that verified nothing.
  it('does NOT latch when negotiation throws — the next boot checks again', async () => {
    const negotiate = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing capability'))
      .mockResolvedValueOnce({ status: 'ok', missing: [], message: '' });
    const client = { capabilities: { negotiate } } as unknown as CapabilityNegotiator;
    const check = createCapabilityCheck({
      consumer: 'c',
      require: () => ['x'],
      client: () => client,
      skipMessage: 's',
    });
    await expect(check.run(logger())).rejects.toThrow('missing capability');
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
  });

  it('does NOT latch on a warn-mode unreachable result', async () => {
    // The real regression: in `warn` mode `negotiate` RESOLVES on unreachable.
    // Latching before the await meant every later `onInit` short-circuited, so
    // the check never re-ran once ai-service came back — green, having
    // verified nothing.
    const negotiate = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unreachable', missing: [], message: 'ECONNREFUSED' })
      .mockResolvedValueOnce({ status: 'ok', missing: [], message: '' });
    const client = { capabilities: { negotiate } } as unknown as CapabilityNegotiator;
    const check = createCapabilityCheck({
      consumer: 'c',
      require: () => ['x'],
      client: () => client,
      skipMessage: 's',
      mode: () => 'warn',
    });
    await check.run(logger());
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
    // ...and once it succeeds, it latches.
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
  });

  it('latches the skip paths — those answers cannot change mid-process', async () => {
    const clientFn = vi.fn(() => null);
    const check = createCapabilityCheck({
      consumer: 'c',
      require: () => ['x'],
      client: clientFn,
      skipMessage: 'm',
    });
    await check.run(logger());
    await check.run(logger());
    expect(clientFn).toHaveBeenCalledTimes(1);
  });
});
