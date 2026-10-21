/**
 * The boot check: strict in every environment (0.32.0). It resolves only when
 * ai-service is configured, reachable and has every required capability.
 */

import { describe, expect, it, vi } from 'vitest';

import { AIClient, CapabilityNegotiationError } from './index.js';
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

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A real AIClient over a fake fetch, with a zero-delay probe window. */
const realClient = (fetchImpl: unknown): CapabilityNegotiator => {
  const client = new AIClient({
    baseUrl: 'http://ai.local',
    apiKey: 'tok',
    fetch: fetchImpl as typeof fetch,
  });
  return {
    capabilities: {
      negotiate: (o) => client.capabilities.negotiate({ ...o, attempts: 2, retryDelayMs: 0 }),
    },
  };
};

describe('createCapabilityCheck — against a real client', () => {
  it('unreachable ai-service → throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['systemPrompt'],
      client: () => realClient(fetchImpl),
    });
    await expect(check.run(logger())).rejects.toMatchObject({
      name: 'CapabilityNegotiationError',
      status: 'unreachable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('capability mismatch → throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { capabilities: { systemPrompt: false } }));
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['systemPrompt'],
      client: () => realClient(fetchImpl),
    });
    const err = await check.run(logger()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    expect((err as CapabilityNegotiationError).missing).toEqual(['systemPrompt']);
  });

  it('reachable and matching → resolves', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { capabilities: { systemPrompt: true } }));
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['systemPrompt'],
      client: () => realClient(fetchImpl),
    });
    await expect(check.run(logger())).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createCapabilityCheck', () => {
  it('negotiates once and passes consumer + list + logger through', async () => {
    const { client, negotiate } = negotiator();
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['ingestChunkCallback'],
      client: () => client,
    });
    const log = logger();
    await check.run(log);
    expect(negotiate).toHaveBeenCalledWith({
      consumer: 'chat',
      require: ['ingestChunkCallback'],
      logger: log,
    });
  });

  it('runs once per process after a pass — `onInit` re-fires on every hot reload', async () => {
    const { client, negotiate } = negotiator();
    const check = createCapabilityCheck({
      consumer: 'chat',
      require: () => ['x'],
      client: () => client,
    });
    await check.run(logger());
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(1);
    check.reset();
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
  });

  it('two checks do not silence each other — the latch is per instance', async () => {
    const a = negotiator();
    const b = negotiator();
    await createCapabilityCheck({ consumer: 'a', require: () => ['x'], client: () => a.client }).run(
      logger(),
    );
    await createCapabilityCheck({ consumer: 'b', require: () => ['x'], client: () => b.client }).run(
      logger(),
    );
    expect(a.negotiate).toHaveBeenCalledTimes(1);
    expect(b.negotiate).toHaveBeenCalledTimes(1);
  });

  it('still probes when nothing is required — reachability is itself required', async () => {
    const { client, negotiate } = negotiator();
    await createCapabilityCheck({ consumer: 'chat', require: () => [], client: () => client }).run(
      logger(),
    );
    expect(negotiate).toHaveBeenCalledWith(expect.objectContaining({ require: [] }));
  });

  it('reads the list at CALL time, not at construction', async () => {
    const { client, negotiate } = negotiator();
    let list: string[] = ['a'];
    const check = createCapabilityCheck({ consumer: 'chat', require: () => list, client: () => client });
    list = ['b'];
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledWith(expect.objectContaining({ require: ['b'] }));
  });

  it('THROWS when ai-service is not configured, and does not latch', async () => {
    const { client, negotiate } = negotiator();
    let configured = false;
    const check = createCapabilityCheck({
      consumer: 'a consumer app',
      require: () => ['x'],
      client: () => (configured ? client : null),
    });
    await expect(check.run(logger())).rejects.toThrow(/a consumer app: ai-service is not configured/);
    configured = true;
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(1);
  });

  it('does NOT latch when negotiation throws — the next boot checks again', async () => {
    const { client, negotiate } = negotiator();
    negotiate.mockRejectedValueOnce(
      new CapabilityNegotiationError('down', {
        consumer: 'chat',
        baseUrl: 'http://ai.local',
        missing: [],
        status: 'unreachable',
      }),
    );
    const check = createCapabilityCheck({ consumer: 'chat', require: () => ['x'], client: () => client });
    await expect(check.run(logger())).rejects.toBeInstanceOf(CapabilityNegotiationError);
    await check.run(logger());
    expect(negotiate).toHaveBeenCalledTimes(2);
  });
});
