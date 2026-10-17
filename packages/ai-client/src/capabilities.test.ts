// Capability negotiation (ADR-0004).
//
// The behaviour that matters here is the SPLIT: only positive knowledge of
// absence may block a boot. An unreachable or unintelligible service must let
// the app start, because blocking on a restarting dependency would be a worse
// failure than the mis-promotion this check exists to catch.

import { describe, expect, it, vi } from 'vitest';

import { AIClient, CapabilityNegotiationError, capabilityModeFromEnv } from './index.js';

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
        mode: 'strict',
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
        mode: 'strict',
        logger: silentLogger,
      }),
    ).rejects.toBeInstanceOf(CapabilityNegotiationError);
  });

  it('warn mode logs loudly and lets the app start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DOC));
    const logger = { warn: vi.fn(), info: vi.fn() };

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['tenantProvision'],
      mode: 'warn',
      logger,
    });

    expect(res.status).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('AI_CAPABILITY_MODE=warn');
  });
});

describe('negotiate — the service predates the endpoint (404)', () => {
  it('is fatal in strict mode, says so plainly, and does not retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { message: 'Not Found' }));

    const err = await makeClient(fetchImpl)
      .capabilities.negotiate({
        consumer: 'edc-web',
        require: ['systemPrompt'],
        mode: 'strict',
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

describe('negotiate — unreachable is never fatal', () => {
  it('retries, then starts anyway even in strict mode', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const logger = { warn: vi.fn(), info: vi.fn() };

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt'],
      mode: 'strict',
      attempts: 3,
      retryDelayMs: 0,
      logger,
    });

    expect(res.status).toBe('unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('ECONNREFUSED');
  });

  it('recovers when a retry succeeds — a restarting service must not block boot', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(jsonResponse(200, DOC));

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt'],
      mode: 'strict',
      retryDelayMs: 0,
      logger: silentLogger,
    });

    expect(res.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never concludes absence from a 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt'],
      mode: 'strict',
      attempts: 2,
      retryDelayMs: 0,
      logger: silentLogger,
    });

    expect(res.status).toBe('unreachable');
  });

  it('never concludes absence from something that is not a capability document', async () => {
    // A proxy, an index page, or a wrong AI_SERVICE_URL answering 200.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { hello: 'world' }));

    const res = await makeClient(fetchImpl).capabilities.negotiate({
      consumer: 'edc-backend',
      require: ['systemPrompt'],
      mode: 'strict',
      attempts: 2,
      retryDelayMs: 0,
      logger: silentLogger,
    });

    expect(res.status).toBe('unreachable');
  });
});

describe('capabilityModeFromEnv', () => {
  it('is strict in production and warn elsewhere', () => {
    expect(capabilityModeFromEnv({ NODE_ENV: 'production' })).toBe('strict');
    expect(capabilityModeFromEnv({ NODE_ENV: 'development' })).toBe('warn');
    expect(capabilityModeFromEnv({})).toBe('warn');
  });

  it('honours an explicit AI_CAPABILITY_MODE override in both directions', () => {
    expect(capabilityModeFromEnv({ NODE_ENV: 'production', AI_CAPABILITY_MODE: 'warn' })).toBe(
      'warn',
    );
    expect(capabilityModeFromEnv({ NODE_ENV: 'development', AI_CAPABILITY_MODE: 'strict' })).toBe(
      'strict',
    );
    // Garbage falls back to the NODE_ENV rule rather than failing boot.
    expect(capabilityModeFromEnv({ NODE_ENV: 'production', AI_CAPABILITY_MODE: 'maybe' })).toBe(
      'strict',
    );
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
