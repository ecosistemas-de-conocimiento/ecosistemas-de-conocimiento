// Retrieval outcome: 404 (corpus/document) is EMPTY, a 200 with no chunks is
// EMPTY, every other failure is `RetrievalUnavailableError`. Driven by the same
// exported conformance cases consumers run, plus the edges the cases do not
// carry (caller cancel, multi diagnostics, embed, grounding).

import { describe, expect, it, vi } from 'vitest';

import {
  AIClient,
  RETRIEVAL_CONFORMANCE_CASES,
  RETRIEVAL_EMPTY_MESSAGE,
  RETRIEVAL_UNAVAILABLE_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  GROUNDING_FIELD,
  RequestAbortedError,
  RetrievalUnavailableError,
  checkRetrievalConformance,
  groundingOf,
  retrievalConformanceFetch,
  toRetrievalOutcomeError,
  CorpusNotFoundError,
  NotFoundError,
  type RetrievalOutcome,
} from './index.js';

function clientFor(fetchImpl: typeof fetch): AIClient {
  return new AIClient({ baseUrl: 'http://ai.local', apiKey: 'k', fetch: fetchImpl, timeoutMs: 50 });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('RETRIEVAL_CONFORMANCE_CASES against client.retrieve.*Outcome', () => {
  it('covers every status the decision names', () => {
    const statuses = new Set(
      RETRIEVAL_CONFORMANCE_CASES.map((c) => ('status' in c.response ? c.response.status : c.response.fault)),
    );
    for (const s of [200, 401, 402, 403, 404, 429, 500, 502, 503, 504, 'network', 'timeout']) {
      expect(statuses.has(s as never)).toBe(true);
    }
  });

  it.each(RETRIEVAL_CONFORMANCE_CASES)('$name', async (c) => {
    const client = clientFor(retrievalConformanceFetch(c));
    const run = (): Promise<RetrievalOutcome<unknown, unknown>> =>
      c.endpoint === '/v1/retrieve/multi'
        ? client.retrieve.retrieveMultiOutcome({ corpora: ['a', 'b'], query: 'q' })
        : client.retrieve.retrieveOutcome({ corpus: 'a', query: 'q' });
    const failures = await checkRetrievalConformance(c, run);
    expect(failures).toEqual([]);
  });

  it('the checker can fail: a consumer that swallows errors as empty is caught', async () => {
    const c = RETRIEVAL_CONFORMANCE_CASES.find((x) => x.expect.kind === 'unavailable')!;
    const swallow = async (): Promise<RetrievalOutcome<unknown, unknown>> => ({
      kind: 'empty',
      reason: 'no_match',
    });
    expect((await checkRetrievalConformance(c, swallow)).length).toBeGreaterThan(0);
  });
});

describe('retrieveOutcome edges', () => {
  it('hits carry the raw result and the x-request-id trace', async () => {
    const body = { chunks: [{ chunkId: 'c', documentId: 'd', ordinal: 0, text: 't', score: 1 }], legs: ['dense'] };
    const client = clientFor(vi.fn().mockResolvedValue(json(200, body, { 'x-request-id': 'req-9' })) as never);
    const out = await client.retrieve.retrieveOutcome({ corpus: 'a', query: 'q' });
    expect(out).toEqual({ kind: 'hits', hits: body.chunks, result: body, traceId: 'req-9' });
  });

  it('a route-level 404 (no taxonomy code) is an outage, not an empty corpus', async () => {
    const body = { statusCode: 404, error: 'Not Found', message: 'Route POST:/v1/retrieve not found' };
    const client = clientFor(vi.fn().mockResolvedValue(json(404, body)) as never);
    const err = await client.retrieve.retrieveOutcome({ corpus: 'a', query: 'q' }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect(err.status).toBe(404);
    expect(err.cause).toBeInstanceOf(NotFoundError);
  });

  it('a caller cancel is rethrown unchanged — nothing is down', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = vi.fn((_u: unknown, init: RequestInit) =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError', init })),
    );
    const client = clientFor(fetchImpl as never);
    const err = await client.retrieve
      .retrieveOutcome({ corpus: 'a', query: 'q' }, { signal: ctrl.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err.reason).toBe('cancel');
  });

  it('the legacy methods are unchanged: retrieve() still throws CorpusNotFoundError', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(json(404, { error: { code: 'CORPUS_NOT_FOUND', message: 'nope' } })) as never,
    );
    await expect(client.retrieve.retrieve({ corpus: 'a', query: 'q' })).rejects.toBeInstanceOf(CorpusNotFoundError);
  });
});

describe('retrieveMultiOutcome diagnostics', () => {
  const multi = (corpora: unknown[], chunks: unknown[] = []) =>
    json(200, { query: 'q', rewritten: false, chunks, corpora });

  it('a corpus that FAILED makes the whole call unavailable, even with hits elsewhere', async () => {
    const chunk = { chunkId: 'c', documentId: 'd', ordinal: 0, text: 't', score: 1, corpus: 'a' };
    const client = clientFor(
      vi.fn().mockResolvedValue(
        multi([{ corpus: 'a', matched: 1 }, { corpus: 'b', matched: 0, error: 'failed' }], [chunk]),
      ) as never,
    );
    const err = await client.retrieve.retrieveMultiOutcome({ corpora: ['a', 'b'], query: 'q' }).catch((e) => e);
    expect(err).toBeInstanceOf(RetrievalUnavailableError);
    expect(err.failedCorpora).toEqual(['b']);
    expect(err.retryable).toBe(true);
  });

  it('some corpora missing, the rest matched nothing: no_match', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(multi([{ corpus: 'a', matched: 0, error: 'not_found' }, { corpus: 'b', matched: 0 }])) as never,
    );
    const out = await client.retrieve.retrieveMultiOutcome({ corpora: ['a', 'b'], query: 'q' });
    expect(out.kind).toBe('empty');
    expect(out.kind === 'empty' && out.reason).toBe('no_match');
  });
});

describe('embed.embedQuery', () => {
  it('returns the embeddings on 200', async () => {
    const body = { embeddings: [[0.1, 0.2]], model: 'm', usage: { inputTokens: 1, estimatedCostUsd: 0 } };
    const client = clientFor(vi.fn().mockResolvedValue(json(200, body)) as never);
    expect(await client.embed.embedQuery({ input: ['q'] } as never)).toEqual(body);
  });

  it('every failure, a 404 included, is RetrievalUnavailableError', async () => {
    for (const status of [401, 404, 429, 503]) {
      const client = clientFor(vi.fn().mockResolvedValue(json(status, { message: 'x' })) as never);
      const err = await client.embed.embedQuery({ input: ['q'] } as never).catch((e) => e);
      expect(err).toBeInstanceOf(RetrievalUnavailableError);
      expect(err.status).toBe(status);
    }
  });

  it('a 200 with no vector is unavailable, not an empty query', async () => {
    const client = clientFor(
      vi.fn().mockResolvedValue(json(200, { embeddings: [], model: 'm', usage: { inputTokens: 0, estimatedCostUsd: 0 } })) as never,
    );
    await expect(client.embed.embedQuery({ input: ['q'] } as never)).rejects.toBeInstanceOf(RetrievalUnavailableError);
  });
});

describe('grounding', () => {
  it('maps outcomes and errors to the provenance value', () => {
    expect(groundingOf({ kind: 'hits', hits: [1] })).toBe('retrieved');
    expect(groundingOf({ kind: 'empty', reason: 'corpus_not_found' })).toBe('empty');
    expect(groundingOf(new RetrievalUnavailableError({ status: 503, kind: 'server', retryable: true }))).toBe('none');
    expect(groundingOf(new Error('anything else'))).toBe('none');
    expect(groundingOf(undefined)).toBe('none');
    expect(GROUNDING_FIELD).toBe('grounding');
  });

  it('exports one Spanish sentence per state, and AI_UNAVAILABLE_MESSAGE is the unavailable one', () => {
    expect(RETRIEVAL_EMPTY_MESSAGE).toMatch(/\S/);
    expect(RETRIEVAL_UNAVAILABLE_MESSAGE).toMatch(/\S/);
    expect(RETRIEVAL_EMPTY_MESSAGE).not.toBe(RETRIEVAL_UNAVAILABLE_MESSAGE);
    expect(AI_UNAVAILABLE_MESSAGE).toBe(RETRIEVAL_UNAVAILABLE_MESSAGE);
  });

  it('toRetrievalOutcomeError maps a raw client error the same way the methods do', () => {
    const e = toRetrievalOutcomeError(new CorpusNotFoundError('x'));
    expect(e).toEqual({ kind: 'empty', reason: 'corpus_not_found' });
    const u = toRetrievalOutcomeError(new TypeError('fetch failed'));
    expect(u).toBeInstanceOf(RetrievalUnavailableError);
    expect((u as RetrievalUnavailableError).kind).toBe('network');
  });
});
