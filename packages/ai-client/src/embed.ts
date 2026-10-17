// Embed sub-API — direct pass-through onto the provider's embeddings endpoint.

import type { HttpClient } from './http.js';
import { RetrievalUnavailableError, toRetrievalOutcomeError } from './retrieval-outcome.js';
import type { EmbedRequest, EmbedResponse } from './types.js';

export class EmbedAPI {
  constructor(private readonly http: HttpClient) {}

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return this.http.json<EmbedResponse>({
      method: 'POST',
      path: '/v1/embed',
      body: req,
    });
  }

  /**
   * `embed` for a QUERY that feeds retrieval. A query embedding has no "empty"
   * state, so EVERY failure — a 404 included — throws
   * `RetrievalUnavailableError`, as does a 200 without one vector per input.
   * A caller cancel rethrows `RequestAbortedError` unchanged.
   */
  async embedQuery(req: EmbedRequest, opts: { signal?: AbortSignal } = {}): Promise<EmbedResponse> {
    let res: EmbedResponse;
    try {
      res = await this.http.json<EmbedResponse>({
        method: 'POST',
        path: '/v1/embed',
        body: req,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      const mapped = toRetrievalOutcomeError(err);
      if (mapped instanceof Error) throw mapped;
      // A typed 404 has no meaning for /v1/embed: still an outage.
      throw new RetrievalUnavailableError({
        status: 404,
        kind: 'not_found',
        retryable: false,
        cause: err,
      });
    }
    const expected = typeof req.input === 'string' ? 1 : req.input.length;
    if (!Array.isArray(res?.embeddings) || res.embeddings.length !== expected) {
      throw new RetrievalUnavailableError({
        status: 200,
        kind: 'invalid_response',
        retryable: false,
        message: `ai-service /v1/embed answered 200 with ${Array.isArray(res?.embeddings) ? res.embeddings.length : 'no'} vectors for ${expected} inputs`,
      });
    }
    return res;
  }
}
