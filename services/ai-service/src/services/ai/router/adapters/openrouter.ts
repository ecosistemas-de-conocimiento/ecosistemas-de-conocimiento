// Real OpenRouter HTTP adapter — non-streaming + streaming.
//
// INVARIANT: this is the ONLY file in the tree that calls
// `fetch('https://openrouter.ai/...')`. Anything that needs an LLM call must
// route through here so the trace writer, budget enforcer, and cache layers
// stay in front of the network seam.
//
// Cost extraction:
//   - OpenRouter responds with `usage.cost` on most non-streaming calls when
//     `usage.include = true` is sent on the request body.
//   - When `usage.cost` is missing (streaming, certain models), we fall back
//     to the per-1K pricing table in `../task-profiles.ts`.
//
// Ported 1:1 from a prototype `services/ai/router/adapters/openrouter-adapter.ts`
// with path-only edits (relative imports + `.js` extensions, env via the
// validated config).

import { env } from '../../../../config/env.js';
import type { ChatMessage } from '../types.js';
import { priceForUsage } from '../task-profiles.js';

/**
 * Inactivity/stall backstop for the streaming read loop. A provider that stops
 * sending frames mid-stream (but holds the socket open) is the realistic hang
 * the total wall-clock cap is too coarse to catch quickly. We arm a per-read
 * timer; if no frame arrives within `LLM_STREAM_STALL_TIMEOUT_MS`, we abort an
 * internal controller chained (via `AbortSignal.any`) onto the caller's signal,
 * which unblocks `reader.read()` with an AbortError. The router then bills the
 * partial like any other abort. The `TimeoutError` DOMException name lets the
 * upstream cause-detection still classify it as a timeout (not a disconnect).
 *
 * Read at call time (not module load) so tests can vary it per case and so a
 * config reload would take effect without a restart.
 */
function stallTimeoutMs(): number {
  return env.LLM_STREAM_STALL_TIMEOUT_MS;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  /** Optional response_format for JSON mode. */
  responseFormat?: { type: 'json_object' };
  /**
   * Optional per-token callback. Fired by `streamingCallOpenRouter` for each
   * `delta` chunk as it arrives, so a streaming HTTP route can forward tokens
   * to the browser. `callOpenRouter` (non-streaming) ignores it. Absent ⇒ no
   * overhead and identical behaviour to before.
   */
  onDelta?: (text: string) => void;
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
  constructor(opts: { status: number; code?: string | number; message: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = 'OpenRouterHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
  }
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
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.models && opts.models.length > 0) body.models = opts.models;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
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
  | { type: 'done'; usage: OpenRouterCompletion['usage']; finishReason: string | null; model: string }
  | { type: 'error'; message: string };

export async function* callOpenRouterStream(
  opts: OpenRouterCallOptions,
): AsyncGenerator<OpenRouterStreamEvent> {
  const apiKey = resolveApiKey(opts);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    stream: true,
    usage: { include: true },
  };
  if (opts.models && opts.models.length > 0) body.models = opts.models;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

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
    yield { type: 'error', message: `OpenRouter stream error HTTP ${res.status}: ${text.slice(0, 200)}` };
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
    };
  };

  try {
    for await (const evt of callOpenRouterStream(opts)) {
      if (evt.type === 'delta') {
        contentText += evt.text;
        deltaCount++;
        opts.onDelta?.(evt.text);
      } else if (evt.type === 'done') {
        return {
          contentText,
          finishReason: evt.finishReason,
          model: evt.model,
          usage: evt.usage,
        };
      } else if (evt.type === 'error') {
        throw new Error(evt.message);
      }
    }
    // Stream ended without a `done` event — treat as malformed response.
    throw new Error('OpenRouter stream ended without a done event');
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new OpenRouterAbortError(buildPartial(), err);
    }
    throw err;
  }
}
