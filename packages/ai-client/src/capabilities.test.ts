// Capability negotiation (ADR-0004).
//
// Strict in every environment since 0.32.0: ai-service is a required
// dependency, so every outcome except `ok` throws. An unreachable service gets
// a bounded retry window first, then fails the boot.

import { describe, expect, it, vi } from 'vitest';

import {
  AIClient,
  CapabilityNegotiationError,
  METADATA_FILTER_IN_CAPABILITY,
} from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: unknown): AIClient {
  return new AIClient({
    baseUrl: 'http://ai.local',
    apiKey: 'tok',
    fetch: fetchImpl as typeof fetch,
  });
}

const DOC = {
  capabilities: { systemPrompt: true, strictParsed: true, tenantProvision: false },
};

const silentLogger = { warn: vi.fn(), info: vi.fn() };

describe('capabilities.get', () => {
  it('fetches GET /v1/capabilities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DOC));
    const doc = await makeClient(fetchImpl).capabilities.get();

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://ai.local/v1/capabilities');
    expect(doc).toEqual(DOC);
  });
});

describe('negotiate — the service has what we need', () => {
  it('returns ok and does not throw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DOC));
    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt', 'strictParsed'],
      logger: silentLogger,
    });

    expect(res.status).toBe('ok');
    expect(res.missing).toEqual([]);
  });
});

describe('negotiate — reachable and positively lacking (the fatal case)', () => {
  it('throws in strict mode with an actionable message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DOC));
    const client = makeClient(fetchImpl);

    const err = await client.capabilities
      .negotiate({
        consumer: 'edc-web',
        require: ['systemPrompt', 'tenantProvision'],
        logger: silentLogger,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    const e = err as CapabilityNegotiationError;
    expect(e.missing).toEqual(['tenantProvision']);
    // Names the consumer, the capability, the environment and the fix — the
    // whole point of the ADR. No version: see CapabilityDocument's doc comment.
    expect(e.message).toContain('edc-web');
    expect(e.message).toContain('`tenantProvision`');
    expect(e.message).toContain('http://ai.local');
    expect(e.message).toMatch(/Deploy ai-service .* first/);
    expect(e.message).not.toMatch(/version/i);
  });

  it('treats a false capability the same as an absent one', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { capabilities: {} }));

    await expect(
      makeClient(fetchImpl).capabilities.negotiate({
        consumer: 'chat',
        require: ['systemPrompt'],
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(CapabilityNegotiationError);
  });

  it("ignores a stale `mode: 'warn'` from an untyped caller — there is no warn mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DOC));

    await expect(
      makeClient(fetchImpl).capabilities.negotiate({
        consumer: 'a consumer app',
        require: ['tenantProvision'],
        mode: 'warn',
        logger: silentLogger,
      } as never),
    ).rejects.toBeInstanceOf(CapabilityNegotiationError);
  });
});

describe('negotiate — the service predates the endpoint (404)', () => {
  it('is fatal in strict mode, says so plainly, and does not retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { message: 'Not Found' }));

    const err = await makeClient(fetchImpl)
      .capabilities.negotiate({
        consumer: 'edc-web',
        require: ['systemPrompt'],
        logger: silentLogger,
      })
      .then(
        () => null,
        (e: unknown) => e as CapabilityNegotiationError,
      );

    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    expect((err as CapabilityNegotiationError).status).toBe('unsupported');
    expect((err as CapabilityNegotiationError).message).toContain('predates ADR-0004');
    // 404 is a definitive answer — retrying it would only slow the boot down.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('negotiate — unreachable fails the boot after the retry window', () => {
  it('retries, then throws with the cause and a fix', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await makeClient(fetchImpl)
      .capabilities.negotiate({
        consumer: 'a consumer app',
        require: ['systemPrompt'],
        attempts: 3,
        retryDelayMs: 0,
        logger: silentLogger,
      })
      .then(
        () => null,
        (e: unknown) => e as CapabilityNegotiationError,
      );

    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    expect(err!.status).toBe('unreachable');
    expect(err!.message).toContain('ECONNREFUSED');
    expect(err!.message).toContain('AI_SERVICE_URL');
    expect(err!.message).toContain('Refusing to start');
    expect(err!.message).not.toMatch(/Starting anyway/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('bounds each attempt with attemptTimeoutMs — a hanging service still fails the boot', async () => {
    // Never settles unless aborted.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const err = await makeClient(fetchImpl)
      .capabilities.negotiate({
        consumer: 'a consumer app',
        require: ['systemPrompt'],
        attempts: 2,
        retryDelayMs: 0,
        attemptTimeoutMs: 20,
        logger: silentLogger,
      })
      .then(
        () => null,
        (e: unknown) => e as CapabilityNegotiationError,
      );

    expect(err).toBeInstanceOf(CapabilityNegotiationError);
    expect(err!.status).toBe('unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers when a retry succeeds — a restarting service must not block boot', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(jsonResponse(200, DOC));

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt'],
      retryDelayMs: 0,
      logger: silentLogger,
    });

    expect(res.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('classifies a 5xx as unreachable, not missing, and throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));

    await expect(
      makeClient(fetchImpl).capabilities.negotiate({
        consumer: 'a consumer app',
        require: ['systemPrompt'],
        attempts: 2,
        retryDelayMs: 0,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ status: 'unreachable', missing: [] });
  });

  it('classifies a non-capability document as unreachable and throws', async () => {
    // A proxy, an index page, or a wrong AI_SERVICE_URL answering 200.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { hello: 'world' }));

    await expect(
      makeClient(fetchImpl).capabilities.negotiate({
        consumer: 'a consumer app',
        require: ['systemPrompt'],
        attempts: 2,
        retryDelayMs: 0,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ status: 'unreachable', missing: [] });
  });
});

describe('strictStructuredOutputCapabilities', () => {
  it('names the feature, and the per-model name in the server format', async () => {
    const { strictStructuredOutputCapabilities } = await import('./index.js');
    expect(strictStructuredOutputCapabilities()).toEqual(['strictStructuredOutput']);
    // Same literal as `src/routes/capabilities.test.ts` on the server side.
    expect(strictStructuredOutputCapabilities('openai/gpt-4o-mini')).toEqual([
      'strictStructuredOutput',
      'strictStructuredOutput:openai/gpt-4o-mini',
    ]);
  });
});

describe('METADATA_FILTER_IN_CAPABILITY', () => {
  it('names the server capability for `$in` filters and `corpusFilters`', () => {
    expect(METADATA_FILTER_IN_CAPABILITY).toBe('metadataFilterIn');
  });
});
