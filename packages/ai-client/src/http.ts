// Minimal fetch wrapper for @edc/ai-client.
//
// Responsibilities:
//   - inject `Authorization: Bearer <apiKey>` on every call
//   - apply a request timeout (AbortController) when `timeoutMs` is set
//   - parse JSON responses; non-2xx → throw a typed AIServiceError
//   - return the raw `Response` on streaming endpoints (SSE) so callers can
//     consume the body themselves
//
// Zero runtime deps. Uses the platform `fetch` (Node 18+ / browsers); a
// custom fetch can be injected via `AIClientOptions.fetch` for tests.

import { AIServiceError, errorFromResponse } from './errors.js';

export interface HttpDeps {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface JsonRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Extra headers (Authorization is set automatically). */
  headers?: Record<string, string>;
  /** Caller-supplied abort signal — composed with the timeout. */
  signal?: AbortSignal;
}

export class HttpClient {
  constructor(private readonly deps: HttpDeps) {}

  /**
   * Send a JSON request; expect a JSON response. Throws an AIServiceError
   * subclass on non-2xx.
   */
  async json<T>(opts: JsonRequestOptions): Promise<T> {
    const res = await this.raw(opts);
    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;
    if (!res.ok) {
      // ⚠ `res.headers` IS PART OF THE ERROR, not decoration. A 429's wait can
      // arrive ONLY in `Retry-After` — that is the whole contract when the
      // throttle sits in a proxy rather than in ai-service. This used to pass
      // the body alone, so no consumer could ever back off by the right amount.
      throw errorFromResponse(res.status, parsed, res.headers);
    }
    return parsed as T;
  }

  /**
   * Send a request and return the raw `Response`. Used for streaming
   * endpoints (SSE) where the consumer reads the body themselves. Caller
   * is responsible for closing the body.
   */
  async raw(opts: JsonRequestOptions): Promise<Response> {
    const url = `${stripTrailingSlash(this.deps.baseUrl)}${opts.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.apiKey}`,
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('ai-client request timed out')), this.deps.timeoutMs);
    // Compose: caller-provided signal also triggers our abort.
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true });
    }
    init.signal = ctrl.signal;

    try {
      return await this.deps.fetchImpl(url, init);
    } catch (err) {
      // Surface AbortError as a typed AIServiceError so callers don't have to
      // pattern-match DOMException across runtimes.
      if (isAbortLike(err)) {
        throw new AIServiceError('ai-client request aborted (timeout or cancel)', 0, {
          message: 'aborted',
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
