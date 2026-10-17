import type { Message, WorkingDoc, ContextRef, ContextScope, Provenance } from './types';
import { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './aiMessages';

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
 * The message to actually show a user for a failed turn.
 *
 * When the server tagged the failure `ai_unavailable` we render the canonical
 * sentence, never the server's text — the same guarantee the BFF already makes,
 * enforced a second time at the render edge so no future error path can
 * reintroduce the leak.
 */
export function userFacingError(err: unknown): string {
  if (err instanceof AIServiceError) {
    return err.code === AI_UNAVAILABLE_CODE ? AI_UNAVAILABLE_MESSAGE : err.message;
  }
  return `Error inesperado: ${(err as Error)?.message ?? 'desconocido'}`;
}

export interface GenerateOptions {
  signal?: AbortSignal;
}

export interface StreamGenerateOptions extends GenerateOptions {
  /** Fired for each token chunk as it streams in. */
  onDelta?: (text: string) => void;
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
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new AIServiceError(`Network error: ${(err as Error).message}`);
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: SyncGenerateResult | null = null;

  for (;;) {
    const { value, done } = await reader.read();
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

  if (!result) throw new AIServiceError('Stream ended without a completion.');
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
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new AIServiceError(`Network error: ${(err as Error).message}`);
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
  return data as SyncGenerateResult;
}
