// SvelteKit server-only ai-service client. Lives under `$lib/server/` so the
// SvelteKit build refuses to bundle it into any client-reachable module — the
// bearer is private by construction. Mirrors the ai-service consumer contract
// (v0.3) and the Zod gates in `services/ai-service/src/schemas/generate.ts`.

import { env } from '$env/dynamic/private';
import {
  AIServiceError,
  AIServiceUnavailableError,
  BadRequestError,
  BudgetExceededError,
  BudgetNotConfiguredError,
  CrossOrgError,
  DependencyError,
  IdempotencyConflictError,
  NotFoundError,
  NotImplementedError,
  OutputValidationError,
  SpecResolutionError,
  UnauthorizedError,
} from './errors';
import {
  appEventSchema,
  budgetResponseSchema,
  cancelResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  generateSyncRequestSchema,
  generateSyncResponseSchema,
  generationRequestSnapshotSchema,
  latestUnitResponseSchema,
  pingResponseSchema,
  retrieveRequestSchema,
  retrieveResponseSchema,
  type AppEvent,
  type BudgetResponse,
  type CancelResponse,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateSyncRequest,
  type GenerateSyncResponse,
  type GenerationRequestSnapshot,
  type PingResponse,
  type RetrieveRequest,
  type RetrieveResponse,
  type UnitSnapshot,
} from './schemas';
import type { ZodSchema } from 'zod';

export interface AIServiceClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class AIServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AIServiceClientOptions) {
    if (!opts.baseUrl) throw new Error('AIServiceClient: baseUrl is required');
    if (!opts.apiKey) throw new Error('AIServiceClient: apiKey is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async ping(): Promise<PingResponse> {
    return this.requestJson('GET', '/v1/', undefined, pingResponseSchema);
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const body = generateRequestSchema.parse(req);
    return this.requestJson('POST', '/v1/generate', body, generateResponseSchema);
  }

  async generateSync(
    req: GenerateSyncRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerateSyncResponse> {
    const body = generateSyncRequestSchema.parse(req);
    const res = await this.requestJson(
      'POST',
      '/v1/generate/sync',
      body,
      generateSyncResponseSchema,
      opts,
    );
    assertSystemPromptApplied(body.unit.systemPrompt, res.systemPromptApplied);
    return res;
  }

  /**
   * Open the SSE stream for a single-unit generation. Same request body as
   * `generateSync`, but the upstream responds `text/event-stream` with
   * `delta` / `done` / `error` frames. Returns the raw upstream Response so a
   * SvelteKit endpoint can transform-and-pipe `.body` to the browser (e.g. to
   * intercept the `done` frame and persist the message). Throws
   * AIServiceError on a non-2xx open (validation / spec-resolution failures
   * surface here, before any byte is streamed).
   */
  async openGenerateStream(
    req: GenerateSyncRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Response> {
    const body = generateSyncRequestSchema.parse(req);
    const res = await this.fetchImpl(this.url('/v1/generate/stream'), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).catch((err: unknown) => {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new AIServiceUnavailableError(`ai-service unreachable: ${(err as Error).message}`, {
        cause: err,
      });
    });
    if (!res.ok) throw await this.errorFromResponse(res);
    if (!res.body)
      throw new AIServiceError('ai-service returned no SSE body', { status: res.status });
    return res;
  }

  async getRequest(requestId: string): Promise<GenerationRequestSnapshot> {
    return this.requestJson(
      'GET',
      `/v1/generate/${encodeURIComponent(requestId)}`,
      undefined,
      generationRequestSnapshotSchema,
    );
  }

  async cancelRequest(requestId: string): Promise<CancelResponse> {
    return this.requestJson(
      'POST',
      `/v1/generate/${encodeURIComponent(requestId)}/cancel`,
      undefined,
      cancelResponseSchema,
    );
  }

  async getLatestUnit(unitKey: string): Promise<UnitSnapshot> {
    const { unit } = await this.requestJson(
      'GET',
      `/v1/generate/units/${encodeURIComponent(unitKey)}/latest`,
      undefined,
      latestUnitResponseSchema,
    );
    return unit;
  }

  async retrieve(req: RetrieveRequest): Promise<RetrieveResponse> {
    const body = retrieveRequestSchema.parse(req);
    return this.requestJson('POST', '/v1/retrieve', body, retrieveResponseSchema);
  }

  async getBudget(org: string): Promise<BudgetResponse> {
    return this.requestJson(
      'GET',
      `/v1/budget/${encodeURIComponent(org)}`,
      undefined,
      budgetResponseSchema,
    );
  }

  /**
   * Open the raw SSE upstream for `channel`. Returns the upstream Response so
   * a SvelteKit endpoint can pipe `.body` straight to the browser — heartbeats
   * included. Throws AIServiceError on non-2xx open.
   */
  async openEventStream(channel: string, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    const res = await this.fetchImpl(this.url(`/v1/events/${encodeURIComponent(channel)}`), {
      method: 'GET',
      headers: { ...this.authHeaders(), accept: 'text/event-stream' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).catch((err: unknown) => {
      throw new AIServiceUnavailableError(
        `ai-service unreachable: ${(err as Error).message}`,
        { cause: err },
      );
    });
    if (!res.ok) throw await this.errorFromResponse(res);
    if (!res.body) throw new AIServiceError('ai-service returned no SSE body', { status: res.status });
    return res;
  }

  /**
   * Async iterator over typed SSE events. Convenience wrapper around
   * `openEventStream` for in-process consumers. Heartbeat / comment lines
   * (`: …`) are skipped; malformed `data:` frames are dropped.
   */
  async *events(channel: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<AppEvent> {
    const res = await this.openEventStream(channel, opts);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''));
        if (dataLines.length === 0) continue;
        try {
          const obj = JSON.parse(dataLines.join('\n'));
          yield appEventSchema.parse(obj);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: ZodSchema<T>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        ...this.authHeaders(),
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), init);
    } catch (err) {
      // Caller-initiated abort: propagate so the BFF can map it to a 499
      // and not wrap it in AIServiceUnavailableError.
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new AIServiceUnavailableError(
        `ai-service unreachable at ${path}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      // Mid-body abort (or stream error). Let AbortError propagate; surface
      // anything else as service-unavailable.
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new AIServiceUnavailableError(
        `ai-service mid-stream error at ${path}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!res.ok) throw mapErrorResponse(res.status, parsed, path);

    return schema.parse(parsed);
  }

  private async errorFromResponse(res: Response): Promise<AIServiceError> {
    const raw = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return mapErrorResponse(res.status, parsed, res.url);
  }
}

// ── system-prompt arrival guard ────────────────────────────────────────────

/**
 * Fail LOUDLY when we asked for a system prompt and it did not reach the model.
 *
 * This is the whole point of migrating off the old system-role fold. Two
 * failure modes it catches, both otherwise silent:
 *
 *   - we are pointed at an ai-service that predates system-prompt support →
 *     `systemPromptApplied` is `undefined` → throws;
 *   - a later refactor drops `unit.systemPrompt` on the way out → the field
 *     comes back `false` → throws.
 *
 * The test is `!== true`, deliberately: treating a MISSING field as success is
 * exactly the silent-instruction-loss this guard exists to prevent.
 */
export function assertSystemPromptApplied(
  requestedSystemPrompt: string | undefined,
  applied: boolean | undefined,
): void {
  if (!requestedSystemPrompt) return;
  if (applied === true) return;
  throw new AIServiceError(
    'ai-service did not apply the system prompt chat sent ' +
      `(systemPromptApplied=${String(applied)}). Either the target deployment ` +
      'predates system-prompt support, or the request builder dropped ' +
      '`unit.systemPrompt`. Refusing to answer without chat’s instructions.',
    { status: 500 },
  );
}

// ── error mapping ──────────────────────────────────────────────────────────

/**
 * Map an HTTP error response to a typed error.
 *
 * Priority:
 *   1. `body.error` discriminator (matches the strings ai-service emits).
 *   2. HTTP status code.
 *
 * 404 / 5xx with no parseable JSON body collapses to
 * `AIServiceUnavailableError` — typical for "endpoint not deployed yet" (M3 not
 * ported) vs. a real "not found" with a JSON `{error, message}`.
 */
function mapErrorResponse(status: number, body: unknown, path: string): AIServiceError {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const tag = obj && typeof obj.error === 'string' ? obj.error : undefined;
  const message =
    obj && typeof obj.message === 'string'
      ? obj.message
      : `ai-service ${status} at ${path}`;

  switch (tag) {
    // ai-service returns 402 for BOTH budget failures, so the bare-402 fallback
    // below cannot tell them apart — only this tag can. Without this case a
    // "no budget row exists" fault is mislabelled as ordinary overspend, and
    // the operator goes looking for a cap to raise that was never there.
    case 'BudgetNotConfigured':
      return new BudgetNotConfiguredError(message, {
        status,
        bodyError: tag,
        body,
        org: typeof obj?.org === 'string' ? obj.org : undefined,
      });
    case 'BudgetExceeded':
      return new BudgetExceededError(message, {
        status,
        bodyError: tag,
        body,
        org: typeof obj?.org === 'string' ? obj.org : undefined,
        requested: typeof obj?.requested === 'number' ? obj.requested : undefined,
        remaining: typeof obj?.remaining === 'number' ? obj.remaining : undefined,
        shortfallUsd: typeof obj?.shortfallUsd === 'number' ? obj.shortfallUsd : undefined,
      });
    case 'IdempotencyConflict':
      return new IdempotencyConflictError(message, {
        status,
        bodyError: tag,
        body,
        existingRequestId:
          typeof obj?.existingRequestId === 'string' ? obj.existingRequestId : undefined,
      });
    case 'SpecResolutionError':
      return new SpecResolutionError(message, {
        status,
        bodyError: tag,
        body,
        cause: typeof obj?.cause === 'string' ? obj.cause : undefined,
      });
    case 'DependencyCycleError':
      return new DependencyError(message, {
        status,
        bodyError: tag,
        body,
        cycle: Array.isArray(obj?.cycle) ? (obj.cycle as string[]) : undefined,
      });
    case 'CrossBatchDependencyError':
      return new DependencyError(message, {
        status,
        bodyError: tag,
        body,
        missing: Array.isArray(obj?.missing) ? (obj.missing as string[]) : undefined,
      });
    case 'OutputValidationError':
      return new OutputValidationError(message, {
        status,
        bodyError: tag,
        body,
        flags: obj?.flags,
      });
    case 'CrossOrgError':
      return new CrossOrgError(message, { status, bodyError: tag, body });
    case 'NotImplementedError':
      return new NotImplementedError(message, { status, bodyError: tag, body });
  }

  // Fall back to status code.
  if (status === 400) return new BadRequestError(message, { status, body });
  if (status === 401) return new UnauthorizedError(message, { status, body });
  if (status === 402) return new BudgetExceededError(message, { status, body });
  if (status === 403) return new CrossOrgError(message, { status, body });
  if (status === 404) {
    // Fastify's stock "no such route" 404 carries `message: 'Route METHOD:/path not found'`.
    // Treat that (and bodyless 404s) as service-unavailable rather than a
    // domain-level "not found", so the chat UI degrades gracefully while M3
    // routes are still being ported.
    const isRouteMissing = !obj || /^Route\s.+\snot found$/.test(message);
    if (isRouteMissing) {
      return new AIServiceUnavailableError(
        `ai-service endpoint ${path} not available (404 ${obj ? 'route not found' : 'no body'})`,
        { status, body },
      );
    }
    return new NotFoundError(message, { status, body });
  }
  if (status === 409) return new IdempotencyConflictError(message, { status, body });
  if (status === 422) return new OutputValidationError(message, { status, body });
  if (status === 501) return new NotImplementedError(message, { status, body });
  if (status >= 500 && status <= 599) {
    return new AIServiceUnavailableError(message, { status, body });
  }
  return new AIServiceError(message, { status, body });
}

// ── factory ────────────────────────────────────────────────────────────────

let cached: AIServiceClient | null = null;

/**
 * Lazily construct the singleton client from `$env/dynamic/private`. Throws a
 * clear error if either var is unset — the BFF surfaces that as a 500 with a
 * "Server misconfigured" message. There is no fallback URL on purpose: chat
 * itself listens on :3000, so silently falling back to `http://localhost:3000`
 * would loop the chat server back to itself.
 */
export function getAIClient(): AIServiceClient {
  if (cached) return cached;
  const baseUrl = env.AI_SERVICE_URL;
  const apiKey = env.AI_SERVICE_API_KEY;
  if (!baseUrl) throw new Error('AI_SERVICE_URL is not set on the server.');
  if (!apiKey) throw new Error('AI_SERVICE_API_KEY is not set on the server.');
  cached = new AIServiceClient({ baseUrl, apiKey });
  return cached;
}
