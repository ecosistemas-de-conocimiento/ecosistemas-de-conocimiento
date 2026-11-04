// Retrieve sub-API.

import { errorFromResponse } from './errors.js';
import type { HttpClient, JsonRequestOptions } from './http.js';
import {
  RetrievalUnavailableError,
  toRetrievalOutcomeError,
  type EmptyRetrievalReason,
  type RetrievalOutcome,
} from './retrieval-outcome.js';
import type {
  MultiRetrievedChunk,
  RetrieveMultiRequest,
  RetrieveMultiResult,
  RetrieveRequest,
  RetrieveResult,
  RetrievedChunk,
} from './types.js';

/** Per-call options for the `*Outcome` methods. */
export interface RetrieveCallOptions {
  signal?: AbortSignal;
}

export class RetrieveAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Raw call: throws the typed `AIServiceError` subclass on any non-2xx,
   * `CorpusNotFoundError` included. Prefer {@link retrieveOutcome}, which
   * separates "no documents" from "retrieval is down".
   */
  async retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
    return this.http.json<RetrieveResult>({
      method: 'POST',
      path: '/v1/retrieve',
      body: req,
    });
  }

  /**
   * Fan out retrieval across several corpora and fuse the results by score,
   * optionally rewriting an anaphoric follow-up into a standalone query first.
   * All corpora resolve under this token's own `(org, project)`. A missing or
   * erroring corpus is reported in `result.corpora`, never thrown.
   * Prefer {@link retrieveMultiOutcome}, which reads those diagnostics for you.
   */
  async retrieveMulti(req: RetrieveMultiRequest): Promise<RetrieveMultiResult> {
    return this.http.json<RetrieveMultiResult>({
      method: 'POST',
      path: '/v1/retrieve/multi',
      body: req,
    });
  }

  /**
   * `retrieve` with the shared outcome rule (`./retrieval-outcome.ts`):
   * `hits`, or `empty` (`corpus_not_found` / `document_not_found` /
   * `no_match`), or a thrown `RetrievalUnavailableError` for every other
   * failure. A caller cancel rethrows `RequestAbortedError` unchanged.
   */
  async retrieveOutcome(
    req: RetrieveRequest,
    opts: RetrieveCallOptions = {},
  ): Promise<RetrievalOutcome<RetrievedChunk, RetrieveResult>> {
    const got = await this.call<RetrieveResult>('/v1/retrieve', req, opts);
    if ('empty' in got) return got.empty;
    const { body, traceId } = got;
    if (!body || !Array.isArray(body.chunks)) throw invalidResponse(traceId);
    return body.chunks.length > 0
      ? { kind: 'hits', hits: body.chunks, result: body, ...trace(traceId) }
      : { kind: 'empty', reason: 'no_match', result: body, ...trace(traceId) };
  }

  /**
   * `retrieveMulti` with the outcome rule. The server answers 200 even when a
   * corpus errored, so the per-corpus diagnostics decide:
   *   - any corpus `failed` → throws `RetrievalUnavailableError`
   *     (`kind: 'corpus_failed'`, `failedCorpora`), EVEN IF other corpora hit.
   *     A missing slice of the evidence is how "no requirement matches"
   *     happened; partial grounding is not reported as grounding.
   *   - chunks present → `hits`
   *   - every corpus `not_found` → `empty` / `corpus_not_found`
   *   - otherwise → `empty` / `no_match`
   */
  async retrieveMultiOutcome(
    req: RetrieveMultiRequest,
    opts: RetrieveCallOptions = {},
  ): Promise<RetrievalOutcome<MultiRetrievedChunk, RetrieveMultiResult>> {
    const got = await this.call<RetrieveMultiResult>('/v1/retrieve/multi', req, opts);
    if ('empty' in got) return got.empty;
    const { body, traceId } = got;
    if (!body || !Array.isArray(body.chunks) || !Array.isArray(body.corpora)) {
      throw invalidResponse(traceId);
    }
    const failed = body.corpora.filter((c) => c.error === 'failed').map((c) => c.corpus);
    if (failed.length > 0) {
      throw new RetrievalUnavailableError({
        status: 200,
        kind: 'corpus_failed',
        retryable: true,
        traceId,
        failedCorpora: failed,
        message: `ai-service retrieval failed for corpora: ${failed.join(', ')}`,
      });
    }
    if (body.chunks.length > 0) {
      return { kind: 'hits', hits: body.chunks, result: body, ...trace(traceId) };
    }
    const allMissing = body.corpora.length > 0 && body.corpora.every((c) => c.error === 'not_found');
    return {
      kind: 'empty',
      reason: allMissing ? 'corpus_not_found' : 'no_match',
      result: body,
      ...trace(traceId),
    };
  }

  /**
   * One POST that keeps the response's `x-request-id` on both paths, then
   * applies the outcome rule to any failure: a typed 404 comes back as
   * `{ empty }`, everything else throws.
   */
  private async call<T>(
    path: string,
    body: unknown,
    opts: RetrieveCallOptions,
  ): Promise<
    | { body: T; traceId: string | undefined }
    | { empty: { kind: 'empty'; reason: EmptyRetrievalReason; traceId?: string } }
  > {
    const request: JsonRequestOptions = { method: 'POST', path, body };
    if (opts.signal) request.signal = opts.signal;
    let traceId: string | undefined;
    try {
      const res = await this.http.raw(request);
      traceId = res.headers.get('x-request-id') ?? undefined;
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        if (res.ok) throw invalidResponse(traceId);
        parsed = { message: text };
      }
      if (!res.ok) throw errorFromResponse(res.status, parsed, res.headers);
      return { body: parsed as T, traceId };
    } catch (err) {
      const mapped = toRetrievalOutcomeError(err, traceId);
      if (mapped instanceof Error) throw mapped;
      return { empty: { kind: 'empty', reason: mapped.reason, ...trace(traceId) } };
    }
  }
}

function trace(traceId: string | undefined): { traceId?: string } {
  return traceId !== undefined ? { traceId } : {};
}

function invalidResponse(traceId: string | undefined): RetrievalUnavailableError {
  return new RetrievalUnavailableError({
    status: 200,
    kind: 'invalid_response',
    retryable: false,
    traceId,
    message: 'ai-service retrieval answered 200 with a body that is not a retrieval result',
  });
}
