// Token streaming — `client.generate.stream(req)`, wrapping
// `POST /v1/generate/stream`.
//
// The route answers `text/event-stream` and hijacks the socket. Its frame
// grammar (see `src/routes/generate.ts`):
//
//   : ok                                        ← heartbeat / comment, skipped
//   data: {"type":"delta","text":"…"}           ← repeated, document order
//   data: {"type":"done","text":"…", …}         ← terminal, same payload as /sync
//   data: {"type":"error","code":…,"message":…} ← terminal, post-header failure
//
// Everything that can fail BEFORE the first byte (bad body, spec resolution,
// rate limit, auth) still comes back as an ordinary JSON HTTP error, so those
// map through the same `errorFromResponse` dispatcher every other method uses.
// Anything that fails AFTER the headers are out arrives as a terminal `error`
// frame carrying only `code` + `message`; we run that same dispatcher over
// `{ error: code, message }` so a mid-stream budget rejection still lands as
// `BudgetExceededError`, not as a string comparison in three products.
//
// 🔴 BUDGET (402) IS NOT A PRE-STREAM ERROR ON THIS ROUTE.
//
// `/v1/generate/stream` calls `reply.hijack()` BEFORE `router.route`, and the
// budget reserve lives inside `router.route` (see `src/routes/generate.ts` —
// hijack, then route, then the post-hijack error classifier that emits
// `BudgetExceeded` / `BudgetNotConfigured` / `BudgetMisconfigured` frames).
// The headers are therefore already on the wire when budget is enforced, so a
// 402 CANNOT throw from the `await` that opens the stream — it arrives during
// ITERATION. `/v1/generate/sync` does throw it from its await; the streaming
// route does not, and a consumer that only wraps the open call in `try` will
// let a budget rejection escape as an unhandled rejection.
//
// The pre-stream 402 branch of the dispatcher is kept anyway: it costs nothing
// and it is the correct behaviour if a future gateway or a pre-handler ever
// rejects on budget before the socket is taken over.
//
// 🔴 NO RETRY. Not before the first byte either, and there is no knob.
//
// `http.ts`'s rule is that a POST may be retried only when the caller supplied
// a `clientRequestId` the server dedupes on. `/v1/generate/stream` CANNOT meet
// that condition: `generateSyncRequestSchema` in ai-service is `.strict()`, so
// a `clientRequestId` in the body is a 400, and the route reads no such field
// anyway. A resend is a second generation and a second budget debit, exactly
// like `/v1/generate/sync`. The request therefore never sets `idempotent`, so
// `HttpClient.raw` makes exactly one attempt — including when the client was
// constructed with a retry policy for its other calls.
//
// An option to opt in was considered and deliberately left out: it would have
// been an option to double-spend, and it could not even have been honoured
// without also asserting an idempotency the route does not provide. A caller
// who wants connect-level retry owns that loop, and owns the duplicate-charge
// question with it.
//
// After the first byte there is nothing to discuss: a half-received stream
// cannot be replayed, and the tokens already delivered were already billed.

import { errorFromResponse, AIServiceError, RequestAbortedError } from './errors.js';
import type { ErrorBody } from './errors.js';
import type { HttpClient } from './http.js';
import type {
  GenerateStreamDone,
  GenerateStreamFrame,
  GenerateSyncRequest,
} from './types.js';

export interface GenerateStreamOptions {
  /** Caller cancel. Aborts the connection AND the in-flight body. */
  signal?: AbortSignal;
  /**
   * Wall-clock cap, in ms, over the WHOLE stream: from this call until the
   * terminal frame. On expiry the body reader is cancelled (so the server sees
   * the disconnect) and the open call or the iteration throws
   * `RequestAbortedError` with `reason: 'timeout'`.
   *
   * Why it exists: the client's `timeoutMs` covers the CONNECT only — its timer
   * clears when the headers land — so a stream that opens and then stalls
   * mid-answer is otherwise capped by nothing. Before this option, consumers
   * built the same cap by hand with `AbortSignal.any([signal, timeout])`.
   *
   * `streamRaw` honours it up to the headers only; after that the caller owns
   * the body.
   *
   * Must be a positive finite number; anything else throws `TypeError` before
   * a request is sent. Omit it for no cap.
   */
  maxElapsedMs?: number;
}

/**
 * A live stream. `await client.generate.stream(...)` resolves once the
 * response HEADERS are in — so a 400 / 401 / 429 throws from that await, with
 * the usual typed class, before you write any iteration code.
 *
 * ⚠ **A budget 402 does NOT throw from that await.** The route hijacks the
 * socket before it reserves budget, so `BudgetExceededError`,
 * `BudgetNotConfiguredError` and `BudgetMisconfiguredError` surface while you
 * ITERATE (or from `collect()`), not while you open. Wrap the iteration, not
 * just the open call:
 *
 * ```ts
 * const stream = await client.generate.stream(req);   // 400 / 401 / 429 here
 * try {
 *   const done = await stream.collect((t) => res.write(t));  // 402 here
 * } catch (err) {
 *   if (err instanceof BudgetExceededError) { … }
 * }
 * ```
 *
 * One `catch` around the whole thing covers both halves, which is why the same
 * typed classes are used on either side.
 */
export interface GenerateStream extends AsyncIterable<GenerateStreamFrame> {
  /**
   * The server's `x-request-id` for this stream, from the response headers.
   *
   * The two hijacking routes set it on `reply.raw` precisely because this is
   * where a consumer needs a correlation id: a stream that dies mid-flight has
   * no error body to carry one. `undefined` only if the deployment predates
   * that header.
   */
  readonly httpRequestId: string | undefined;
  /** Cancel the stream. Idempotent. The iterator then throws `RequestAbortedError`. */
  abort(): void;
  /**
   * Drain to completion, calling `onDelta` for each token chunk, and resolve
   * the terminal `done` frame.
   *
   * ⚠ `done.text` is AUTHORITATIVE and is not always the concatenation of the
   * deltas: on a cache hit the route emits NO deltas and the whole answer
   * arrives in `done`. Render deltas optimistically; keep `done.text`.
   */
  collect(onDelta?: (text: string) => void): Promise<GenerateStreamDone>;
}

/**
 * Open the stream and hand back the raw `Response`, body unread.
 *
 * Everything up to the first byte is done here: bearer, abort composition, and
 * turning a non-2xx into the typed error class. A consumer that re-streams the
 * frames onward (a proxy) wants exactly this; a consumer that reads the tokens
 * wants {@link openGenerateStream}.
 *
 * The returned `signal`/`abort` pair is threaded back through
 * {@link openGenerateStream}; a direct caller of the raw form owns cancelling
 * its own body.
 */
export async function openRawGenerateStream(
  http: HttpClient,
  req: GenerateSyncRequest,
  opts: GenerateStreamOptions = {},
): Promise<Response> {
  const conn = await connect(http, req, opts);
  // The raw caller owns the body from here; a timer left running could not
  // reach it anyway (see the reader note in `openGenerateStream`).
  conn.clearCap();
  return conn.res;
}

interface Connection {
  res: Response;
  signal: AbortSignal;
  abort: () => void;
  /** Stop the `maxElapsedMs` timer. Idempotent. */
  clearCap: () => void;
  /** The `RequestAbortedError` to throw for this connection's abort. */
  abortedError: () => RequestAbortedError;
}

function assertMaxElapsedMs(value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `ai-client: maxElapsedMs must be a positive finite number of milliseconds (got ${String(value)})`,
    );
  }
}

async function connect(
  http: HttpClient,
  req: GenerateSyncRequest,
  opts: GenerateStreamOptions,
): Promise<Connection> {
  assertMaxElapsedMs(opts.maxElapsedMs);
  const ctrl = new AbortController();
  let aborted = false;
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener('abort', abort, { once: true });
  }

  // `timedOut` is set by OUR timer, so the abort is classified by who fired
  // it, not by the shape of whatever error the runtime throws (same rule as
  // `HttpClient.attempt`).
  let timedOut = false;
  const maxElapsedMs = opts.maxElapsedMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (maxElapsedMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, maxElapsedMs);
    // A cap must never be what keeps a process alive.
    (timer as { unref?: () => void }).unref?.();
  }
  const clearCap = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const abortedError = (): RequestAbortedError =>
    timedOut
      ? new RequestAbortedError(
          'timeout',
          `ai-client stream exceeded maxElapsedMs (${String(maxElapsedMs)}ms)`,
        )
      : new RequestAbortedError('cancel', 'ai-client stream cancelled by the caller');

  let res: Response;
  try {
    res = await http.raw({
      method: 'POST',
      path: '/v1/generate/stream',
      body: req,
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
      // `idempotent` is left unset ON PURPOSE — see the module header. That is
      // what pins this to a single attempt whatever the client's retry policy
      // says; `retry: { attempts: 1 }` here would merely restate it and would
      // read like a setting somebody may raise.
    });
  } catch (err) {
    clearCap();
    if (timedOut && err instanceof RequestAbortedError) throw abortedError();
    throw err;
  }

  if (!res.ok) {
    clearCap();
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = { message: text };
    }
    throw errorFromResponse(res.status, parsed, res.headers);
  }

  return {
    res,
    signal: ctrl.signal,
    abort,
    clearCap,
    abortedError,
  };
}

export async function openGenerateStream(
  http: HttpClient,
  req: GenerateSyncRequest,
  opts: GenerateStreamOptions = {},
): Promise<GenerateStream> {
  const conn = await connect(http, req, opts);
  const { res, signal: ctrlSignal, abort } = conn;

  const body = res.body;
  if (!body) {
    conn.clearCap();
    throw new AIServiceError('ai-service stream response carried no body', res.status, {});
  }

  const httpRequestId = res.headers.get('x-request-id') ?? undefined;
  // 🔴 We cancel the READER, not just the AbortController. `HttpClient.attempt`
  // removes its caller-abort listener in a `finally` that runs the moment
  // `fetch` resolves — i.e. as soon as the headers land — so aborting our
  // signal after that point no longer reaches the request. Cancelling the
  // reader destroys the underlying socket, which is what makes the SERVER see
  // the disconnect and refund the unspent budget reserve.
  const reader = body.getReader();
  let consumed = false;

  async function* iterate(): AsyncGenerator<GenerateStreamFrame> {
    if (consumed) {
      throw new AIServiceError('ai-client: this stream has already been consumed', 0, {});
    }
    consumed = true;
    const onAbort = (): void => {
      void reader.cancel().catch(() => {});
    };
    if (ctrlSignal.aborted) onAbort();
    else ctrlSignal.addEventListener('abort', onAbort, { once: true });

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let terminated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = parseFrame(raw);
          if (frame === undefined) continue;
          if (frame.type === 'error') throw errorFromFrame(frame);
          yield frame;
          if (frame.type === 'done') {
            terminated = true;
            return;
          }
        }
      }
      if (ctrlSignal.aborted) throw conn.abortedError();
      if (!terminated) {
        // The socket closed with no `done` and no `error`. That is a stream
        // that died mid-flight — surfacing it as a clean end would hand the
        // caller a truncated answer it has no way to recognise as truncated.
        throw new AIServiceError(
          'ai-service stream ended before a terminal frame',
          0,
          { error: 'StreamTruncated' },
        );
      }
    } finally {
      conn.clearCap();
      ctrlSignal.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => {});
    }
  }

  return {
    httpRequestId,
    abort,
    [Symbol.asyncIterator]: iterate,
    async collect(onDelta) {
      for await (const frame of iterate()) {
        if (frame.type === 'delta') onDelta?.(frame.text);
        else return frame;
      }
      // Unreachable: `iterate` returns only after yielding `done`, and throws
      // on every other exit.
      throw new AIServiceError('ai-service stream ended before a terminal frame', 0, {
        error: 'StreamTruncated',
      });
    },
  };
}

/**
 * The terminal SSE `error` frame. The reply is hijacked before the first byte,
 * so anything a JSON caller would have read off the STATUS LINE or a HEADER is
 * re-expressed here or it is simply lost. Field names differ from the JSON
 * body's because the frame shape predates ai-service's `ERR_` strings, while
 * the VALUES are identical (`src/errors/generate-map.ts`):
 *
 *   frame `code`      ≡ JSON body `error`  — the class-name discriminator
 *   frame `errorCode` ≡ JSON body `code`   — the stable `ERR_` machine string
 */
interface ErrorFrame {
  type: 'error';
  code?: string;
  message?: string;
  /** The `ERR_` machine string, when the erroring class declares one. */
  errorCode?: string;
  /** Only set for retryable refusals; the frame omits it otherwise. */
  retryAfterMs?: number;
  /** `ProviderTimeout` only: the provider was cut off and the call NOT billed. */
  truncated?: boolean;
  /** `ProviderTimeout` only: `provider_timeout`. */
  reason?: string;
  /** `ProviderTimeout` only: the router trace of the cut call. */
  traceId?: string;
}

/**
 * Parse one SSE frame. Comment/heartbeat lines (`: ok`, `: ping`) and frames
 * carrying no `data:` line yield `undefined`. An unparseable or untyped
 * payload is skipped rather than thrown: a future frame type must not break a
 * client that predates it.
 */
function parseFrame(frame: string): GenerateStreamFrame | ErrorFrame | undefined {
  const chunks: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) chunks.push(line.slice(5).trimStart());
  }
  if (chunks.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunks.join('\n'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const type = (parsed as { type?: unknown }).type;
  if (type === 'delta') {
    const text = (parsed as { text?: unknown }).text;
    return { type: 'delta', text: typeof text === 'string' ? text : '' };
  }
  if (type === 'done') return parsed as GenerateStreamDone;
  if (type === 'error') return parsed as ErrorFrame;
  return undefined;
}

/**
 * Map a terminal `error` frame onto the same typed classes an HTTP error would
 * produce, by feeding its `code` to the shared discriminator dispatcher.
 *
 * `status` is 0 for anything the dispatcher does not recognise: the headers
 * were already sent as 200, so there is no HTTP status that describes this.
 * The classes that DO know their own status (402 for the budget family) keep
 * it. Those classes' numeric fields (`requested`, `remaining`, …) are zero
 * here — the frame carries only `code` and `message`, by design, so nothing
 * server-internal leaks post-hijack. Read `message`.
 */
/**
 * Rebuild the JSON-transport body a frame stands in for, then map it through
 * the SAME `errorFromResponse` table, so the two transports cannot classify
 * the same failure differently.
 *
 * 🔴 Before 0.17.0 this rebuilt `{ error, message }` and nothing else, so the
 * two fields that only EXIST on a frame were dropped: a `ProviderUnavailable`
 * frame lost `retryAfterMs` — the breaker's own cool-down, and the whole point
 * of the frame carrying it — and every frame lost `errorCode`, so `err.code`
 * was blank mid-stream and populated over JSON for the identical error.
 */
function errorFromFrame(frame: ErrorFrame): AIServiceError {
  const code = typeof frame.code === 'string' ? frame.code : 'INTERNAL';
  const message =
    typeof frame.message === 'string' && frame.message.length > 0
      ? frame.message
      : 'ai-service stream failed';
  const body: ErrorBody = { error: code, message };
  // Frame `errorCode` lands where the JSON body carries it, so `codeFromBody`
  // recovers `err.code` even for a class this client version predates.
  if (typeof frame.errorCode === 'string') body['code'] = frame.errorCode;
  if (typeof frame.retryAfterMs === 'number') body['retryAfterMs'] = frame.retryAfterMs;
  // `ProviderTimeout` frames (newer servers): the unbilled-cut marker and
  // the trace id ride the frame because there is no JSON body to read them from.
  if (frame.truncated === true) body['truncated'] = true;
  if (typeof frame.reason === 'string') body['reason'] = frame.reason;
  if (typeof frame.traceId === 'string') body['traceId'] = frame.traceId;
  return errorFromResponse(0, body);
}
