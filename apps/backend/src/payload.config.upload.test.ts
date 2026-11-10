/**
 * 🔴 THE MEDIA CAP HOLDS IN THE PARSER, NOT ONLY IN THE HOOK (audit 2026-11-10,
 * C-03 and L-08).
 *
 * `collections/Media.size.test.ts` tests `rejectOversizedUpload` with a size
 * already computed, so it cannot see the file being buffered whole before the
 * hook runs. This sends the bytes through `addDataAndFileToRequest` — the call
 * Payload's REST handler makes on every multipart request — with the `upload`
 * options of the REAL `payload.config.ts`.
 *
 * ⚠ The body is a lazy stream, so the test itself never holds it in memory.
 * Building the real config takes seconds; it lives in `beforeAll`, as in
 * `payload.config.storage.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { addDataAndFileToRequest, type PayloadRequest } from 'payload'

import { MAX_MEDIA_UPLOAD_BYTES, rejectOversizedUpload } from './collections/Media'

const MiB = 1024 * 1024
const BOUNDARY = '----edc-upload-test'

let config: { upload?: unknown; bodyParser?: unknown }

beforeAll(async () => {
  process.env.PAYLOAD_SECRET ||= 'test-secret'
  process.env.DATABASE_URI ||= 'postgres://test@localhost:5433/test'
  const mod = await import('./payload.config')
  config = (await mod.default) as unknown as typeof config
})

/** A multipart body with one part per entry in `files`, streamed 1 MiB at a time. */
function multipart(files: Array<{ field: string; bytes: number }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const chunk = new Uint8Array(MiB).fill(0x61)
  const parts: Array<() => Iterable<Uint8Array>> = files.map(({ field, bytes }, i) => () => {
    const out: Uint8Array[] = [
      enc.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="f${i}.txt"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
      ),
    ]
    for (let left = bytes; left > 0; left -= MiB) out.push(left >= MiB ? chunk : chunk.subarray(0, left))
    out.push(enc.encode('\r\n'))
    return out
  })
  const pieces = (function* () {
    for (const part of parts) yield* part()
    yield enc.encode(`--${BOUNDARY}--\r\n`)
  })()
  return new ReadableStream({
    pull(controller) {
      const next = pieces.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  })
}

function requestWith(body: ReadableStream<Uint8Array>): PayloadRequest {
  const req = new Request('http://backend.test/api/media', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    duplex: 'half',
  } as RequestInit)
  return Object.assign(req, { payload: { config } }) as unknown as PayloadRequest
}

describe('the media cap, applied while the body streams', () => {
  it('🔴 stops buffering one byte past the cap, and the hook then refuses the file', async () => {
    const req = requestWith(multipart([{ field: 'file', bytes: MAX_MEDIA_UPLOAD_BYTES + 8 * MiB }]))
    await addDataAndFileToRequest(req)
    // Held in memory: the cap plus one, not the 8 MiB more that was sent.
    expect(req.file?.data.length).toBe(MAX_MEDIA_UPLOAD_BYTES + 1)
    expect(req.file?.size).toBe(MAX_MEDIA_UPLOAD_BYTES + 1)
    expect((req.file as { truncated?: boolean } | undefined)?.truncated).toBe(true)
    // The parser's output, handed to the real hook, is refused.
    const run = () =>
      (rejectOversizedUpload as unknown as (a: { data: object; req: PayloadRequest }) => unknown)({
        data: {},
        req,
      })
    expect(run).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          errors: [expect.objectContaining({ path: 'file', message: expect.stringMatching(/maximum is 200 MB/) })],
        }),
      }),
    )
  })

  it('🔴 does not abort on the limit: in 3.88 that is an unhandled rejection that can exit the process', () => {
    expect((config.upload as { abortOnLimit?: boolean }).abortOnLimit).toBeFalsy()
  })

  it('still parses a file under the cap, in memory, where the Media hooks read it', async () => {
    const req = requestWith(multipart([{ field: 'file', bytes: 2 * MiB }]))
    await addDataAndFileToRequest(req)
    expect(req.file?.size).toBe(2 * MiB)
    expect(req.file?.data.length).toBe(2 * MiB)
    expect(req.file?.tempFilePath).toBeFalsy()
  })

  it('🔴 keeps only one file per request, so the cap cannot be multiplied', async () => {
    const req = requestWith(
      multipart([
        { field: 'file', bytes: MiB },
        { field: 'other', bytes: 2 * MiB },
        { field: 'third', bytes: 2 * MiB },
      ]),
    )
    await addDataAndFileToRequest(req)
    expect(Object.keys(req.files ?? {})).toEqual(['file'])
  })
})
