// `EmptyCompletion` — the provider answered 200 with no text.
//
// Measured on dev (2026-11-10, ai-service request logs plus `edc_ai.traces`,
// OpenRouter `deepseek/deepseek-chat-v3.1` with ZDR): 3 of 6 chat answers came
// back as a 200 with empty content, model `unknown` and 0 tokens. The router
// filed each one as a `completed` trace, cached it, and the consumer could not
// save it ("The following field is invalid: Content") — the user saw
// ANSWER_NOT_SAVED after 18–58 s, and a cache hit re-served one 0 ms later.
//
// An empty answer is therefore a PROVIDER ERROR, raised in ONE place for every
// adapter and every pass: `Router.callAdapter`, inside the retry ladder, so it
// is retried under the same bounded policy as a 5xx
// (`DEFAULT_MAX_RETRY_ATTEMPTS`, see `resilience.ts`) and never reaches the
// cache. The router does not use tools, so a completion with no text has
// nothing else to carry: empty or whitespace-only is the whole test.
//
// Wire shape, pinned in `src/errors/wire-golden.test.ts`:
//   /sync   502 `{ error: 'EmptyCompletion', code: 'ERR_EMPTY_COMPLETION',
//                  traceId?, message }`
//   /stream terminal frame `{ type: 'error', code: 'EmptyCompletion',
//                  errorCode: 'ERR_EMPTY_COMPLETION', traceId?, message }`

import { AiServiceError } from '../../../errors/base.js';
import type { OpenRouterCompletion } from './adapters/openrouter.js';

/** True when a completion carries no usable text. */
export function isEmptyCompletion(completion: Pick<OpenRouterCompletion, 'contentText'>): boolean {
  return (completion.contentText ?? '').trim() === '';
}

export class EmptyCompletion extends AiServiceError {
  readonly code = 'ERR_EMPTY_COMPLETION';
  /** The upstream answered, but with nothing: a bad gateway, not our fault. */
  readonly status = 502;
  /** Fastify's default error handler reads THIS one. */
  readonly statusCode = 502;
  /** The router already retried; a fresh request is still worth one more try. */
  override readonly retryable = true;
  /** Raised after the SSE reply is hijacked, so it must name itself in a frame. */
  override readonly midStream = true;
  /** The router trace id, so a consumer can quote it in a support ticket. */
  readonly traceId: string | undefined;
  /** The last empty completion: its model, usage and generation id go on the trace. */
  readonly completion: OpenRouterCompletion | undefined;

  constructor(opts: { traceId?: string; completion?: OpenRouterCompletion; cause?: unknown } = {}) {
    super('The LLM provider returned an empty answer.');
    this.name = 'EmptyCompletion';
    this.traceId = opts.traceId;
    this.completion = opts.completion;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  protected override bodyFields() {
    return { code: this.code, ...(this.traceId ? { traceId: this.traceId } : {}) };
  }

  /** Frame field names predate the taxonomy: frame `errorCode` ≡ body `code`. */
  override streamFields() {
    return { errorCode: this.code, ...(this.traceId ? { traceId: this.traceId } : {}) };
  }
}
