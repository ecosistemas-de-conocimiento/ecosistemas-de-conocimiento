// `org` option: per-client `X-AI-Org` header for org delegation (server side:
// `delegateOrgPrefix` in ai-service's `API_KEYS`, enforced in its auth plugin).

import { describe, expect, it, vi } from 'vitest';

import { AIClient, ORG_DELEGATION_CAPABILITY } from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function make(org?: string) {
  const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { ok: true }));
  const client = new AIClient({
    baseUrl: 'http://service.local',
    apiKey: 'tok',
    fetch: fetchImpl as unknown as typeof fetch,
    ...(org !== undefined ? { org } : {}),
  });
  return { client, fetchImpl };
}

function headersOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  return (fetchImpl.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
}

describe('AIClient — org option (X-AI-Org)', () => {
  it('sends X-AI-Org on every request when set', async () => {
    const { client, fetchImpl } = make('tenant-7');
    await client.budget.get('acme-tenant-7');
    await client.corpora.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      expect(headersOf(fetchImpl, call)['X-AI-Org']).toBe('tenant-7');
      expect(headersOf(fetchImpl, call).Authorization).toBe('Bearer tok');
    }
  });

  it('sends no X-AI-Org when unset (unchanged behaviour)', async () => {
    const { client, fetchImpl } = make();
    await client.budget.get('org-a');
    expect(headersOf(fetchImpl)).not.toHaveProperty('X-AI-Org');
  });

  it('two clients on one key keep their own org', async () => {
    const a = make('a');
    const b = make('b');
    await a.client.corpora.list();
    await b.client.corpora.list();
    expect(headersOf(a.fetchImpl)['X-AI-Org']).toBe('a');
    expect(headersOf(b.fetchImpl)['X-AI-Org']).toBe('b');
  });

  for (const bad of ['', 'Tenant', 'a_b', 'a.b', 'x'.repeat(49)]) {
    it(`throws at construction for org ${JSON.stringify(bad.length > 20 ? `(${bad.length} chars)` : bad)}`, () => {
      expect(() => make(bad)).toThrow(TypeError);
    });
  }

  it('exports the capability name to require before sending the header', () => {
    expect(ORG_DELEGATION_CAPABILITY).toBe('orgDelegation');
  });
});
