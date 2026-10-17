// Generate sub-API — async batch + sync single-call + state lookups.
//
// Mirrors `src/routes/generate.ts`. The async path returns the orchestrator's
// `LaunchGenerationResult` handle (requestId + channel + totalJobs + cost),
// which the caller can then subscribe to via `client.events(channel)` for
// progress, or poll `client.generate.get(requestId)` for a snapshot.

import { openGenerateStream, openRawGenerateStream } from './stream.js';
import type { GenerateStream, GenerateStreamOptions } from './stream.js';
import type { HttpClient } from './http.js';
import type {
  CancelResult,
  GenerateRequest,
  GenerateSyncRequest,
  GenerationJobState,
  GenerationRequestState,
  LaunchGenerationResult,
  SyncResult,
} from './types.js';

export interface GenerateSyncOptions {
  /** Caller cancel. */
  signal?: AbortSignal;
  /** Per-call deadline in ms; overrides the client's `timeoutMs`. */
  timeoutMs?: number;
}

export class GenerateAPI {
  constructor(private readonly http: HttpClient) {}

  async enqueue(req: GenerateRequest): Promise<LaunchGenerationResult> {
    return this.http.json<LaunchGenerationResult>({
      method: 'POST',
      path: '/v1/generate',
      body: req,
    });
  }

  /**
   * One generation, answered in the response body. Never retried (no
   * server-side dedupe on this route).
   *
   * `opts.timeoutMs` overrides the client's `timeoutMs` for this call only;
   * `opts.signal` cancels it. Size the timeout for the slowest model you
   * route to: an abort mid-generation is still billed for the tokens the
   * provider produced.
   */
  async sync(req: GenerateSyncRequest, opts?: GenerateSyncOptions): Promise<SyncResult> {
    return this.http.json<SyncResult>({
      method: 'POST',
      path: '/v1/generate/sync',
      body: req,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /**
   * Token-stream a single unit over SSE (`POST /v1/generate/stream`).
   *
   * Resolves once the response HEADERS are in, so every pre-stream failure
   * (400, 402 budget, 429, 401) throws from this `await` as the usual typed
   * class. Then iterate:
   *
   * ```ts
   * const s = await client.generate.stream({ unit });
   * const done = await s.collect((text) => reply(text));
   * // or: for await (const frame of s) { ... }
   * ```
   *
   * Post-header failures arrive as terminal `error` frames and are thrown as
   * the same typed classes (`BudgetExceededError`, `BudgetNotConfiguredError`,
   * `BudgetMisconfiguredError`, `SpecResolutionError`, …), so one `catch`
   * covers both halves of the call.
   *
   * 🔴 NEVER retried, at any stage, whatever retry policy the client carries:
   * `/stream` cannot dedupe a resend, so a retry is a second generation and a
   * second budget debit. See `stream.ts`.
   */
  async stream(
    req: GenerateSyncRequest,
    opts?: GenerateStreamOptions,
  ): Promise<GenerateStream> {
    return openGenerateStream(this.http, req, opts);
  }

  /**
   * The same request, handing back the raw `Response` with the SSE body
   * unread — for a consumer that re-streams frames onward rather than
   * consuming them (chat's SvelteKit route proxies the stream to a browser,
   * forwarding heartbeat comments verbatim and rewriting the `done` frame
   * before it goes out).
   *
   * You still get the typed pre-stream errors and the bearer/timeout/abort
   * plumbing; you own parsing and closing the body. Prefer {@link stream} when
   * you are the one who consumes the tokens.
   */
  async streamRaw(req: GenerateSyncRequest, opts?: GenerateStreamOptions): Promise<Response> {
    return openRawGenerateStream(this.http, req, opts);
  }

  async get(requestId: string): Promise<GenerationRequestState> {
    return this.http.json<GenerationRequestState>({
      method: 'GET',
      path: `/v1/generate/${encodeURIComponent(requestId)}`,
    });
  }

  async getUnitLatest(unitKey: string): Promise<GenerationJobState> {
    const res = await this.http.json<{ unit: GenerationJobState }>({
      method: 'GET',
      path: `/v1/generate/units/${encodeURIComponent(unitKey)}/latest`,
    });
    return res.unit;
  }

  async cancel(requestId: string): Promise<CancelResult> {
    return this.http.json<CancelResult>({
      method: 'POST',
      path: `/v1/generate/${encodeURIComponent(requestId)}/cancel`,
    });
  }
}
