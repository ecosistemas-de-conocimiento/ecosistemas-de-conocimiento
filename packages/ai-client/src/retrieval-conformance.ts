/**
 * Conformance cases for the retrieval outcome rule (`./retrieval-outcome.ts`).
 *
 * Same control as `callbacks/conformance.ts` and `stream-conformance.ts`: five
 * products wrap retrieval, and each one decided on its own what a 404, a 429
 * or a dead network means. Most decided "empty". These cases are the one
 * answer, as data, so a consumer's wrapper goes red when it disagrees.
 *
 * In a consumer repo, one test per case:
 *
 * ```ts
 * import {
 *   AIClient, RETRIEVAL_CONFORMANCE_CASES,
 *   retrievalConformanceFetch, checkRetrievalConformance,
 * } from '@edc/ai-client';
 *
 * it.each(RETRIEVAL_CONFORMANCE_CASES)('$name', async (c) => {
 *   const client = new AIClient({
 *     baseUrl: 'http://ai.local', apiKey: 'k',
 *     fetch: retrievalConformanceFetch(c),
 *     timeoutMs: RETRIEVAL_CONFORMANCE_TIMEOUT_MS,
 *   });
 *   // Call YOUR wrapper, built on this client, the way production does.
 *   const failures = await checkRetrievalConformance(c, () => myRetrieve(client));
 *   expect(failures).toEqual([]);
 * });
 * ```
 *
 * `run` must resolve to a `RetrievalOutcome` or throw. For an `unavailable`
 * case it must throw a `RetrievalUnavailableError` (checked by `name`, so a
 * duplicated package copy still passes) with the expected `status`, `kind`
 * and `retryable`.
 *
 * `fault: 'timeout'` holds the request open until the client aborts it, so the
 * client under test needs a short `timeoutMs` — use
 * `RETRIEVAL_CONFORMANCE_TIMEOUT_MS`.
 */

import {
  groundingOf,
  type EmptyRetrievalReason,
  type Grounding,
  type RetrievalOutcome,
  type RetrievalUnavailableKind,
} from './retrieval-outcome.js';

export const RETRIEVAL_CONFORMANCE_TIMEOUT_MS = 50;

export type RetrievalConformanceResponse =
  | { status: number; body: unknown; rawBody?: never }
  | { status: number; rawBody: string; body?: never }
  | { fault: 'network' | 'timeout' };

export interface RetrievalConformanceCase {
  /** What divergence this case pins. */
  name: string;
  endpoint: '/v1/retrieve' | '/v1/retrieve/multi';
  response: RetrievalConformanceResponse;
  expect:
    | { kind: 'hits'; hitCount: number; grounding: 'retrieved'; traceId?: string }
    | { kind: 'empty'; reason: EmptyRetrievalReason; grounding: 'empty'; traceId?: string }
    | {
        kind: 'unavailable';
        status: number;
        unavailableKind: RetrievalUnavailableKind;
        retryable: boolean;
        grounding: 'none';
        traceId?: string;
      };
}

const TRACE = 'conformance-trace';
const CHUNK = { chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'pasaje', score: 0.9 };
const nested = (code: string) => ({ error: { code, message: `${code} (conformance)` } });
const multi = (corpora: unknown[], chunks: unknown[] = []) => ({
  query: 'q',
  rewritten: false,
  chunks,
  corpora,
});
const down = (
  status: number,
  unavailableKind: RetrievalUnavailableKind,
  retryable: boolean,
  traceId: string | null = TRACE,
) =>
  ({
    kind: 'unavailable',
    status,
    unavailableKind,
    retryable,
    grounding: 'none',
    ...(traceId !== null ? { traceId } : {}),
  }) as const;

export const RETRIEVAL_CONFORMANCE_CASES: readonly RetrievalConformanceCase[] = [
  // ── /v1/retrieve: the two healthy answers ────────────────────────────────
  {
    name: 'retrieve 200 with chunks is hits',
    endpoint: '/v1/retrieve',
    response: { status: 200, body: { chunks: [CHUNK], legs: ['dense'] } },
    expect: { kind: 'hits', hitCount: 1, grounding: 'retrieved', traceId: TRACE },
  },
  {
    name: 'retrieve 200 with no chunks is empty/no_match',
    endpoint: '/v1/retrieve',
    response: { status: 200, body: { chunks: [], legs: [] } },
    expect: { kind: 'empty', reason: 'no_match', grounding: 'empty', traceId: TRACE },
  },
  // ── the typed 404s: empty, never an error ────────────────────────────────
  {
    name: 'retrieve 404 CORPUS_NOT_FOUND is empty/corpus_not_found (new chat session)',
    endpoint: '/v1/retrieve',
    response: { status: 404, body: nested('CORPUS_NOT_FOUND') },
    expect: { kind: 'empty', reason: 'corpus_not_found', grounding: 'empty', traceId: TRACE },
  },
  {
    name: 'retrieve 404 TARGET_CORPUS_NOT_FOUND (dangling alias) is empty/corpus_not_found',
    endpoint: '/v1/retrieve',
    response: { status: 404, body: nested('TARGET_CORPUS_NOT_FOUND') },
    expect: { kind: 'empty', reason: 'corpus_not_found', grounding: 'empty', traceId: TRACE },
  },
  {
    name: 'retrieve 404 DOCUMENT_NOT_FOUND is empty/document_not_found',
    endpoint: '/v1/retrieve',
    response: { status: 404, body: nested('DOCUMENT_NOT_FOUND') },
    expect: { kind: 'empty', reason: 'document_not_found', grounding: 'empty', traceId: TRACE },
  },
  // ── everything else is an outage ─────────────────────────────────────────
  {
    name: 'retrieve 404 with no taxonomy code (route missing) is unavailable, NOT empty',
    endpoint: '/v1/retrieve',
    response: {
      status: 404,
      body: { statusCode: 404, error: 'Not Found', message: 'Route POST:/v1/retrieve not found' },
    },
    expect: down(404, 'not_found', false),
  },
  {
    name: 'retrieve 400 (consumer bug) is unavailable, not empty',
    endpoint: '/v1/retrieve',
    response: { status: 400, body: { statusCode: 400, error: 'Bad Request', message: 'query required' } },
    expect: down(400, 'bad_request', false),
  },
  {
    name: 'retrieve 401 is unavailable/auth',
    endpoint: '/v1/retrieve',
    response: { status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'bad key' } },
    expect: down(401, 'auth', false),
  },
  {
    name: 'retrieve 401 api_key_expired is unavailable/auth',
    endpoint: '/v1/retrieve',
    response: { status: 401, body: { error: 'api_key_expired', message: 'key expired' } },
    expect: down(401, 'auth', false),
  },
  {
    name: 'retrieve 402 BudgetNotConfigured is unavailable/budget',
    endpoint: '/v1/retrieve',
    response: { status: 402, body: { error: 'BudgetNotConfigured', message: 'no budget', org: 'o' } },
    expect: down(402, 'budget', false),
  },
  {
    name: 'retrieve 402 BudgetExceeded is unavailable/budget',
    endpoint: '/v1/retrieve',
    response: {
      status: 402,
      body: { error: 'BudgetExceeded', message: 'over', org: 'o', requested: 1, remaining: 0, shortfallUsd: 1 },
    },
    expect: down(402, 'budget', false),
  },
  {
    name: 'retrieve 403 is unavailable/auth',
    endpoint: '/v1/retrieve',
    response: { status: 403, body: { statusCode: 403, error: 'Forbidden', message: 'scope' } },
    expect: down(403, 'auth', false),
  },
  {
    name: 'retrieve 429 is unavailable/rate_limit, retryable',
    endpoint: '/v1/retrieve',
    response: { status: 429, body: { error: 'RateLimitExceeded', message: 'slow down', retryAfterMs: 1000 } },
    expect: down(429, 'rate_limit', true),
  },
  {
    name: 'retrieve 500 is unavailable/server, retryable',
    endpoint: '/v1/retrieve',
    response: { status: 500, body: { statusCode: 500, error: 'Internal Server Error', message: 'boom' } },
    expect: down(500, 'server', true),
  },
  {
    name: 'retrieve 502 with an HTML proxy page is unavailable/server',
    endpoint: '/v1/retrieve',
    response: { status: 502, rawBody: '<html><body>Bad Gateway</body></html>' },
    expect: down(502, 'server', true),
  },
  {
    name: 'retrieve 503 ProviderUnavailable is unavailable/server, retryable',
    endpoint: '/v1/retrieve',
    response: { status: 503, body: { error: 'ProviderUnavailable', message: 'breaker open', retryAfterMs: 5000 } },
    expect: down(503, 'server', true),
  },
  {
    name: 'retrieve 504 is unavailable/server, retryable',
    endpoint: '/v1/retrieve',
    response: { status: 504, body: { error: 'ProviderTimeout', message: 'too slow' } },
    expect: down(504, 'server', true),
  },
  {
    name: 'retrieve 200 with a body that is not a result is unavailable/invalid_response',
    endpoint: '/v1/retrieve',
    response: { status: 200, rawBody: '<html>login</html>' },
    expect: down(200, 'invalid_response', false),
  },
  {
    name: 'retrieve network failure is unavailable/network, status 0',
    endpoint: '/v1/retrieve',
    response: { fault: 'network' },
    expect: down(0, 'network', true, null),
  },
  {
    name: 'retrieve client timeout is unavailable/timeout, status 0',
    endpoint: '/v1/retrieve',
    response: { fault: 'timeout' },
    expect: down(0, 'timeout', true, null),
  },
  // ── /v1/retrieve/multi: 200 carries per-corpus diagnostics ───────────────
  {
    name: 'multi 200 with chunks is hits',
    endpoint: '/v1/retrieve/multi',
    response: {
      status: 200,
      body: multi([{ corpus: 'a', matched: 1 }, { corpus: 'b', matched: 0 }], [{ ...CHUNK, corpus: 'a' }]),
    },
    expect: { kind: 'hits', hitCount: 1, grounding: 'retrieved', traceId: TRACE },
  },
  {
    name: 'multi 200 where a corpus FAILED is unavailable/corpus_failed, even with hits',
    endpoint: '/v1/retrieve/multi',
    response: {
      status: 200,
      body: multi(
        [{ corpus: 'a', matched: 1 }, { corpus: 'b', matched: 0, error: 'failed' }],
        [{ ...CHUNK, corpus: 'a' }],
      ),
    },
    expect: down(200, 'corpus_failed', true),
  },
  {
    name: 'multi 200 where every corpus is not_found is empty/corpus_not_found',
    endpoint: '/v1/retrieve/multi',
    response: {
      status: 200,
      body: multi([
        { corpus: 'a', matched: 0, error: 'not_found' },
        { corpus: 'b', matched: 0, error: 'not_found' },
      ]),
    },
    expect: { kind: 'empty', reason: 'corpus_not_found', grounding: 'empty', traceId: TRACE },
  },
  {
    name: 'multi 200 with no chunks and no failures is empty/no_match',
    endpoint: '/v1/retrieve/multi',
    response: {
      status: 200,
      body: multi([{ corpus: 'a', matched: 0, error: 'not_found' }, { corpus: 'b', matched: 0 }]),
    },
    expect: { kind: 'empty', reason: 'no_match', grounding: 'empty', traceId: TRACE },
  },
  {
    name: 'multi 503 is unavailable/server',
    endpoint: '/v1/retrieve/multi',
    response: { status: 503, body: { error: 'ProviderUnavailable', message: 'down' } },
    expect: down(503, 'server', true),
  },
];

/**
 * A fake ai-service for one case: a `fetch` that answers with the case's
 * status and body (and `x-request-id`), rejects like a dead network, or holds
 * the request open until the client's abort signal fires.
 */
export function retrievalConformanceFetch(c: RetrievalConformanceCase): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    const r = c.response;
    if ('fault' in r) {
      if (r.fault === 'network') return Promise.reject(new TypeError('fetch failed'));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const isRaw = typeof r.rawBody === 'string';
    return Promise.resolve(
      new Response(isRaw ? r.rawBody : JSON.stringify(r.body), {
        status: r.status,
        headers: {
          'Content-Type': isRaw ? 'text/html' : 'application/json',
          'x-request-id': TRACE,
        },
      }),
    );
  }) as typeof fetch;
}

/**
 * Run a consumer's retrieval call against a case. Returns the list of
 * mismatches — `[]` means the consumer conforms.
 */
export async function checkRetrievalConformance(
  c: RetrievalConformanceCase,
  run: () => Promise<RetrievalOutcome<unknown, unknown>>,
): Promise<string[]> {
  const failures: string[] = [];
  const want = c.expect;
  let outcome: RetrievalOutcome<unknown, unknown> | undefined;
  let thrown: unknown;
  try {
    outcome = await run();
  } catch (err) {
    thrown = err;
  }
  const got: Grounding = thrown !== undefined ? 'none' : groundingOf(outcome);
  if (got !== want.grounding) failures.push(`grounding: want ${want.grounding}, got ${got}`);

  if (want.kind === 'unavailable') {
    const e = thrown as
      | { name?: unknown; status?: unknown; kind?: unknown; retryable?: unknown; traceId?: unknown }
      | undefined;
    if (thrown === undefined) {
      failures.push(`want RetrievalUnavailableError thrown, got outcome ${JSON.stringify(outcome)}`);
      return failures;
    }
    if (e?.name !== 'RetrievalUnavailableError') {
      failures.push(`want RetrievalUnavailableError, got ${String(e?.name ?? thrown)}`);
      return failures;
    }
    if (e.status !== want.status) failures.push(`status: want ${want.status}, got ${String(e.status)}`);
    if (e.kind !== want.unavailableKind) failures.push(`kind: want ${want.unavailableKind}, got ${String(e.kind)}`);
    if (e.retryable !== want.retryable) failures.push(`retryable: want ${want.retryable}, got ${String(e.retryable)}`);
    if (want.traceId !== undefined && e.traceId !== want.traceId) {
      failures.push(`traceId: want ${want.traceId}, got ${String(e.traceId)}`);
    }
    return failures;
  }

  if (thrown !== undefined) {
    failures.push(`want ${want.kind} outcome, got thrown ${String((thrown as Error)?.name ?? thrown)}`);
    return failures;
  }
  if (outcome?.kind !== want.kind) failures.push(`kind: want ${want.kind}, got ${String(outcome?.kind)}`);
  if (want.kind === 'hits' && outcome?.kind === 'hits' && outcome.hits.length !== want.hitCount) {
    failures.push(`hits: want ${want.hitCount}, got ${outcome.hits.length}`);
  }
  if (want.kind === 'empty' && outcome?.kind === 'empty' && outcome.reason !== want.reason) {
    failures.push(`reason: want ${want.reason}, got ${outcome.reason}`);
  }
  if (want.traceId !== undefined && outcome?.traceId !== want.traceId) {
    failures.push(`traceId: want ${want.traceId}, got ${String(outcome?.traceId)}`);
  }
  return failures;
}
