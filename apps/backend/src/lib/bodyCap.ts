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
 *   · The callback receiver reads with `readCapped` at its own, lower cap.
 * Multipart is bounded by busboy's `upload.limits` in `payload.config.ts`.
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

export const isMultipart = (contentType: string | null): boolean =>
  /^multipart\//i.test(contentType ?? '')

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
 * The body, or null past `max` bytes. Counted while reading, and the stream is
 * cancelled at the cap, so no more than `max` plus one chunk is ever held.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (declaresOver(request, max)) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
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
 * no body, a GET/HEAD, or multipart (busboy bounds that one) is returned as is.
 */
export async function withCappedBody(request: Request, max: number): Promise<Request | null> {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || !request.body) return request
  if (isMultipart(request.headers.get('content-type'))) return request
  const bytes = await readCapped(request, max)
  // ⚠ Not `new Request(request, …)`: Next hands route handlers its own Request
  // class, and undici's constructor throws on it ("private member #state").
  return bytes
    ? new Request(request.url, { method: request.method, headers: request.headers, body: bytes })
    : null
}
