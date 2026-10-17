/**
 * Org delegation on the BFF client: each ecosistema is its own ai-service org.
 *
 * The backend's key is configured with `delegateOrgPrefix`, so a request that
 * carries `X-AI-Org: eco-<id>` acts as org `<prefix>eco-<id>` — its own budget,
 * usage and corpora. No header = the key's own org, kept for calls that have
 * no ecosistema in hand.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { AI_SERVICE_URL: 'http://ai.test', AI_SERVICE_API_KEY: 'k' },
}));

import { AIServiceClient, aiOrgFor, getAIClient } from './client';

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, name: 'ai-service', version: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const header = (i: number, name: string) =>
    (calls[i]!.init.headers as Record<string, string>)[name];
  return { fetchImpl, calls, header };
}

describe('AIServiceClient org option', () => {
  it('sends X-AI-Org on every request when org is set', async () => {
    const s = stubFetch();
    const client = new AIServiceClient({
      baseUrl: 'http://ai.test',
      apiKey: 'k',
      org: 'eco-7',
      fetch: s.fetchImpl,
    });
    await client.ping().catch(() => undefined);
    expect(s.header(0, 'X-AI-Org')).toBe('eco-7');
    expect(client.org).toBe('eco-7');
  });

  it('sends no X-AI-Org without org', async () => {
    const s = stubFetch();
    const client = new AIServiceClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: s.fetchImpl });
    await client.ping().catch(() => undefined);
    expect(s.header(0, 'X-AI-Org')).toBeUndefined();
    expect(client.org).toBeUndefined();
  });

  it('rejects an org the server would 400 on', () => {
    expect(
      () => new AIServiceClient({ baseUrl: 'http://ai.test', apiKey: 'k', org: 'Eco_7' }),
    ).toThrow(/org/);
  });
});

describe('aiOrgFor / getAIClient', () => {
  it('maps an organization id to the eco-<id> suffix', () => {
    expect(aiOrgFor(7)).toBe('eco-7');
    expect(aiOrgFor('12')).toBe('eco-12');
  });

  it('caches one client per org, and the base client separately', () => {
    const a = getAIClient(7);
    expect(getAIClient('7')).toBe(a);
    expect(a.org).toBe('eco-7');
    const b = getAIClient(8);
    expect(b).not.toBe(a);
    const base = getAIClient();
    expect(base.org).toBeUndefined();
    expect(getAIClient(null)).toBe(base);
  });
});
