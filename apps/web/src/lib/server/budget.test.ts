import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { AI_SERVICE_URL: 'http://ai.test', AI_SERVICE_API_KEY: 'k' },
}));

import { AIServiceClient } from '$lib/server/aiService';
import { budgetOrgFor, fetchEcosystemBudget } from './budget';

const BUDGET = { org: 'edc-eco-7', limitUsd: 10, remainingUsd: 8.5, spentUsd: 1.5, currency: 'USD' };

describe('fetchEcosystemBudget (C-6)', () => {
  it('names the effective org `edc-eco-<id>` in the path, `eco-<id>` in the header', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const client = new AIServiceClient({
      baseUrl: 'http://ai.test',
      apiKey: 'k',
      org: 'eco-7',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify(BUDGET), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    const b = await fetchEcosystemBudget('7', client);
    expect(calls[0]!.url).toBe('http://ai.test/v1/budget/edc-eco-7');
    expect(calls[0]!.headers['X-AI-Org']).toBe('eco-7');
    expect(b).toEqual({ ok: true, limitUsd: 10, spentUsd: 1.5, remainingUsd: 8.5, currency: 'USD' });
  });

  it('a refused read (403 on a wrong org) is `ok: false`, not a throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await fetchEcosystemBudget('7', {
      getBudget: async () => {
        throw new Error('forbidden');
      },
    });
    expect(b).toEqual({ ok: false });
  });

  it('budgetOrgFor', () => {
    expect(budgetOrgFor(12)).toBe('edc-eco-12');
  });
});
