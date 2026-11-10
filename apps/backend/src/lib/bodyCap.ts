/**
 * 🔴 NO REQUEST BODY IS READ WHOLE WITHOUT A BOUND (audit 2026-11-10, C-03).
 *
 * Next sets no body limit on route handlers, and Payload's REST handler calls
 * `req.text()` on every JSON write (`addDataAndFileToRequest`) and on a POST
 * that overrides to GET (`handleEndpoints`). Both happen BEFORE collection
 * access runs: Payload only identifies the user first, it refuses nobody. So
 * an anonymous caller could push any body it liked into this process's memory.
 *
 * Three layers, each counting what it reads:
 *   · `src/middleware.ts` refuses a declared `Content-Length` over
 *     `API_BODY_MAX_BYTES` on any non-multipart `/api/*` request.
 *   · `withCappedBody` wraps Payload's REST routes and COUNTS the bytes, so a
 *     chunked body with no `Content-Length` stops at the same cap.
 *   · Our own routes read with `readCapped`: the callback receiver and live
 *     slices at their own, lower caps, holds and published at this one.
 *
 * 🔴 A MULTIPART LABEL BUYS NOTHING OFF AN UPLOAD ROUTE (re-audit 2026-11-10,
 * N2). Only Payload's own endpoints hand multipart to busboy; a custom
 * endpoint calls `req.json()` on the raw stream, and several do it before they
 * check who is asking. So only `isUploadRoute` skips the count, and there
 * busboy's `upload.limits` in `payload.config.ts` bound the file and fields.
 *
 * 🔴 A SLOW BODY IS BOUNDED IN TIME TOO (re-audit 2026-11-10, C-03). Each
 * counted read stops after `API_BODY_IDLE_TIMEOUT_MS` with no bytes, or
 * `API_BODY_TOTAL_TIMEOUT_MS` in all, cancels the stream and answers 408.
 * Node's own `server.requestTimeout` (300 s by default since Node 18, quoted
 * from the Node docs; Next 15.4's `start-server.js` leaves it alone, read) is
 * the outer bound; these are tighter. An upload is busboy's, and keeps
 * Node's bound only.
 *
 * ⚠ Edge-safe on purpose: the middleware imports this file. Web APIs only.
 */

const MiB = 1024 * 1024

/**
 * 8 MiB. The largest JSON write the app sends is a note's `bodyMarkdown`, up to
 * `DOCUMENT_TEXT_MAX_LENGTH` (2,000,000) UTF-16 units, at most 3 UTF-8 bytes
 * each: 6 MB (inferred from `collections/Documents.ts`). Live audio slices are
 * 4 MiB (`app/api/live/[sid]/route.ts`). It also stays under the 10 MiB that
 * Next copies of a body for middleware (quoted from Next 15.4,
 * `server/body-streams.js`), past which Next truncates it.
 */
export const API_BODY_MAX_BYTES = 8 * MiB

/**
 * 2 MiB. The largest signed event is `transcribe.completed` with an inline
 * transcript of up to 200,000 characters (`CALLBACK_MAX_TRANSCRIPT_CHARS`,
 * `services/audio-service/app/config.py`); at 4 UTF-8 bytes per character
 * that is 800 KB, and 1.2 MB even if every one were a 6-byte JSON escape
 * (inferred). Everything else in the envelope is ids and counters.
 */
export const CALLBACK_BODY_MAX_BYTES = 2 * MiB

/** Case-insensitive, as MIME types are. */
export const isMultipart = (contentType: string | null): boolean =>
  /^multipart\//i.test(contentType ?? '')

/**
 * A write that takes a file: create and update-by-id on an upload collection
 * (`upload:` in `collections/*.ts`; `media` alone, checked in the tests).
 * Payload's own handlers there parse multipart with busboy and nothing else
 * reads the body: `Media` has no custom endpoints, and the method-override
 * POST reads only JSON and form-urlencoded (`handleEndpoints`, Payload 3.88).
 */
export function isUploadRoute(request: Request): boolean {
  const method = request.method.toUpperCase()
  const { pathname } = new URL(request.url)
  return (
    (method === 'POST' && pathname === '/api/media') ||
    (method === 'PATCH' && /^\/api\/media\/[^/]+$/.test(pathname))
  )
}

/** A `Content-Length` over `max`. Absent or unparseable is not "over": the reader counts. */
export function declaresOver(request: Request, max: number): boolean {
  const declared = Number(request.headers.get('content-length') ?? '0')
  return Number.isFinite(declared) && declared > max
}

export const tooLarge = (max: number): Response =>
  Response.json(
    { errors: [{ message: `Request body over ${Math.round(max / MiB)} MiB.` }] },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  )

/**
 * 30 s with no bytes. A client that sends nothing for that long has stalled or
 * gone; a lossy mobile link stalls for seconds, not tens of them (inferred).
 */
export const BODY_IDLE_TIMEOUT_MS = 30_000

/**
 * 120 s for the whole body. The cap, 8 MiB, at 1 Mbit/s takes about 67 s
 * (inferred: 8 × 8 Mbit / 1 Mbit/s); every body the app sends is far smaller.
 */
export const BODY_TOTAL_TIMEOUT_MS = 120_000

export interface BodyTimeouts {
  idleMs: number
  totalMs: number
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** `API_BODY_IDLE_TIMEOUT_MS` and `API_BODY_TOTAL_TIMEOUT_MS`, else the defaults. */
export function bodyTimeouts(env: Record<string, string | undefined> = process.env): BodyTimeouts {
  return {
    idleMs: positive(env.API_BODY_IDLE_TIMEOUT_MS, BODY_IDLE_TIMEOUT_MS),
    totalMs: positive(env.API_BODY_TOTAL_TIMEOUT_MS, BODY_TOTAL_TIMEOUT_MS),
  }
}

/** The body stalled or took too long; the stream was cancelled. */
export class BodyTimeoutError extends Error {
  constructor() {
    super('Request body read timed out.')
    this.name = 'BodyTimeoutError'
  }
}

export const bodyTimedOut = (): Response =>
  Response.json(
    { errors: [{ message: 'Request body too slow.' }] },
    { status: 408, headers: { 'cache-control': 'no-store', connection: 'close' } },
  )

/** One read, or 'timeout' after `ms`. */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([reader.read(), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The body, or null past `max` bytes. Counted while reading, and the stream is
 * cancelled at the cap, so no more than `max` plus one chunk is ever held.
 * Throws {@link BodyTimeoutError} past `timeouts`, after cancelling the stream.
 */
export async function readCapped(
  request: Request,
  max: number,
  timeouts: BodyTimeouts = bodyTimeouts(),
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (declaresOver(request, max)) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  const deadline = Date.now() + timeouts.totalMs
  for (;;) {
    const result = await readWithin(reader, Math.max(0, Math.min(timeouts.idleMs, deadline - Date.now())))
    if (result === 'timeout') {
      // Not awaited: a source stuck in `pull` may never settle its cancel.
      reader.cancel().catch(() => {})
      throw new BodyTimeoutError()
    }
    const { done, value } = result
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  return out
}

/**
 * The request with its body read under `max`, or null past it. A request with
 * no body, a GET/HEAD, or multipart to an upload route (busboy bounds that
 * one) is returned as is. Multipart anywhere else is counted like JSON, and
 * Payload parses the copy: the admin panel sends every form as multipart.
 * Throws {@link BodyTimeoutError} like {@link readCapped}.
 */
export async function withCappedBody(
  request: Request,
  max: number,
  timeouts: BodyTimeouts = bodyTimeouts(),
): Promise<Request | null> {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || !request.body) return request
  if (isMultipart(request.headers.get('content-type')) && isUploadRoute(request)) return request
  const bytes = await readCapped(request, max, timeouts)
  // ⚠ Not `new Request(request, …)`: Next hands route handlers its own Request
  // class, and undici's constructor throws on it ("private member #state").
  return bytes
    ? new Request(request.url, { method: request.method, headers: request.headers, body: bytes })
    : null
}
