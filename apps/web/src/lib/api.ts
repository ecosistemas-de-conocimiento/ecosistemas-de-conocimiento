import { safeErrMessage } from '$lib/errorSummary';
import type { Message, WorkingDoc, ContextRef, ContextScope, Provenance } from './types';
import { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './aiMessages';
import { ANSWER_TRUNCATED_CODE, EMPTY_ANSWER_CODE, isEmptyGeneration } from '@edc/chat-engine/core';

/**
 * Client-side wrapper around the BFF endpoint at /api/generate.
 *
 * Fetch goes to the SAME ORIGIN — no CORS, no bearer in browser. The actual
 * relay to ai-service (and the AI_SERVICE_API_KEY) lives in
 * src/routes/api/generate/+server.ts, which only ever runs on the Node
 * server. Audit: `grep -roh "AI_SERVICE_API_KEY|Bearer" .svelte-kit/output/client/`
 * should return nothing.
 */

export interface SyncGenerateInput {
  sessionId: string;
  messages: Pick<Message, 'role' | 'content'>[];
  /** `@`-mention refs attached to the latest user turn. */
  contextRefs?: ContextRef[];
  /** Per-thread context scope (organization-wide). */
  scope?: ContextScope;
  /** Retrieve only documentos about speakers of this language. See `$lib/lengua.ts`. */
  lengua?: string;
  /** Student view: retrieve only from my works or opted-in peers' works. */
  alcance?: 'mios' | 'companeros';
  /**
   * Generales only: the person switched "Hazme preguntas" on (`$lib/entrevista`).
   * The interviewer still needs the ecosistema's `interviewerMode` switch on
   * and the message read as the person's own story.
   */
  entrevista?: boolean;
  /**
   * This turn's id, made by `runTurn`. The server stamps it on the saved
   * answer (`generationMeta.turnId`), so a retry or a recovery finds THIS
   * turn's answer and never another's, and never saves a second one.
   */
  turnId?: string;
}

export interface SyncGenerateResult {
  text: string;
  modelUsed?: string;
  provider?: string;
  costUsd?: number;
  traceId?: string;
  /**
   * The backend message id for the persisted assistant turn. `null` when the
   * save failed — `warnings` then carries `ANSWER_NOT_SAVED`.
   */
  messageId?: string | null;
  /** Citation provenance for the assistant turn (drives the citation card). */
  provenance?: Provenance | null;
  /**
   * Non-fatal advisories: ai-service's (`BUDGET_SOFT_CAP`, not rendered — the
   * server already logged it) and the BFF's `ANSWER_NOT_SAVED`, which
   * `Chat.svelte` shows under the answer (`answerNotice`).
   */
  warnings?: { code: string; message: string }[];
}

export class AIServiceError extends Error {
  /**
   * Machine-readable tag from the server, when it sent one (today:
   * `ai_unavailable` for a budget failure). The UI branches on THIS rather than
   * on the message text, so the wording can change without breaking the check.
   */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AIServiceError';
    this.code = code;
  }
}

/**
 * The browser lost the connection to our own server: the request never got an
 * answer, or the answer stopped part way. The server may still have finished
 * the turn and saved it, so this is the one failure worth checking the saved
 * conversation for (`runTurn`). A failure the SERVER declared (an HTTP status,
 * an `error` frame) is a plain `AIServiceError`.
 */
export class ConnectionLostError extends AIServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionLostError';
  }
}

function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

/**
 * The message to actually show a user for a failed turn.
 *
 * When the server tagged the failure `ai_unavailable` we render the canonical
 * sentence, never the server's text — the same guarantee the BFF already makes,
 * enforced a second time at the render edge so no future error path can
 * reintroduce the leak.
 */
export function userFacingError(err: unknown): string {
  if (err instanceof AIServiceError && err.code === AI_UNAVAILABLE_CODE) {
    return AI_UNAVAILABLE_MESSAGE;
  }
  if (err instanceof AIServiceError && err.code === EMPTY_ANSWER_CODE) return EMPTY_ANSWER_MESSAGE;
  if (err instanceof AIServiceError && err.code === ANSWER_TRUNCATED_CODE) return ANSWER_TRUNCATED_MESSAGE;
  // Every other failure text is written for developers ("Network error: …",
  // "ai-service: …", "HTTP 502"). The people using this are not technical
  // (UX backlog #26), so they get one plain sentence and the detail goes to
  // the console.
  console.warn('[chat] turn failed:', safeErrMessage(err));
  return err instanceof ConnectionLostError ? CONNECTION_LOST_MESSAGE : TURN_FAILED_MESSAGE;
}

/** What a failed chat turn says when the server declared the failure. */
export const TURN_FAILED_MESSAGE = 'No se pudo obtener la respuesta. Inténtalo de nuevo en un momento.';

/** What it says when the browser never heard back from our server. */
export const CONNECTION_LOST_MESSAGE = 'Se perdió la conexión antes de recibir la respuesta.';

/** What it says when the model answered with no text (`EMPTY_ANSWER_CODE`). */
export const EMPTY_ANSWER_MESSAGE = 'La respuesta llegó vacía.';

/** What it says when the model spent the output limit before writing (`ANSWER_TRUNCATED_CODE`). */
export const ANSWER_TRUNCATED_MESSAGE = 'La respuesta excedió el límite de longitud.';

/**
 * Whether "Reintentar" can help a failed turn. Not for `ANSWER_TRUNCATED_CODE`:
 * the same question hits the same limit again.
 */
export function canRetryTurn(err: unknown): boolean {
  return !(err instanceof AIServiceError && err.code === ANSWER_TRUNCATED_CODE);
}

/** An answer with no visible text is a failed turn, whichever transport brought it. */
function emptyAnswerError(): AIServiceError {
  return new AIServiceError('The answer came back empty.', EMPTY_ANSWER_CODE);
}

export interface GenerateOptions {
  signal?: AbortSignal;
}

export interface StreamGenerateOptions extends GenerateOptions {
  /** Fired for each token chunk as it streams in. */
  onDelta?: (text: string) => void;
  /**
   * Fired once when the stream opens. The BFF sends its headers only after it
   * has searched the documents and ai-service has accepted the generation, so
   * this is the moment "buscando" becomes "escribiendo" (UX backlog #9).
   */
  onOpen?: () => void;
}

/**
 * Streaming counterpart to `generateSync`. POSTs to the same BFF endpoint with
 * `?stream=1`, reads the `text/event-stream` response, and invokes `onDelta`
 * for each token chunk. Resolves with the final `SyncGenerateResult` from the
 * terminal `done` frame.
 *
 * The `done` frame's text is authoritative — callers should replace whatever
 * they accumulated from `onDelta` with `result.text` on resolve. Throws
 * `AIServiceError` on a server `error` frame or an HTTP-level failure, and
 * propagates `AbortError` on user cancel so callers can distinguish it.
 */
export async function generateStream(
  input: SyncGenerateInput,
  opts: StreamGenerateOptions = {},
): Promise<SyncGenerateResult> {
  let res: Response;
  try {
    res = await fetch('/api/generate?stream=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(input),
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ConnectionLostError(`Network error: ${(err as Error).message}`);
  }

  if (!res.ok || !res.body) {
    // Non-stream error response (JSON or empty). Surface for fallback/handling.
    let detail = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(await res.text());
      if (parsed && typeof parsed === 'object' && 'message' in parsed) {
        detail = String((parsed as { message: unknown }).message);
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { code?: unknown }).code === 'string') {
        code = (parsed as { code: string }).code;
      }
    } catch {
      /* keep status-based detail */
    }
    throw new AIServiceError(detail, code);
  }

  opts.onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: SyncGenerateResult | null = null;

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ConnectionLostError(`Stream interrupted: ${(err as Error)?.message ?? err}`);
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      if (dataLines.length === 0) continue; // heartbeat / comment
      let evt: { type?: string; text?: string } & Record<string, unknown>;
      try {
        evt = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (evt.type === 'delta') {
        if (typeof evt.text === 'string') opts.onDelta?.(evt.text);
      } else if (evt.type === 'done') {
        if (isEmptyGeneration(typeof evt.text === 'string' ? evt.text : '')) throw emptyAnswerError();
        result = {
          text: typeof evt.text === 'string' ? evt.text : '',
          modelUsed: evt.modelUsed as string | undefined,
          provider: evt.provider as string | undefined,
          costUsd: evt.costUsd as number | undefined,
          traceId: evt.traceId as string | undefined,
          messageId: evt.messageId as string | null | undefined,
          provenance: (evt.provenance as Provenance | null | undefined) ?? null,
          warnings: evt.warnings as SyncGenerateResult['warnings'],
        };
      } else if (evt.type === 'error') {
        // The BFF rewrites budget frames to the canonical message + code
        // before they reach here; carrying `code` lets the UI assert it.
        throw new AIServiceError(
          typeof evt.message === 'string' ? evt.message : 'Streaming generation failed.',
          typeof evt.code === 'string' ? evt.code : undefined,
        );
      }
    }
  }

  if (!result) throw new ConnectionLostError('Stream ended without a completion.');
  return result;
}

export async function generateSync(
  input: SyncGenerateInput,
  opts: GenerateOptions = {},
): Promise<SyncGenerateResult> {
  let res: Response;
  let raw: string;
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: opts.signal,
    });
    raw = await res.text();
  } catch (err) {
    // Let AbortError propagate so callers can distinguish user cancellation
    // from genuine network failures.
    if (isAbort(err)) throw err;
    throw new ConnectionLostError(`Network error: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    const detail =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `HTTP ${res.status}`;
    const code =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string'
        ? (parsed as { code: string }).code
        : undefined;
    throw new AIServiceError(detail, code);
  }

  const data = parsed as Partial<SyncGenerateResult> | null;
  if (!data || typeof data.text !== 'string') {
    throw new AIServiceError('Server returned unexpected payload.');
  }
  if (isEmptyGeneration(data.text)) throw emptyAnswerError();
  return data as SyncGenerateResult;
}

export interface RunTurnOptions extends StreamGenerateOptions {
  /**
   * The connection dropped part way through the answer and the turn is being
   * asked again: drop the partial text shown so far.
   */
  onRestart?: () => void;
  /** How many times to look for a saved answer. Default 12. */
  recoverAttempts?: number;
  /** Wait between those looks. Default 2.5 s, so about 30 s in all. */
  recoverIntervalMs?: number;
}

/**
 * One chat turn, end to end. What `Chat.svelte` calls.
 *
 *   1. Stream (`generateStream`).
 *   2. The stream failed with nothing shown, or the CONNECTION dropped part
 *      way: ask again on sync (`generateSync`), the whole turn from scratch.
 *      A server-declared error after part of the answer is final, and so is
 *      an empty answer (`EMPTY_ANSWER_CODE`): no second wait on its own, the
 *      person asks again with "Reintentar". An answer cut at the output limit
 *      (`ANSWER_TRUNCATED_CODE`) is final too, with no "Reintentar". After a
 *      lost connection, look once in the saved conversation first: the
 *      server may have saved the answer, and asking again would pay twice.
 *   3. The sync request lost its connection too: the server may still finish
 *      and save the answer, so look for it in the saved conversation before
 *      reporting a failure.
 *   4. Still nothing saved: ask on sync once more, with the same `turnId`.
 *
 * Step 3 is the fix for run 1 of the 2026-10-23 dev check (runbook §4zg): the
 * stream request died before its headers, the sync fallback died at ~30 s, and
 * the server had saved the answer while the screen said "No se pudo obtener
 * la respuesta". `api.turn.test.ts` replays it.
 *
 * Every request carries the same `turnId`; a saved answer counts only when its
 * `generationMeta.turnId` matches (audit 2026-10-24: a previous turn's
 * late-saved answer was shown as this one).
 */
export async function runTurn(
  turnInput: SyncGenerateInput,
  opts: RunTurnOptions = {},
): Promise<SyncGenerateResult> {
  const input = { ...turnInput, turnId: turnInput.turnId ?? crypto.randomUUID() };
  let received = false;
  try {
    return await generateStream(input, {
      signal: opts.signal,
      onOpen: opts.onOpen,
      onDelta: (text) => {
        received = true;
        opts.onDelta?.(text);
      },
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    if (received && !(err instanceof ConnectionLostError)) throw err;
    if (err instanceof AIServiceError && err.code === EMPTY_ANSWER_CODE) throw err;
    if (!canRetryTurn(err)) throw err;
    if (err instanceof ConnectionLostError) {
      const saved = await findSavedAnswer(input.sessionId, input.turnId, { ...opts, recoverAttempts: 1 });
      if (saved) return saved;
    }
    if (received) opts.onRestart?.();
  }
  // Step 4: the sync request was lost and nothing was saved (dev 2026-10-24,
  // session 180: it never reached ai-service). Ask once more. The same
  // `turnId` makes the BFF hand back a saved or in-flight answer rather than
  // generate a second one.
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateSync(input, { signal: opts.signal });
    } catch (err) {
      if (isAbort(err) || !(err instanceof ConnectionLostError)) throw err;
      const saved = await findSavedAnswer(input.sessionId, input.turnId, opts);
      if (saved) return saved;
      if (attempt >= 1) throw err;
    }
  }
}

/** This turn's answer, if the server saved it. `null` when it never shows up. */
async function findSavedAnswer(
  sessionId: string,
  turnId: string,
  opts: RunTurnOptions,
): Promise<SyncGenerateResult | null> {
  const attempts = opts.recoverAttempts ?? 12;
  const interval = opts.recoverIntervalMs ?? 2500;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(interval, opts.signal);
    let docs: Record<string, unknown>[] = [];
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        credentials: 'same-origin',
        signal: opts.signal,
      });
      if (res.ok) docs = ((await res.json()) as { docs?: Record<string, unknown>[] }).docs ?? [];
    } catch (err) {
      if (isAbort(err)) throw err;
      // Still offline: look again.
    }
    const answer = docs.find(
      (d) =>
        d.role === 'assistant' &&
        d.id != null &&
        (d.generationMeta as { turnId?: unknown } | null | undefined)?.turnId === turnId,
    );
    if (answer) {
      const meta = (answer.generationMeta ?? {}) as Record<string, unknown>;
      return {
        text: typeof answer.content === 'string' ? answer.content : '',
        messageId: String(answer.id),
        provenance: (answer.provenance as Provenance | null | undefined) ?? null,
        modelUsed: meta.modelUsed as string | undefined,
        provider: meta.provider as string | undefined,
        costUsd: meta.costUsd as number | undefined,
        traceId: meta.traceId as string | undefined,
      };
    }
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}
