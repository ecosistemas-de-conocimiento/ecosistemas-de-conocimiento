// client.route() + client.textToSql() — injected-fetch transport tests.
// No real network / LLM: the fetch mock returns canned ai-service responses.

import { describe, expect, it, vi } from 'vitest';

import { AIClient } from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('client.route()', () => {
  it('POSTs to /v1/route and returns { routeId, reason }', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { routeId: 'sql', reason: 'aggregation question' }));
    const client = new AIClient({
      baseUrl: 'http://svc',
      apiKey: 'k',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const out = await client.route({
      question: 'how many rows are there?',
      candidates: [
        { id: 'search', description: 'semantic text search' },
        { id: 'sql', description: 'aggregate over a table' },
      ],
    });

    expect(out).toEqual({ routeId: 'sql', reason: 'aggregation question' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://svc/v1/route');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.candidates).toHaveLength(2);
    expect(body.question).toMatch(/how many/);
  });
});

describe('client.textToSql()', () => {
  it('generates via /v1/generate/sync and returns a guarded, LIMIT-appended SELECT', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        text: 'SELECT count(*) FROM obras',
        modelUsed: 'm',
        provider: 'p',
        costUsd: 0,
        traceId: 't',
      }),
    );
    const client = new AIClient({
      baseUrl: 'http://svc',
      apiKey: 'k',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const out = await client.textToSql({
      question: 'how many obras?',
      tableName: 'obras',
      columns: [{ name: 'id', type: 'int' }, { name: 'estado', type: 'text' }],
    });

    expect(out.valid).toBe(true);
    expect(out.sql).toBe('SELECT count(*) FROM obras LIMIT 100');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://svc/v1/generate/sync');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.unit.unitType).toBe('text-to-sql');
    expect(body.unit.input.tableName).toBe('obras');
  });

  it('rejects (without throwing) when the model emits a non-SELECT', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        text: 'DELETE FROM obras',
        modelUsed: 'm',
        provider: 'p',
        costUsd: 0,
        traceId: 't',
      }),
    );
    const client = new AIClient({
      baseUrl: 'http://svc',
      apiKey: 'k',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const out = await client.textToSql({
      question: 'delete everything',
      tableName: 'obras',
      columns: [{ name: 'id', type: 'int' }],
    });

    expect(out.valid).toBe(false);
    expect(out.rejectionReason).toBeTruthy();
  });
});
