// Unit tests for /v1/embed.
//
// `callOpenRouterEmbedding` is mocked (no live HTTP) and the DB insert into
// `usage_logs` is mocked to a no-op. We cover the happy path (single string),
// batch input (array of strings), Zod-validation failure (400), and the
// atomic-reserve bracket: 402 on BudgetExceeded, true-up via `adjust` on a
// post-call overestimate, and full refund when the embedder throws.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const callOpenRouterEmbeddingMock = vi.fn();
const insertedRows: unknown[] = [];

const reserveMock = vi.fn();
const adjustMock = vi.fn();
const refundMock = vi.fn();

vi.mock('../services/ai/embeddings/openrouter.js', () => ({
  callOpenRouterEmbedding: (...args: unknown[]) =>
    callOpenRouterEmbeddingMock(...args),
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        insertedRows.push(v);
        return Promise.resolve([]);
      },
    }),
  },
}));

vi.mock('../services/budget/enforcer.js', () => ({
  BudgetEnforcer: class {
    reserve = (...args: unknown[]) => reserveMock(...args);
    adjust = (...args: unknown[]) => adjustMock(...args);
    refund = (...args: unknown[]) => refundMock(...args);
  },
}));

const APP_TOKEN = 'test-key';

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  callOpenRouterEmbeddingMock.mockReset();
  reserveMock.mockReset();
  adjustMock.mockReset();
  refundMock.mockReset();
  // Default: reserve and adjust/refund resolve without effect.
  reserveMock.mockResolvedValue({ remainingUsd: 100, softCap: false });
  adjustMock.mockResolvedValue(undefined);
  refundMock.mockResolvedValue(undefined);
  insertedRows.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/embed', () => {
  it('returns embeddings + usage on a single-string input (happy path)', async () => {
    callOpenRouterEmbeddingMock.mockResolvedValueOnce({
      embeddings: [[0.1, 0.2, 0.3]],
      model: 'openai/text-embedding-3-small',
      usage: { inputTokens: 4, estimatedCostUsd: 0.00000008 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: 'hello world' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(body.model).toBe('openai/text-embedding-3-small');
    expect(body.usage).toEqual({ inputTokens: 4, estimatedCostUsd: 0.00000008 });
    // Default model (env.EMBEDDING_MODEL, the open multilingual default) is
    // forwarded when the caller omits it.
    expect(callOpenRouterEmbeddingMock).toHaveBeenCalledWith({
      model: 'baai/bge-m3',
      input: 'hello world',
    });
    // A usage_logs row was attempted.
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0] as Record<string, unknown>;
    expect(row['endpoint']).toBe('/v1/embed');
    expect(row['inputTokens']).toBe(4);
    // Reserve was called before the embedder; adjust after.
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(adjustMock).toHaveBeenCalledTimes(1);
    expect(refundMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns one embedding per item for batch input (array of strings)', async () => {
    callOpenRouterEmbeddingMock.mockResolvedValueOnce({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
      ],
      model: 'openai/text-embedding-3-small',
      usage: { inputTokens: 12, estimatedCostUsd: 0.00000024 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: ['a', 'b', 'c'], model: 'openai/text-embedding-3-large' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.embeddings).toHaveLength(3);
    expect(callOpenRouterEmbeddingMock).toHaveBeenCalledWith({
      model: 'openai/text-embedding-3-large',
      input: ['a', 'b', 'c'],
    });
    await app.close();
  });

  it('rejects an invalid body with 400 (empty input string)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(callOpenRouterEmbeddingMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 402 BudgetExceeded when the reserve throws', async () => {
    const { BudgetExceeded } = await import('../services/budget/errors.js');
    reserveMock.mockRejectedValueOnce(new BudgetExceeded('test-org', 0.01, 0.001));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: 'some text to embed' },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe('BudgetExceeded');
    expect(body.org).toBe('test-org');
    expect(body.requested).toBe(0.01);
    expect(body.remaining).toBe(0.001);
    expect(body.shortfallUsd).toBeCloseTo(0.009, 6);
    // Embedder was NOT called.
    expect(callOpenRouterEmbeddingMock).not.toHaveBeenCalled();
    expect(adjustMock).not.toHaveBeenCalled();
    expect(refundMock).not.toHaveBeenCalled();
    // No usage_logs row was written either.
    expect(insertedRows).toHaveLength(0);
    await app.close();
  });

  it('trues up: estimated > actual ⇒ adjust called with positive refund delta', async () => {
    // Test model has embeddingPerMillion=0.02 / 1M tokens (text-embedding-3-small).
    // We need estimatedCost = 0.001 and actualCost = 0.0005.
    // Pick a custom model entry: cost = (tokens / 1e6) * 0.02.
    // For estimate 0.001 ⇒ tokens = 50_000. For actual 0.0005 ⇒ tokens = 25_000.
    // chars/4 = 50_000 ⇒ chars = 200_000.
    const longInput = 'x'.repeat(200_000);
    callOpenRouterEmbeddingMock.mockResolvedValueOnce({
      embeddings: [[0.1]],
      model: 'openai/text-embedding-3-small',
      usage: { inputTokens: 25_000, estimatedCostUsd: 0.0005 },
    });
    const app = await makeApp();
    // Explicit priced model so the true-up math is independent of the default
    // embedding model (the default is now a $0/1M open model).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: longInput, model: 'openai/text-embedding-3-small' },
    });
    expect(res.statusCode).toBe(200);

    // reserve called with estimated 0.001
    expect(reserveMock).toHaveBeenCalledTimes(1);
    const reserveCall = reserveMock.mock.calls[0]?.[0] as {
      org: string;
      amountUsd: number;
    };
    expect(reserveCall.amountUsd).toBeCloseTo(0.001, 9);

    // adjust called with +0.0005 (refund)
    expect(adjustMock).toHaveBeenCalledTimes(1);
    const adjustCall = adjustMock.mock.calls[0]?.[0] as {
      org: string;
      deltaUsd: number;
    };
    expect(adjustCall.deltaUsd).toBeCloseTo(0.0005, 9);
    expect(adjustCall.deltaUsd).toBeGreaterThan(0);

    expect(refundMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('refunds the full reserve when the embedder throws after reserve', async () => {
    callOpenRouterEmbeddingMock.mockRejectedValueOnce(new Error('upstream 503'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embed',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { input: 'hello world' },
    });
    // Fastify maps the unhandled error to 500.
    expect(res.statusCode).toBe(500);

    // reserve happened, refund called with the same amount, adjust did NOT run.
    expect(reserveMock).toHaveBeenCalledTimes(1);
    const reserveCall = reserveMock.mock.calls[0]?.[0] as {
      org: string;
      amountUsd: number;
    };
    expect(refundMock).toHaveBeenCalledTimes(1);
    const refundCall = refundMock.mock.calls[0]?.[0] as {
      org: string;
      amountUsd: number;
    };
    expect(refundCall.amountUsd).toBe(reserveCall.amountUsd);
    expect(adjustMock).not.toHaveBeenCalled();
    // No usage_logs row when the embedder failed.
    expect(insertedRows).toHaveLength(0);
    await app.close();
  });
});
