// Real OpenRouter HTTP adapter — non-streaming + streaming.
//
// INVARIANT: this is the ONLY file in the tree that calls the chat-completions
// endpoint (`env.CHAT_COMPLETIONS_URL`, OpenRouter by default; tests point it
// at `test-support/fake-provider/`). Anything that needs an LLM call must
// route through here so the trace writer, budget enforcer, and cache layers
// stay in front of the network seam.
//
// Cost extraction:
//   - OpenRouter responds with `usage.cost` on most non-streaming calls when
//     `usage.include = true` is sent on the request body.
//   - When `usage.cost` is missing (streaming, certain models), we fall back
//     to the per-1K pricing table in `../task-profiles.ts`.

import { env } from '../../../../config/env.js';
import { minimiseEgress } from '../../pii-egress.js';
import type { ChatMessage } from '../types.js';
import { priceForUsage } from '../task-profiles.js';

/**
 * Inactivity/stall backstop for the streaming read loop. A provider that stops
 * sending frames mid-stream (but holds the socket open) is the realistic hang
 * the total wall-clock cap is too coarse to catch quickly. We arm a per-read
 * timer; if no frame arrives within `LLM_STREAM_STALL_TIMEOUT_MS`, we abort an
 * internal controller chained (via `AbortSignal.any`) onto the caller's signal,
 * which unblocks `reader.read()`. `streamingCallOpenRouter` wraps it in
 * `OpenRouterAbortError` with the `TimeoutError` DOMException as `cause`, and
 * the router ends the call as an UNBILLED `ProviderTimeout` (504) — a stall is
 * our timeout, not a disconnect (decision, see provider-timeout.ts).
 *
 * Read at call time (not module load) so tests can vary it per case and so a
 * config reload would take effect without a restart.
 */
function stallTimeoutMs(): number {
  return env.LLM_STREAM_STALL_TIMEOUT_MS;
}

// Config-driven like `EMBEDDINGS_URL`. Read once at module load from the
// validated env; defaults to OpenRouter.
const OPENROUTER_URL = env.CHAT_COMPLETIONS_URL;

export interface OpenRouterCallOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Falls back to `env.OPENROUTER_API_KEY` when omitted. */
  apiKey?: string;
  signal?: AbortSignal;
  /** OpenRouter-specific: allow listing fallback models. */
  models?: string[];
  /** Set to false to suppress `usage.include`; default is true. */
  includeUsage?: boolean;
  /**
   * Optional `response_format`: JSON mode (`json_object`) or strict
   * schema-constrained output (`json_schema` with `strict: true`).
   */
  responseFormat?: OpenRouterResponseFormat;
  /**
   * Optional per-token callback. Fired by `streamingCallOpenRouter` for each
   * `delta` chunk as it arrives, so a streaming HTTP route can forward tokens
   * to the browser. `callOpenRouter` (non-streaming) ignores it. Absent ⇒ no
   * overhead and identical behaviour to before.
   */
  onDelta?: (text: string) => void;
}

/**
 * The `response_format` values ai-service sends. `json_schema` is always
 * `strict: true`: ai-service has no non-strict schema mode.
 */
export type OpenRouterResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; schema: unknown; strict: true };
    };

/**
 * Set `response_format` (and, for strict mode, the routing guard) on a body.
 *
 * 🔴 `provider.require_parameters: true` IS LOAD-BEARING FOR STRICT MODE.
 * OpenRouter decides structured-output support per ENDPOINT (upstream host),
 * and by default it routes to an endpoint that does not support a parameter
 * and DROPS the parameter — strict mode would silently become free text. With
 * the flag, OpenRouter routes only to endpoints that honour `response_format`,
 * and errors when there are none. (OpenRouter docs, Structured Outputs.)
 * JSON mode keeps its old wire: no `provider` block.
 */
function applyResponseFormat(
  body: Record<string, unknown>,
  responseFormat: OpenRouterResponseFormat | undefined,
): void {
  if (!responseFormat) return;
  body.response_format = responseFormat;
  if (responseFormat.type === 'json_schema') body.provider = { require_parameters: true };
}

export interface OpenRouterCompletion {
  contentText: string;
  finishReason: string | null;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    /** Whether the cost came from OpenRouter's `usage.cost` field. */
    costSource: 'openrouter' | 'pricing-table';
  };
  /**
   * OpenRouter's generation id (`gen-…`): the body's top-level `id`, the key
   * for `GET /api/v1/generation?id=` (OpenRouter's own record of the call,
   * cost included). Absent when the provider sent none. Set on BOTH adapters,
   * and on an aborted call's partial when any chunk arrived before the abort.
   */
  rawId?: string;
}

/**
 * Thrown by `streamingCallOpenRouter` when the call is aborted mid-stream.
 * Carries the partial completion built from whatever deltas arrived so the
 * router can persist accurate inputTokens/outputTokens/actualCostUsd on a
 * cancelled trace rather than recording $0.
 *
 * `name === 'AbortError'` so existing AbortError-handling paths still match.
 */
export class OpenRouterAbortError extends Error {
  public readonly partial: OpenRouterCompletion;
  constructor(partial: OpenRouterCompletion, cause?: unknown) {
    super('OpenRouter stream aborted');
    this.name = 'AbortError';
    this.partial = partial;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Char/4 heuristic: rough but standard for English-language prompts. */
function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.role.length + m.content.length + 4; // 4 ≈ role/content framing
  }
  return Math.max(1, Math.ceil(chars / 4));
}

interface OpenRouterApiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenRouter extension: USD cost. */
    cost?: number;
  };
  error?: { message?: string; code?: string | number };
}

/** Typed error thrown for non-OK HTTP / OpenRouter error envelopes. */
export class OpenRouterHttpError extends Error {
  public readonly status: number;
  public readonly code: string | number | undefined;
  public readonly bodySnippet: string;
  /**
   * `Retry-After`, in ms, when the provider sent one. Read here at the only
   * layer that still HAS the response headers — the router's retry ladder
   * (`router/resilience.ts`) needs it and gets an error object, not a
   * `Response`.
   *
   * Absent, zero, or in the past all collapse to `undefined`: a
   * `Retry-After: 0` is a proxy placeholder, and honouring it literally means
   * hammering a server that just said no with no backoff at all. Same rule as
   * `packages/ai-client/src/http.ts`.
   */
  public readonly retryAfterMs: number | undefined;
  constructor(opts: {
    status: number;
    code?: string | number;
    message: string;
    bodySnippet?: string;
    retryAfterMs?: number | undefined;
  }) {
    super(opts.message);
    this.name = 'OpenRouterHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * `Retry-After` off a `Response`, in ms. HTTP allows delta-seconds OR an
 * HTTP-date and both are seen behind proxies, so both are read. A date in the
 * past yields `undefined`, never a negative wait.
 */
export function retryAfterMsFromResponse(res: { headers?: { get?(name: string): string | null } }): number | undefined {
  const raw = res.headers?.get?.('retry-after')?.trim();
  if (!raw) return undefined;
  const asMs = (ms: number): number | undefined => (ms > 0 ? ms : undefined);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return asMs(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return asMs(at - Date.now());
}

function resolveApiKey(opts: OpenRouterCallOptions): string {
  const key = opts.apiKey ?? env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'OpenRouter API key missing: pass opts.apiKey or set OPENROUTER_API_KEY env var.',
    );
  }
  return key;
}

/**
 * OpenAI's `json_object` mode refuses a request (HTTP 400: "'messages' must
 * contain the word 'json' in some form") when no message says "json". The
 * caller's prompt does not have to — the built-in router prompt and the
 * consumer-registered ones say "objeto estructurado" — so in JSON mode the
 * adapter adds one leading system line when the word is missing.
 *
 * ⚠ It is an INSTRUCTION, and every model reads it, not only OpenAI's. It fires
 * on EVERY OpenRouter call that sets `responseSchema` and whose messages lack
 * the word: /v1/generate/sync and /stream, the async workers, and the
 * refine/sample passes, as well as /v1/route. A prompt that already says
 * "json" (most structured prompts do) is sent unchanged. Measured: /v1/route with
 * openai/gpt-4o-mini (deployed code, no hint) failed 14/14 with this 400. The
 * "14/14 correct with the hint" figure came from a REPLAY of the same rendered
 * prompt plus this line through /v1/generate/sync (script router-replay.mts),
 * not from this adapter on /v1/route; that check runs after deploy.
 */
export const JSON_MODE_HINT = 'Respond with a single valid JSON object.';

export function withJsonModeHint(
  messages: ChatMessage[],
  responseFormat: OpenRouterCallOptions['responseFormat'],
): ChatMessage[] {
  // JSON mode only: strict `json_schema` mode has no "say json" rule, and the
  // schema already constrains decoding, so no extra instruction is added.
  if (responseFormat?.type !== 'json_object') return messages;
  if (messages.some((m) => /json/i.test(m.content))) return messages;
  return [{ role: 'system', content: JSON_MODE_HINT }, ...messages];
}

function appHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': process.env.OPENROUTER_APP_URL ?? 'https://ecosistemas-de-conocimiento.local',
    'X-Title': 'edc ai-service Router',
  };
}

/**
 * Non-streaming call. Throws `OpenRouterHttpError` on non-OK HTTP / error envelope.
 */
export async function callOpenRouter(
  opts: OpenRouterCallOptions,
): Promise<OpenRouterCompletion> {
  const apiKey = resolveApiKey(opts);
  const body: Record<string, unknown> = {
    model: opts.model,
    // 🔴 EGRESS SEAM 1 of 3 (§9.4). `opts.messages` NEVER reaches `fetch`
    // directly; a refusal here aborts the call rather than shipping raw PII.
    // See `src/services/ai/pii-egress.ts`.
    messages: await minimiseEgress(withJsonModeHint(opts.messages, opts.responseFormat), opts.signal),
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.models && opts.models.length > 0) body.models = opts.models;
  applyResponseFormat(body, opts.responseFormat);
  if (opts.includeUsage !== false) {
    // OpenRouter spec: include cost when caller asks. Default-on for traces.
    body.usage = { include: true };
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: appHeaders(apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed: OpenRouterApiResponse;
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterApiResponse) : {};
  } catch {
    throw new OpenRouterHttpError({
      status: res.status,
      message: `OpenRouter returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
      retryAfterMs: retryAfterMsFromResponse(res),
    });
  }

  if (!res.ok || parsed.error) {
    const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
    const code = parsed?.error?.code;
    throw new OpenRouterHttpError({
      status: res.status,
      code,
      message: `OpenRouter error (${code ?? res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
      retryAfterMs: retryAfterMsFromResponse(res),
    });
  }

  const choice = parsed.choices?.[0];
  const contentText = choice?.message?.content?.toString() ?? '';
  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const completionTokens = parsed.usage?.completion_tokens ?? 0;
  const reportedCost = parsed.usage?.cost;
  const model = parsed.model ?? opts.model;

  let costUsd: number;
  let costSource: 'openrouter' | 'pricing-table';
  if (typeof reportedCost === 'number' && Number.isFinite(reportedCost)) {
    costUsd = reportedCost;
    costSource = 'openrouter';
  } else {
    costUsd = priceForUsage(model, promptTokens, completionTokens);
    costSource = 'pricing-table';
  }

  return {
    contentText,
    finishReason: choice?.finish_reason ?? null,
    model,
    usage: {
      promptTokens,
      completionTokens,
      costUsd,
      costSource,
    },
    rawId: parsed.id,
  };
}

/**
 * Streaming call. Yields token deltas + a final `done` event with usage.
 *
 * OpenRouter only emits `usage` on a stream when `usage.include = true` is set
 * in the request body — we always opt-in. Cost may still be missing for some
 * upstream providers, in which case we fall back to the price table.
 */
export type OpenRouterStreamEvent =
  | { type: 'delta'; text: string }
  /** Once, on the first chunk carrying a top-level `id`. See `rawId`. */
  | { type: 'meta'; generationId: string }
  | { type: 'done'; usage: OpenRouterCompletion['usage']; finishReason: string | null; model: string }
  /**
   * ⚠ `status` / `retryAfterMs` are OPTIONAL because this event is also
   * emitted for stream-body faults that have no HTTP status of their own. When
   * they ARE present the fault was a non-OK response, and
   * `streamingCallOpenRouter` upgrades it into a typed `OpenRouterHttpError`
   * so the router's retry ladder can see a 429/5xx for what it is. Before
   * this, a 502 on the STREAMING path (the default adapter!) surfaced as a
   * bare `Error` and was therefore never retryable.
   */
  | { type: 'error'; message: string; status?: number; retryAfterMs?: number | undefined };

export async function* callOpenRouterStream(
  opts: OpenRouterCallOptions,
): AsyncGenerator<OpenRouterStreamEvent> {
  const apiKey = resolveApiKey(opts);
  const body: Record<string, unknown> = {
    model: opts.model,
    // 🔴 EGRESS SEAM 2 of 3 (§9.4). The streaming path is the DEFAULT adapter,
    // so an unminimised body here would be the common case, not the edge one.
    messages: await minimiseEgress(withJsonModeHint(opts.messages, opts.responseFormat), opts.signal),
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    stream: true,
    usage: { include: true },
  };
  if (opts.models && opts.models.length > 0) body.models = opts.models;
  applyResponseFormat(body, opts.responseFormat);

  // Inactivity backstop: chain an internal controller onto the caller's signal
  // so a per-read stall timer can abort the fetch independently of (and on top
  // of) the caller's disconnect+wall-clock signal.
  const stallMs = stallTimeoutMs();
  const stallEnabled = Number.isFinite(stallMs) && stallMs > 0;
  const stallCtrl = new AbortController();
  const fetchSignal: AbortSignal | undefined = stallEnabled
    ? opts.signal
      ? AbortSignal.any([opts.signal, stallCtrl.signal])
      : stallCtrl.signal
    : opts.signal;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = (): void => {
    if (!stallEnabled) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallCtrl.abort(
        new DOMException(
          `OpenRouter stream stalled: no frame for ${stallMs}ms`,
          'TimeoutError',
        ),
      );
    }, stallMs);
    (stallTimer as { unref?: () => void }).unref?.();
  };
  const clearStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: appHeaders(apiKey),
    body: JSON.stringify(body),
    signal: fetchSignal,
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : '';
    yield {
      type: 'error',
      message: `OpenRouter stream error HTTP ${res.status}: ${text.slice(0, 200)}`,
      status: res.status,
      retryAfterMs: retryAfterMsFromResponse(res),
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let reportedCost: number | undefined;
  let model = opts.model;
  let finishReason: string | null = null;
  let generationId: string | undefined;

  try {
  armStallTimer();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    armStallTimer(); // saw a frame — reset the inactivity window
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are `data: …\n\n`.
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload) as OpenRouterApiResponse;
          if (generationId === undefined && typeof evt.id === 'string' && evt.id.length > 0) {
            generationId = evt.id;
            yield { type: 'meta', generationId };
          }
          if (evt.usage) {
            promptTokens = evt.usage.prompt_tokens ?? promptTokens;
            completionTokens = evt.usage.completion_tokens ?? completionTokens;
            if (typeof evt.usage.cost === 'number') reportedCost = evt.usage.cost;
          }
          if (evt.model) model = evt.model;
          const choice = evt.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          // In stream chunks, content lives at choices[0].delta.content (not message.content).
          const delta = (choice as unknown as { delta?: { content?: string } } | undefined)?.delta;
          if (delta?.content) yield { type: 'delta', text: delta.content };
        } catch {
          // TODO(M3.6): wire to fastify logger
          // skip malformed frame
        }
      }
    }
  }

  let costUsd: number;
  let costSource: 'openrouter' | 'pricing-table';
  if (typeof reportedCost === 'number') {
    costUsd = reportedCost;
    costSource = 'openrouter';
  } else {
    costUsd = priceForUsage(model, promptTokens, completionTokens);
    costSource = 'pricing-table';
  }
  yield {
    type: 'done',
    usage: { promptTokens, completionTokens, costUsd, costSource },
    finishReason,
    model,
  };
  } finally {
    clearStallTimer();
  }
}

/**
 * Streaming-backed adapter that conforms to the same Promise<OpenRouterCompletion>
 * shape as `callOpenRouter`. The router calls this; if the AbortSignal fires
 * before the `done` stream event arrives, this throws `OpenRouterAbortError`
 * carrying a partial `OpenRouterCompletion` built from accumulated deltas.
 *
 * Token counts on abort:
 *   - completionTokens = count of `delta` chunks received (OpenRouter usually
 *     emits one chunk per token; ±1–3% drift on packed-token providers).
 *   - promptTokens = char/4 of the joined messages when no usage frame arrived
 *     yet (the normal case mid-stream). If a usage frame did arrive, we use
 *     its `prompt_tokens` value.
 *   - costUsd via `priceForUsage` (pricing-table source).
 *
 * On non-abort errors (network, OpenRouter 5xx, stream-level `error` event),
 * propagates a plain Error — no partial.
 */
export async function streamingCallOpenRouter(
  opts: OpenRouterCallOptions,
): Promise<OpenRouterCompletion> {
  let contentText = '';
  let deltaCount = 0;
  // These three are set once from the stream's done event (or left at their
  // initial values on abort, when `buildPartial` falls back to estimates).
  const model = opts.model;
  const reportedPromptTokens = 0;
  const reportedCompletionTokens = 0;
  let reportedCost: number | undefined;
  let generationId: string | undefined;

  const buildPartial = (): OpenRouterCompletion => {
    const completionTokens = reportedCompletionTokens > 0 ? reportedCompletionTokens : deltaCount;
    const promptTokens =
      reportedPromptTokens > 0 ? reportedPromptTokens : estimatePromptTokens(opts.messages);
    const costUsd =
      typeof reportedCost === 'number'
        ? reportedCost
        : priceForUsage(model, promptTokens, completionTokens);
    const costSource: 'openrouter' | 'pricing-table' =
      typeof reportedCost === 'number' ? 'openrouter' : 'pricing-table';
    return {
      contentText,
      finishReason: 'aborted',
      model,
      usage: { promptTokens, completionTokens, costUsd, costSource },
      ...(generationId !== undefined ? { rawId: generationId } : {}),
    };
  };

  try {
    for await (const evt of callOpenRouterStream(opts)) {
      if (evt.type === 'delta') {
        contentText += evt.text;
        deltaCount++;
        opts.onDelta?.(evt.text);
      } else if (evt.type === 'meta') {
        generationId = evt.generationId;
      } else if (evt.type === 'done') {
        return {
          contentText,
          finishReason: evt.finishReason,
          model: evt.model,
          usage: evt.usage,
          ...(generationId !== undefined ? { rawId: generationId } : {}),
        };
      } else if (evt.type === 'error') {
        // Same MESSAGE as before — only the class is upgraded, so anything
        // asserting on the text keeps matching. A stream fault with no status
        // (malformed frame, truncated body) stays a plain `Error`.
        throw evt.status === undefined
          ? new Error(evt.message)
          : new OpenRouterHttpError({
              status: evt.status,
              message: evt.message,
              retryAfterMs: evt.retryAfterMs,
            });
      }
    }
    // Stream ended without a `done` event — treat as malformed response.
    throw new Error('OpenRouter stream ended without a done event');
  } catch (err) {
    // 🔴 `opts.signal?.aborted` IS LOAD-BEARING, not belt-and-braces. A caller
    // that aborts WITH A REASON — the cooperative shutdown passes the string
    // `SHUTDOWN_ABORT_REASON`, the wall-clock deadline a `TimeoutError` — makes
    // `fetch` and `reader.read()` reject with THAT reason, whose `name` is not
    // `'AbortError'`. Checking the name alone turned every such abort into a
    // plain failure: trace `failed`, partial spend unbilled. The removed
    // in-service stream mock always threw a named `AbortError`, which hid this
    // until the shutdown tests ran against a real HTTP provider.
    //
    // `TimeoutError` is the STALL backstop above: it aborts an INTERNAL
    // controller, so `opts.signal` never fires and real `fetch` rejects with
    // the DOMException reason, not an `AbortError`. Without this arm a stall
    // surfaced as a bare `TimeoutError` → 500, with no partial for the trace.
    // The router recognises the `cause` and ends the call as `ProviderTimeout`.
    const name = (err as Error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError' || opts.signal?.aborted) {
      throw new OpenRouterAbortError(buildPartial(), err);
    }
    throw err;
  }
}
