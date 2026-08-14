// Streaming-aware mock adapter for e2e tests.
//
// MOCK_LLM=1 short-circuits the whole router; this one is different: it
// preserves the full router pipeline (budget, trace writer, validators, cache)
// and only swaps the LLM HTTP call for a fake that yields delta tokens on a
// controlled cadence and respects AbortSignal. That makes it usable as the
// "OpenRouter substitute" in the cancel-flow e2e test while still producing
// real-shaped trace + usage rows.
//
// Tuning via env (read at call time so a single process can vary per test):
//   MOCK_LLM_STREAM_TOTAL_TOKENS — total deltas to emit (default 50)
//   MOCK_LLM_STREAM_TOKENS_PER_SEC — emit rate (default 10)
//   MOCK_LLM_STREAM_FIRST_DELAY_MS — pre-roll before the first delta
//                                    (default 200; gives the test a safe
//                                    window to attach a "saw first chunk"
//                                    waiter without racing the abort)

import { OpenRouterAbortError, type OpenRouterCallOptions, type OpenRouterCompletion } from './openrouter.js';
import { priceForUsage } from '../task-profiles.js';

const TOKEN_POOL = [
  'hello', 'world', 'this', 'is', 'a', 'mock', 'streaming', 'response',
  'that', 'mimics', 'OpenRouter', 'token', 'cadence', 'so', 'tests', 'can',
  'observe', 'partial', 'output', 'before', 'cancelling',
];

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted') as Error & { name: string };
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const err = new Error('aborted') as Error & { name: string };
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Same Promise<OpenRouterCompletion> contract as `streamingCallOpenRouter`.
 * On AbortSignal fire, throws `OpenRouterAbortError` with the partial
 * completion built from the deltas emitted so far — drives the same
 * partial-cost accounting path in the router's catch block.
 */
export async function mockStreamingAdapter(
  opts: OpenRouterCallOptions,
): Promise<OpenRouterCompletion> {
  const totalTokens = envNumber('MOCK_LLM_STREAM_TOTAL_TOKENS', 50);
  const tokensPerSec = envNumber('MOCK_LLM_STREAM_TOKENS_PER_SEC', 10);
  const firstDelayMs = envNumber('MOCK_LLM_STREAM_FIRST_DELAY_MS', 200);
  const intervalMs = Math.max(1, Math.round(1000 / tokensPerSec));

  const model = opts.model || 'mock/model';
  let contentText = '';
  let deltaCount = 0;

  const buildPartial = (): OpenRouterCompletion => {
    const inputChars = opts.messages.reduce((sum, m) => sum + m.role.length + m.content.length + 4, 0);
    const promptTokens = Math.max(1, Math.ceil(inputChars / 4));
    const completionTokens = deltaCount;
    const costUsd = priceForUsage(model, promptTokens, completionTokens);
    return {
      contentText,
      finishReason: 'aborted',
      model,
      usage: {
        promptTokens,
        completionTokens,
        costUsd,
        costSource: 'pricing-table',
      },
    };
  };

  try {
    await sleep(firstDelayMs, opts.signal);
    for (let i = 0; i < totalTokens; i++) {
      const word = TOKEN_POOL[i % TOKEN_POOL.length] ?? 'tok';
      const chunk = (deltaCount === 0 ? '' : ' ') + word;
      contentText += chunk;
      deltaCount++;
      opts.onDelta?.(chunk);
      if (i < totalTokens - 1) {
        await sleep(intervalMs, opts.signal);
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new OpenRouterAbortError(buildPartial(), err);
    }
    throw err;
  }

  // Normal completion path — return the full completion with priced usage.
  const inputChars = opts.messages.reduce((sum, m) => sum + m.role.length + m.content.length + 4, 0);
  const promptTokens = Math.max(1, Math.ceil(inputChars / 4));
  const completionTokens = deltaCount;
  return {
    contentText,
    finishReason: 'stop',
    model,
    usage: {
      promptTokens,
      completionTokens,
      costUsd: priceForUsage(model, promptTokens, completionTokens),
      costSource: 'pricing-table',
    },
  };
}
