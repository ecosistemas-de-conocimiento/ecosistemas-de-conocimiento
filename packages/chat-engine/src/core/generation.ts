/**
 * Empty-generation predicates (0.6.0) and the typed empty-answer error (0.9.0).
 *
 * ai-service can answer 200 with `text: ''`. That never throws, so a caller's
 * error path never sees it, and a blank bubble ships. These two predicates are
 * the shared rule.
 *
 * Chat itself does NOT retry (decision D3): it fails fast on an empty answer.
 * `shouldRetryEmpty` exists for a product that retries once.
 */

/** No visible text: missing, empty, or whitespace only. */
export function isEmptyGeneration(text: string | null | undefined): boolean {
  return !text || !text.trim();
}

/**
 * Whether ONE retry of an empty generation can help. `false` for `'length'`:
 * the output cap was spent before any visible text (a reasoning model burning
 * it on hidden reasoning), which is deterministic — a retry doubles the wait
 * to reach the same empty string. Any other reason, or none (a cache hit or an
 * older ai-service), is treated as transient: `true`.
 */
export function shouldRetryEmpty(finishReason: string | null | undefined): boolean {
  return finishReason !== 'length';
}

/**
 * The typed code for "the model answered, but with no visible text". ADDITIVE
 * (0.9.0). One code for every way that arrives: a 200 with empty text, a
 * stream whose `done` carries none, or ai-service's own empty-completion error.
 */
export const EMPTY_ANSWER_CODE = 'empty_answer';

/**
 * The typed code for "the model spent the output cap before writing anything"
 * (0.10.0): an empty answer with `finishReason: 'length'`, or ai-service's
 * `CompletionTruncated`. Separate from `empty_answer` because asking again
 * hits the same cap (see `shouldRetryEmpty`), so a UI must not offer a retry.
 */
export const ANSWER_TRUNCATED_CODE = 'answer_truncated';

/** Thrown by `respond()` (and `assertAnswer`) for an empty final answer. */
export class EmptyAnswerError extends Error {
  readonly code = EMPTY_ANSWER_CODE;
  /** The provider's stop reason, when it gave one. */
  readonly finishReason: string | undefined;
  constructor(finishReason?: string | null) {
    super('The model returned an empty answer.');
    this.name = 'EmptyAnswerError';
    this.finishReason = finishReason ?? undefined;
  }
}

/** Thrown by `assertAnswer` for an empty answer that stopped at the output cap. */
export class AnswerTruncatedError extends Error {
  readonly code = ANSWER_TRUNCATED_CODE;
  constructor() {
    super('The model hit the output limit before writing an answer.');
    this.name = 'AnswerTruncatedError';
  }
}

/** Upstream codes folded to letters only, `ERR_` dropped: `ERR_EMPTY_COMPLETION` → `emptycompletion`. */
function codeKey(code: string): string {
  return code.replace(/^ERR_/i, '').replace(/[^a-z]/gi, '').toLowerCase();
}

/**
 * Whether an upstream error code means an empty completion. Matched by shape,
 * not one exact string: ai-service names a class in up to three spellings
 * (`EmptyCompletion` on a stream frame, `ERR_EMPTY_COMPLETION` as the taxonomy
 * code, `EMPTY_COMPLETION` nested), and this must work before it sends any.
 */
export function isEmptyAnswerCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const key = codeKey(code);
  return key === 'emptycompletion' || key === 'emptyanswer' || key === 'emptyresponse';
}

/**
 * Whether an upstream error code means an empty completion at the output cap:
 * `CompletionTruncated` / `ERR_COMPLETION_TRUNCATED` / `answer_truncated`.
 */
export function isTruncatedAnswerCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const key = codeKey(code);
  return key === 'completiontruncated' || key === 'answertruncated';
}

/**
 * The generation unchanged, or an error when it has no visible text:
 * `AnswerTruncatedError` when it stopped at the output cap, else `EmptyAnswerError`.
 */
export function assertAnswer<T extends { text?: string | null; finishReason?: string | null }>(generation: T): T {
  if (isEmptyGeneration(generation.text)) {
    if (!shouldRetryEmpty(generation.finishReason)) throw new AnswerTruncatedError();
    throw new EmptyAnswerError(generation.finishReason);
  }
  return generation;
}

/** What a stream's terminal frame comes to. */
export type StreamOutcome =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

/**
 * Read a stream's terminal frame (`done` or `error`) into an answer or a
 * typed failure. `streamed` is the text the `delta` frames carried.
 *
 *   · `done` with text → that text (authoritative, the same payload as sync).
 *   · `done` with none → the streamed text, if any; else `answer_truncated`
 *     when it stopped at the output cap, `empty_answer` otherwise.
 *   · `error` meaning an empty completion → `empty_answer`, before or after
 *     partial text; the truncated one → `answer_truncated`.
 *   · any other `error` → its own code, or `stream_failed` when it has none.
 *     An unknown code is kept, never guessed at.
 */
export function streamOutcome(
  frame: { type?: unknown; text?: unknown; code?: unknown; message?: unknown; finishReason?: unknown },
  streamed = '',
): StreamOutcome {
  if (frame.type === 'done') {
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (!isEmptyGeneration(text)) return { ok: true, text };
    if (!isEmptyGeneration(streamed)) return { ok: true, text: streamed };
    if (frame.finishReason === 'length') return truncatedOutcome();
    return { ok: false, code: EMPTY_ANSWER_CODE, message: 'The model returned an empty answer.' };
  }
  if (isTruncatedAnswerCode(frame.code)) return truncatedOutcome();
  if (isEmptyAnswerCode(frame.code)) {
    return { ok: false, code: EMPTY_ANSWER_CODE, message: 'The model returned an empty answer.' };
  }
  return {
    ok: false,
    code: typeof frame.code === 'string' && frame.code ? frame.code : 'stream_failed',
    message: typeof frame.message === 'string' ? frame.message : 'Streaming generation failed.',
  };
}

function truncatedOutcome(): StreamOutcome {
  return { ok: false, code: ANSWER_TRUNCATED_CODE, message: 'The model hit the output limit before writing an answer.' };
}
