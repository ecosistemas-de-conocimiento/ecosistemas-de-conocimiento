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
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
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
