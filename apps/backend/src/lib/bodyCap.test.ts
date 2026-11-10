/**
 * 🔴 `lib/bodyCap.ts`: a body is counted while it is read and dropped at the
 * cap, whether or not it declares a `Content-Length` (audit 2026-11-10, C-03).
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BodyTimeoutError, bodyTimeouts, isUploadRoute, readCapped, withCappedBody } from './bodyCap'

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

const post = (
  body: BodyInit | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  url = 'http://backend.test/api/x',
  method = 'POST',
) => new Request(url, { method, body, headers, duplex: 'half' } as RequestInit)

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

  it('leaves multipart to an upload route alone: busboy bounds it, and media can be 200 MB', async () => {
    const { body, seen } = endless()
    const req = post(body, { 'content-type': 'multipart/form-data; boundary=x' }, 'http://backend.test/api/media')
    expect(await withCappedBody(req, 256 * KiB)).toBe(req)
    expect(seen.cancelled).toBe(false)
  })

  it('🔴 counts multipart anywhere else, in any letter case (re-audit N2)', async () => {
    for (const type of ['multipart/form-data; boundary=x', 'Multipart/Form-Data; boundary=x', 'MULTIPART/mixed']) {
      const { body, seen } = endless()
      const req = post(body, { 'content-type': type }, 'http://backend.test/api/sugerencias')
      expect(await withCappedBody(req, 256 * KiB), type).toBeNull()
      expect(seen.cancelled, type).toBe(true)
    }
  })

  it('hands on multipart under the cap off an upload route, byte for byte', async () => {
    const form = '--x\r\nContent-Disposition: form-data; name="_payload"\r\n\r\n{"a":1}\r\n--x--\r\n'
    const req = await withCappedBody(post(form, { 'content-type': 'multipart/form-data; boundary=x' }), 256 * KiB)
    expect(req!.headers.get('content-type')).toBe('multipart/form-data; boundary=x')
    expect(await req!.text()).toBe(form)
  })

  it('leaves a GET alone', async () => {
    const req = new Request('http://backend.test/api/x')
    expect(await withCappedBody(req, 1)).toBe(req)
  })
})

describe('isUploadRoute', () => {
  const at = (method: string, p: string) => new Request(`http://backend.test${p}`, { method })

  it('is create and update-by-id on media, nothing else', () => {
    expect(isUploadRoute(at('POST', '/api/media'))).toBe(true)
    expect(isUploadRoute(at('PATCH', '/api/media/12'))).toBe(true)
    expect(isUploadRoute(at('post', '/api/media?depth=0'))).toBe(true)
    for (const [method, p] of [
      ['PATCH', '/api/media'],
      ['POST', '/api/media/12'],
      ['POST', '/api/media/12/duplicate'],
      ['PATCH', '/api/media/12/x'],
      ['PUT', '/api/media/12'],
      ['POST', '/api/sugerencias'],
      ['POST', '/api/mediax'],
      ['POST', '/api/documents'],
      ['PATCH', '/api/documents/1/anonimizacion'],
    ]) {
      expect(isUploadRoute(at(method, p)), `${method} ${p}`).toBe(false)
    }
  })

  it('🔴 media is the only upload collection: a new one must be added there', () => {
    const dir = path.resolve(__dirname, '../collections')
    const uploads = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .filter((f) => /^ {2}upload: /m.test(readFileSync(path.join(dir, f), 'utf8')))
    expect(uploads).toEqual(['Media.ts'])
  })
})

/** A body that sends `first` and then never another byte, or closes. */
function stalled(first = new Uint8Array([0x7b])) {
  const seen = { cancelled: false }
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(first)
        return
      }
      return new Promise<void>(() => {})
    },
    cancel() {
      seen.cancelled = true
    },
  })
  return { body, seen }
}

/** One byte every `everyMs`, forever. */
function trickle(everyMs: number) {
  const seen = { cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull: (c) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!seen.cancelled) c.enqueue(new Uint8Array(1))
          resolve()
        }, everyMs),
      ),
    cancel() {
      seen.cancelled = true
    },
  })
  return { body, seen }
}

describe('a slow body (re-audit 2026-11-10, C-03)', () => {
  it('🔴 a body that stalls is dropped after the idle bound, and its stream cancelled', async () => {
    const { body, seen } = stalled()
    const started = Date.now()
    await expect(readCapped(post(body), 1024, { idleMs: 50, totalMs: 10_000 })).rejects.toBeInstanceOf(BodyTimeoutError)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(seen.cancelled).toBe(true)
  })

  it('🔴 a body that trickles under the idle bound still stops at the total one', async () => {
    const { body, seen } = trickle(10)
    const started = Date.now()
    await expect(readCapped(post(body), 1024 * 1024, { idleMs: 1_000, totalMs: 150 })).rejects.toBeInstanceOf(
      BodyTimeoutError,
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(seen.cancelled).toBe(true)
  })

  it('🔴 withCappedBody throws the same for a stalled JSON write', async () => {
    const { body } = stalled()
    const req = post(body, { 'content-type': 'application/json' })
    await expect(withCappedBody(req, 1024, { idleMs: 50, totalMs: 10_000 })).rejects.toBeInstanceOf(BodyTimeoutError)
  })

  it('a body that keeps coming within both bounds is read whole', async () => {
    const chunks = [new Uint8Array([0x61]), new Uint8Array([0x62])]
    const body = new ReadableStream<Uint8Array>({
      pull: (c) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            const next = chunks.shift()
            if (next) c.enqueue(next)
            else c.close()
            resolve()
          }, 10),
        ),
    })
    const out = await readCapped(post(body), 1024, { idleMs: 500, totalMs: 2_000 })
    expect(new TextDecoder().decode(out!)).toBe('ab')
  })

  it('30 s idle and 120 s total by default; the env tunes both, junk falls back', () => {
    expect(bodyTimeouts({})).toEqual({ idleMs: 30_000, totalMs: 120_000 })
    expect(bodyTimeouts({ API_BODY_IDLE_TIMEOUT_MS: '5000', API_BODY_TOTAL_TIMEOUT_MS: '60000' })).toEqual({
      idleMs: 5_000,
      totalMs: 60_000,
    })
    expect(bodyTimeouts({ API_BODY_IDLE_TIMEOUT_MS: '0', API_BODY_TOTAL_TIMEOUT_MS: 'x' })).toEqual({
      idleMs: 30_000,
      totalMs: 120_000,
    })
  })
})
