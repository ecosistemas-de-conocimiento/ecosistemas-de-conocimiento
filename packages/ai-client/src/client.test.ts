// Smoke tests for AIClient — header injection, typed error mapping, timeouts.
//
// Uses an injected `fetch` mock (no global stubbing) so each test owns its
// transport. The mock returns Response objects with whatever status/body the
// test wants.

import { describe, expect, it, vi } from 'vitest';

import {
  AIClient,
  AIServiceError,
  BudgetExceededError,
  BudgetMisconfiguredError,
  BudgetNotConfiguredError,
  IdempotencyConflictError,
  SpecResolutionError,
  AuthError,
  ForbiddenError,
} from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AIClient — bearer + transport', () => {
  it('attaches Authorization: Bearer <apiKey> to every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new AIClient({
      baseUrl: 'http://service.local',
      apiKey: 'tok-123',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.budget.get('org-a');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://service.local/v1/budget/org-a');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new AIClient({
      baseUrl: 'http://service.local/',
      apiKey: 'tok',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.budget.get('o');
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://service.local/v1/budget/o');
  });
});

describe('AIClient — typed error mapping', () => {
  it('maps 402 BudgetExceeded to BudgetExceededError with fields populated', async () => {
    const body = {
      error: 'BudgetExceeded',
      org: 'org-1',
      requested: 5,
      remaining: 1,
      shortfallUsd: 4,
      message: 'Budget exceeded for org-1',
    };
    // mockImplementation creates a fresh Response per call so the body
    // stream isn't reused across the two invocations below.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(402, body));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.generate.enqueue({ units: [{ unitKey: 'u1' }] }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u1' }] });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      expect(err.org).toBe('org-1');
      expect(err.requested).toBe(5);
      expect(err.remaining).toBe(1);
      expect(err.shortfallUsd).toBe(4);
      expect(err.status).toBe(402);
    }
  });

  it('maps 402 BudgetNotConfigured to BudgetNotConfiguredError (fail-closed)', async () => {
    const body = {
      error: 'BudgetNotConfigured',
      org: 'org-unset',
      message: 'no budget configured for org org-unset',
    };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(402, body));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u1' }] });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetNotConfiguredError);
      // It must NOT collapse into the (sibling) BudgetExceededError class.
      expect(e).not.toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetNotConfiguredError;
      expect(err.org).toBe('org-unset');
      expect(err.status).toBe(402);
      expect(err.message).toContain('no budget configured');
    }
  });

  it('maps 402 BudgetMisconfigured to BudgetMisconfiguredError, distinct from the sibling 402s', async () => {
    // ai-service refuses a call whose resolved effort profile carries a zero /
    // non-finite `estimatedCostUsdPerCall` (security audit, C4 step
    // 3, strict). The org HAS a budget, so collapsing this
    // into `BudgetNotConfiguredError` would tell a consumer to ask for a budget
    // that already exists.
    const body = {
      error: 'BudgetMisconfigured',
      org: 'org-zero-estimate',
      estimatedCostUsdPerCall: 0,
      message:
        'Budget metering misconfigured for org=org-zero-estimate: the resolved effort ' +
        'profile has estimatedCostUsdPerCall=0',
    };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(402, body));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u1' }] });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetMisconfiguredError);
      expect(e).not.toBeInstanceOf(BudgetNotConfiguredError);
      expect(e).not.toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetMisconfiguredError;
      expect(err.org).toBe('org-zero-estimate');
      expect(err.estimatedCostUsdPerCall).toBe(0);
      expect(err.status).toBe(402);
      expect(err.message).toContain('estimatedCostUsdPerCall=0');
    }
  });

  it('BudgetMisconfigured with a non-finite estimate arrives as null, message keeps the value', async () => {
    // `JSON.stringify(NaN)` is `null`, so ai-service normalises the field and
    // leaves the real value in `message`. A consumer must not read the `null`
    // as "no value supplied".
    const body = {
      error: 'BudgetMisconfigured',
      org: 'org-nan',
      estimatedCostUsdPerCall: null,
      message: 'the resolved effort profile has estimatedCostUsdPerCall=NaN',
    };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(402, body));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u1' }] });
      expect.unreachable('should throw');
    } catch (e) {
      const err = e as BudgetMisconfiguredError;
      expect(err).toBeInstanceOf(BudgetMisconfiguredError);
      expect(err.estimatedCostUsdPerCall).toBeNull();
      expect(err.message).toContain('estimatedCostUsdPerCall=NaN');
    }
  });

  it('maps 409 IdempotencyConflict to IdempotencyConflictError', async () => {
    const body = {
      error: 'IdempotencyConflict',
      existingRequestId: 'req-abc',
      message: 'duplicate clientRequestId',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, body));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u' }], clientRequestId: 'cr-1' });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IdempotencyConflictError);
      expect((e as IdempotencyConflictError).existingRequestId).toBe('req-abc');
    }
  });

  it('maps 400 SpecResolutionError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: 'SpecResolutionError',
        cause: 'no spec for unitType',
        message: 'no spec for unitType',
      }),
    );
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.generate.enqueue({ units: [{ unitKey: 'u' }] });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SpecResolutionError);
      expect((e as SpecResolutionError).resolutionCause).toBe('no spec for unitType');
    }
  });

  it('maps 401 / 403 to AuthError / ForbiddenError by status', async () => {
    const fetchImpl401 = vi.fn().mockResolvedValue(jsonResponse(401, { message: 'no key' }));
    const c1 = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl401 as unknown as typeof fetch,
    });
    await expect(c1.budget.get('o')).rejects.toBeInstanceOf(AuthError);

    const fetchImpl403 = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'forbidden' }));
    const c2 = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl403 as unknown as typeof fetch,
    });
    await expect(c2.budget.get('o')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('falls back to AIServiceError for unknown error bodies', async () => {
    // `mockImplementation`, not `mockResolvedValue`: a 500 is retried, and a
    // real `fetch` returns a FRESH Response per call. Handing back one shared
    // object makes the second attempt read an already-consumed body.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(500, { message: 'boom' }));
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.budget.get('o');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AIServiceError);
      expect((e as AIServiceError).status).toBe(500);
    }
  });
});

describe('AIClient — admin API', () => {
  it('calls GET /v1/openrouter/credits and returns the snapshot', async () => {
    const body = {
      totalCredits: 100,
      totalUsage: 25,
      remainingCredits: 75,
      updatedAt: '2026-05-16T00:00:00.000Z',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const client = new AIClient({
      baseUrl: 'http://svc',
      apiKey: 'admin-tok',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.admin.getOpenRouterCredits();
    expect(result).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://svc/v1/openrouter/credits');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer admin-tok');
  });

  it('maps a 403 from the admin endpoint to ForbiddenError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'admin only' }));
    const client = new AIClient({
      baseUrl: 'http://svc',
      apiKey: 'app-tok',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.admin.getOpenRouterCredits()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AIClient — timeout', () => {
  it('aborts the underlying request after timeoutMs', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_url, init) => {
      receivedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Reject when the signal fires — matches how `fetch` behaves on abort.
        receivedSignal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          (e as { name: string }).name = 'AbortError';
          reject(e);
        });
      });
    };
    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl,
      timeoutMs: 25,
    });
    await expect(client.budget.get('o')).rejects.toBeInstanceOf(AIServiceError);
    expect(receivedSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `/v1/generate/sync` has returned `usage` + `finishReason` since the shared
// wire projection landed (`services/generation/wire-projection.ts`), but
// `SyncResult` did not declare them, so a consumer metering credits could not
// read the authoritative token count without an `as any`. Additive: both are
// optional, so nothing that compiled before stops compiling.
// ---------------------------------------------------------------------------
describe('generate.sync — usage / finishReason', () => {
  const BODY = {
    text: 'hello',
    modelUsed: 'm',
    provider: 'openrouter',
    costUsd: 0.01,
    traceId: 't-1',
  };

  it('surfaces usage and finishReason when the server sends them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...BODY,
        usage: { outputTokens: 42, inputTokens: 17, totalTokens: 59 },
        finishReason: 'stop',
      }),
    );
    const client = new AIClient({
      baseUrl: 'http://service.local',
      apiKey: 'k',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.generate.sync({ unit: { unitKey: 'answer', input: {} } });

    // Typed, not `any` — this line is the point of the test.
    expect(res.usage?.outputTokens).toBe(42);
    expect(res.usage?.inputTokens).toBe(17);
    expect(res.usage?.totalTokens).toBe(59);
    expect(res.finishReason).toBe('stop');
  });

  it('leaves both undefined when the provider reported no counts', async () => {
    // ai-service OMITS `usage` entirely rather than sending zeros, so a credits
    // meter falls back to its own estimate instead of billing an
    // authoritative-looking zero. The client must not invent a default.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, BODY));
    const client = new AIClient({
      baseUrl: 'http://service.local',
      apiKey: 'k',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.generate.sync({ unit: { unitKey: 'answer', input: {} } });

    expect(res.usage).toBeUndefined();
    expect(res.finishReason).toBeUndefined();
    expect(res.text).toBe('hello');
  });
});
