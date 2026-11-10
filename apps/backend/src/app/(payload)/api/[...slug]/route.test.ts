/**
 * 🔴 Payload's REST writes see a body only after it was counted under the cap
 * (audit 2026-11-10, C-03). Payload calls `req.text()` on JSON before any
 * access check, so the count has to come first, here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen: Array<{ method: string; text: string }> = []
const handler = vi.fn(async (req: Request) => {
  seen.push({ method: req.method, text: await req.text() })
  return Response.json({ ok: true })
})
vi.mock('@payloadcms/next/routes', () => {
  const build = () => handler
  return { REST_OPTIONS: build, REST_GET: build, REST_POST: build, REST_PUT: build, REST_PATCH: build, REST_DELETE: build }
})
vi.mock('@payload-config', () => ({ default: {} }))

import { API_BODY_MAX_BYTES } from '@/lib/bodyCap'

const args = { params: Promise.resolve({ slug: ['documents', '1'] }) }

function chunked(total: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close()
      const n = Math.min(64 * 1024, total - sent)
      sent += n
      c.enqueue(new Uint8Array(n).fill(0x61))
    },
  })
}

const req = (method: string, body: BodyInit | ReadableStream<Uint8Array>, type = 'application/json') =>
  new Request('http://backend.test/api/documents/1', {
    method,
    body,
    headers: { 'content-type': type },
    duplex: 'half',
  } as RequestInit)

beforeEach(() => {
  seen.length = 0
  handler.mockClear()
})

describe('Payload REST routes', () => {
  it('🔴 a chunked JSON body over the cap is 413, and Payload never sees it', async () => {
    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', chunked(API_BODY_MAX_BYTES + 1)), args)
    expect(res.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('🔴 POST, PUT and DELETE are capped the same way', async () => {
    const route = await import('./route')
    for (const [method, fn] of [
      ['POST', route.POST],
      ['PUT', route.PUT],
      ['DELETE', route.DELETE],
    ] as const) {
      const res = await fn(req(method, chunked(API_BODY_MAX_BYTES + 1)), args)
      expect(res.status, method).toBe(413)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes a body under the cap through, byte for byte', async () => {
    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', '{"name":"Ñandú"}'), args)
    expect(res.status).toBe(200)
    expect(seen).toEqual([{ method: 'PATCH', text: '{"name":"Ñandú"}' }])
  })

  it('leaves multipart to busboy, uncounted', async () => {
    const { POST } = await import('./route')
    const res = await POST(req('POST', 'x', 'multipart/form-data; boundary=b'), args)
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })
})
