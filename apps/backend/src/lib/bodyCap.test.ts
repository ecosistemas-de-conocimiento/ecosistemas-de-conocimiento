/**
 * 🔴 `lib/bodyCap.ts`: a body is counted while it is read and dropped at the
 * cap, whether or not it declares a `Content-Length` (audit 2026-11-10, C-03).
 */

import { describe, expect, it } from 'vitest'

import { readCapped, withCappedBody } from './bodyCap'

const KiB = 1024

/** An endless body that records how many chunks were pulled and whether it was cancelled. */
function endless(chunk = 64 * KiB) {
  const seen = { pulls: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      seen.pulls++
      c.enqueue(new Uint8Array(chunk))
    },
    cancel() {
      seen.cancelled = true
    },
  })
  return { body, seen }
}

const post = (body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request('http://backend.test/api/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit)

describe('readCapped', () => {
  it('returns the bytes of a body under the cap', async () => {
    const out = await readCapped(post('hola'), 10)
    expect(new TextDecoder().decode(out!)).toBe('hola')
  })

  it('🔴 stops a chunked body at the cap and cancels it, instead of reading it all', async () => {
    const { body, seen } = endless()
    expect(await readCapped(post(body), 256 * KiB)).toBeNull()
    expect(seen.cancelled).toBe(true)
    // 256 KiB in 64 KiB chunks: the fifth chunk crosses it. A few more may be
    // queued by the stream, never an unbounded number.
    expect(seen.pulls).toBeLessThan(10)
  })

  it('refuses a declared Content-Length over the cap without reading a byte', async () => {
    const { body, seen } = endless()
    expect(await readCapped(post(body, { 'content-length': String(1024 * KiB) }), 256 * KiB)).toBeNull()
    expect(seen.pulls).toBeLessThanOrEqual(1) // what the Request may prefetch
  })
})

describe('withCappedBody', () => {
  it('🔴 refuses a chunked JSON body over the cap', async () => {
    const { body } = endless()
    expect(await withCappedBody(post(body, { 'content-type': 'application/json' }), 256 * KiB)).toBeNull()
  })

  it('hands on a JSON body under the cap, readable once more', async () => {
    const req = await withCappedBody(
      post('{"a":1}', { 'content-type': 'application/json', authorization: 'JWT t' }),
      256 * KiB,
    )
    expect(req).not.toBeNull()
    expect(req!.headers.get('authorization')).toBe('JWT t')
    expect(req!.method).toBe('POST')
    await expect(req!.json()).resolves.toEqual({ a: 1 })
  })

  it('leaves multipart alone: busboy bounds it, and media can be 200 MB', async () => {
    const { body, seen } = endless()
    const req = post(body, { 'content-type': 'multipart/form-data; boundary=x' })
    expect(await withCappedBody(req, 256 * KiB)).toBe(req)
    expect(seen.cancelled).toBe(false)
  })

  it('leaves a GET alone', async () => {
    const req = new Request('http://backend.test/api/x')
    expect(await withCappedBody(req, 1)).toBe(req)
  })
})
