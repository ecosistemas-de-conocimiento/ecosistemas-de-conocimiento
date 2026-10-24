/**
 * The live pass-through: auth first, the session id bound to the caller, the
 * partial text returned with `no-store` and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let currentUser: { id: string } | null = { id: 'u42' }

vi.mock('payload', () => ({
  getPayload: async () => ({ auth: async () => ({ user: currentUser }) }),
}))
vi.mock('@payload-config', () => ({ default: {} }))

const { POST, DELETE } = await import('./route')

const ctx = (sid: string) => ({ params: Promise.resolve({ sid }) })
const SID = 'abcdef12-3456'

describe('/api/live/:sid', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    currentUser = { id: 'u42' }
    process.env.AUDIO_SERVICE_URL = 'http://audio:8080/'
    process.env.AUDIO_SERVICE_API_KEY = 'k'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('refuses an anonymous caller before touching audio-service', async () => {
    currentUser = null
    const res = await POST(new Request('http://x/api/live/' + SID, { method: 'POST', body: 'a' }), ctx(SID))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed session id', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: 'a' }), ctx('../x'))
    expect(res.status).toBe(400)
  })

  it('prefixes the caller id and passes the partial text through uncached', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ committed: 'hola', tentative: 'mundo' }), { status: 200 }),
    )
    const res = await POST(
      new Request(`http://x/api/live/${SID}?offset=12`, { method: 'POST', body: new Uint8Array([1, 2]) }),
      ctx(SID),
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`http://audio:8080/v1/live/u42.${SID}/chunk?offset=12`)
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ committed: 'hola', tentative: 'mundo' })
  })

  it('passes an upstream gap through so the client can resend', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'live_gap' }), { status: 409 }))
    const res = await POST(new Request(`http://x/api/live/${SID}?offset=5`, { method: 'POST', body: 'a' }), ctx(SID))
    expect(res.status).toBe(409)
  })

  it('DELETE drops the caller-bound session', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx(SID))
    expect(res.status).toBe(204)
    expect(fetchMock.mock.calls[0][0]).toBe(`http://audio:8080/v1/live/u42.${SID}`)
  })
})
