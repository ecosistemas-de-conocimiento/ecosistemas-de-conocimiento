/**
 * 🔴 Payload's REST writes see a body only after it was counted under the cap
 * (audit 2026-11-10, C-03). Payload calls `req.text()` on JSON before any
 * access check, so the count has to come first, here. A multipart label skips
 * the count only on an upload route, and only for a signed-in caller
 * (re-audit 2026-11-10, N2).
 */

import { addDataAndFileToRequest } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen: Array<{ method: string; text: string }> = []
const handler = vi.fn(async (req: Request) => {
  seen.push({ method: req.method, text: await req.text() })
  return Response.json({ ok: true })
})
vi.mock('@payloadcms/next/routes', () => {
  const build = () => (req: Request) => handler(req)
  return { REST_OPTIONS: build, REST_GET: build, REST_PUT: build, REST_POST: build, REST_PATCH: build, REST_DELETE: build }
})
vi.mock('@payload-config', () => ({ default: {} }))
const auth = vi.fn(async (_: { headers: Headers }): Promise<{ user: unknown }> => ({ user: null }))
vi.mock('payload', async (original) => ({
  ...(await original<typeof import('payload')>()),
  getPayload: async () => ({ auth }),
}))

import { API_BODY_MAX_BYTES } from '@/lib/bodyCap'

const MiB = 1024 * 1024

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

/** A chunked body of `total` bytes that records how many were pulled. */
function counted(total: number, head = new Uint8Array(0)) {
  const seen = { bytes: 0 }
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      if (head.byteLength) c.enqueue(head)
    },
    pull(c) {
      if (sent >= total) return c.close()
      const n = Math.min(MiB, total - sent)
      sent += n
      seen.bytes = sent
      c.enqueue(new Uint8Array(n).fill(0x61))
    },
  })
  return { body, seen }
}

const req = (
  method: string,
  body: BodyInit | ReadableStream<Uint8Array>,
  type = 'application/json',
  path = '/api/documents/1',
) =>
  new Request(`http://backend.test${path}`, {
    method,
    body,
    headers: { 'content-type': type },
    duplex: 'half',
  } as RequestInit)

const slugOf = (path: string) => ({ params: Promise.resolve({ slug: path.slice('/api/'.length).split('/') }) })

/** busboy with the limits `payload.config.ts` sets, the way Payload's own handlers call it. */
const parseLikePayload = async (r: Request) => {
  const limits = { fileSize: 200 * 1000 * 1000 + 1, files: 1, fields: 8, fieldSize: MiB, parts: 10 }
  const pr = Object.assign(r, { payload: { config: { upload: { limits } }, logger: console } })
  await addDataAndFileToRequest(pr as never)
  const { file, data } = pr as unknown as { file?: { size: number }; data?: unknown }
  return Response.json({ size: file?.size ?? null, data: data ?? null })
}

beforeEach(() => {
  seen.length = 0
  handler.mockClear()
  auth.mockClear()
  auth.mockResolvedValue({ user: null })
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

  it('🔴 an anonymous multipart-labelled 64 MiB body to a custom endpoint is 413, not read to the end', async () => {
    const route = await import('./route')
    for (const [method, path] of [
      ['POST', '/api/sugerencias'],
      ['PATCH', '/api/estudiante/perfil'],
      ['PATCH', '/api/documents/1/anonimizacion'],
    ] as const) {
      const { body, seen: pulled } = counted(64 * MiB)
      const res = await route[method](req(method, body, 'multipart/form-data; boundary=x', path), slugOf(path))
      expect(res.status, path).toBe(413)
      expect(pulled.bytes, path).toBeLessThan(API_BODY_MAX_BYTES + 4 * MiB)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('counts an admin-panel form (multipart `_payload`) and Payload still parses the copy', async () => {
    handler.mockImplementationOnce(parseLikePayload)
    const { PATCH } = await import('./route')
    const form = '--b\r\nContent-Disposition: form-data; name="_payload"\r\n\r\n{"title":"Ñandú"}\r\n--b--\r\n'
    const res = await PATCH(req('PATCH', form, 'multipart/form-data; boundary=b'), args)
    expect(await res.json()).toEqual({ size: null, data: { title: 'Ñandú' } })
  })

  it('🔴 an anonymous upload to /api/media is 403 before busboy reads it', async () => {
    const { POST } = await import('./route')
    const { body, seen: pulled } = counted(64 * MiB)
    const res = await POST(req('POST', body, 'multipart/form-data; boundary=x', '/api/media'), slugOf('/api/media'))
    expect(res.status).toBe(403)
    expect(pulled.bytes).toBeLessThan(4 * MiB)
    expect(handler).not.toHaveBeenCalled()
  })

  it('a deactivated account gets the same 403', async () => {
    auth.mockResolvedValue({ user: { id: 1, isActive: false } })
    const { PATCH } = await import('./route')
    const res = await PATCH(req('PATCH', 'x', 'Multipart/Form-Data; boundary=x', '/api/media/1'), slugOf('/api/media/1'))
    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('a signed-in POST /api/media over 8 MiB reaches Payload\'s parser, uncounted', async () => {
    auth.mockResolvedValue({ user: { id: 1, isActive: true } })
    handler.mockImplementationOnce(parseLikePayload)
    const { POST } = await import('./route')
    const size = API_BODY_MAX_BYTES + MiB
    const head = new TextEncoder().encode(
      '--x\r\nContent-Disposition: form-data; name="file"; filename="a.m4a"\r\nContent-Type: audio/mp4\r\n\r\n',
    )
    const tail = new TextEncoder().encode('\r\n--x--\r\n')
    // The file, then its closing boundary: `counted` sends `head` and then the bytes.
    const { body: file } = counted(size, head)
    const reader = file.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await reader.read()
        if (done) {
          c.enqueue(tail)
          return c.close()
        }
        c.enqueue(value)
      },
    })
    const res = await POST(req('POST', body, 'multipart/form-data; boundary=x', '/api/media'), slugOf('/api/media'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size, data: null })
    expect(auth).toHaveBeenCalledOnce()
  })
})

/** A request whose handler stays inside Payload until `finish` is called. */
function held() {
  let finish!: (r: Response | Error) => void
  const done = new Promise<Response>((resolve, reject) => {
    finish = (r) => (r instanceof Error ? reject(r) : resolve(r))
  })
  return { done, finish }
}

const upload = () => req('POST', 'x', 'multipart/form-data; boundary=x', '/api/media')

describe('uploads at once per account (re-audit 2026-11-10, C-03)', () => {
  const as = (id: number) => auth.mockResolvedValue({ user: { id, collection: 'users', isActive: true } })

  it('🔴 the third concurrent upload of one account is 429 with Retry-After; another account is unaffected', async () => {
    const { POST } = await import('./route')
    const { DEFAULT_UPLOADS_PER_USER } = await import('@/lib/uploadSlots')
    expect(DEFAULT_UPLOADS_PER_USER).toBe(2)
    const slow = [held(), held(), held()]
    let next = 0
    handler.mockImplementation(() => slow[next++].done)
    as(1)
    const first = POST(upload(), slugOf('/api/media'))
    const second = POST(upload(), slugOf('/api/media'))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))

    const third = await POST(upload(), slugOf('/api/media'))
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBe('5')
    expect(handler).toHaveBeenCalledTimes(2)

    as(2)
    const other = POST(upload(), slugOf('/api/media'))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3))

    for (const s of slow) s.finish(Response.json({ ok: true }))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await other).status).toBe(200)
  })

  it('🔴 the slot comes back after a success and after a thrown error', async () => {
    const { POST } = await import('./route')
    const { uploadSlotsHeld } = await import('@/lib/uploadSlots')
    as(3)
    handler.mockImplementation(async () => Response.json({ ok: true }))
    for (let i = 0; i < 3; i++) expect((await POST(upload(), slugOf('/api/media'))).status).toBe(200)
    expect(uploadSlotsHeld('users:3')).toBe(0)

    handler.mockImplementation(async () => {
      throw new Error('busboy blew up')
    })
    for (let i = 0; i < 3; i++) await expect(POST(upload(), slugOf('/api/media'))).rejects.toThrow('busboy blew up')
    expect(uploadSlotsHeld('users:3')).toBe(0)

    handler.mockImplementation(async () => Response.json({ ok: true }))
    expect((await POST(upload(), slugOf('/api/media'))).status).toBe(200)
  })

  it('UPLOAD_MAX_CONCURRENT_PER_USER tunes it; junk falls back to 2', async () => {
    const { uploadsPerUser } = await import('@/lib/uploadSlots')
    expect(uploadsPerUser({ UPLOAD_MAX_CONCURRENT_PER_USER: '4' })).toBe(4)
    for (const v of [undefined, '', '0', '-1', '1.5', 'dos']) {
      expect(uploadsPerUser({ UPLOAD_MAX_CONCURRENT_PER_USER: v }), String(v)).toBe(2)
    }
  })
})

describe('a stalled body (re-audit 2026-11-10, C-03)', () => {
  it('🔴 a JSON write that stops sending is 408, and Payload never sees it', async () => {
    vi.stubEnv('API_BODY_IDLE_TIMEOUT_MS', '50')
    try {
      const { PATCH } = await import('./route')
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) return new Promise<void>(() => {})
          sent = true
          c.enqueue(new TextEncoder().encode('{"name":'))
        },
      })
      const res = await PATCH(req('PATCH', body), args)
      expect(res.status).toBe(408)
      expect(handler).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
