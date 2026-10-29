/**
 * The live pass-through: auth first, the session id bound to the caller, the
 * partial text returned with `no-store` and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let currentUser: { id: string; isPlatformAdmin?: boolean; isActive?: boolean } | null = { id: 'u42' }
let memberOf: string[] = ['7']
let liveMic = true
/** Conversations the caller may read, by id → their ecosistema. */
let conversations: Record<string, string> = { '55': '7' }
const featureOrgs: string[] = []

vi.mock('payload', () => ({
  getPayload: async () => ({
    auth: async () => ({ user: currentUser }),
    findByID: async ({ collection, id, overrideAccess }: { collection: string; id: string; overrideAccess?: boolean }) => {
      if (collection !== 'sessions' || overrideAccess !== false) throw new Error('unexpected read')
      const organization = conversations[String(id)]
      if (!organization) throw Object.assign(new Error('Not Found'), { status: 404 })
      return { id, organization: Number(organization) }
    },
  }),
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/permissions', async (orig) => ({ ...(await orig<object>()), organizationIdsForUser: async () => memberOf }))
vi.mock('@/lib/features', () => ({
  featureEnabled: async (_p: unknown, org: unknown, key: string) => {
    featureOrgs.push(String(org))
    return key === 'liveMic' ? liveMic : true
  },
}))

const { POST, DELETE } = await import('./route')

const ctx = (sid: string) => ({ params: Promise.resolve({ sid }) })
const SID = 'abcdef12-3456'

describe('/api/live/:sid', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    currentUser = { id: 'u42' }
    memberOf = ['7']
    liveMic = true
    conversations = { '55': '7' }
    featureOrgs.length = 0
    process.env.AUDIO_SERVICE_URL = 'http://audio:8080/'
    process.env.AUDIO_SERVICE_API_KEY = 'k'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('refuses an anonymous caller before touching audio-service', async () => {
    currentUser = null
    const res = await POST(new Request('http://x/api/live/' + SID + '?organization=7', { method: 'POST', body: 'a' }), ctx(SID))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('🔴 refuses a deactivated account whose token is still valid, before touching audio-service', async () => {
    currentUser = { id: 'u42', isActive: false }
    const res = await POST(new Request('http://x/api/live/' + SID + '?organization=7', { method: 'POST', body: 'a' }), ctx(SID))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed session id', async () => {
    const res = await POST(new Request('http://x?organization=7', { method: 'POST', body: 'a' }), ctx('../x'))
    expect(res.status).toBe(400)
  })

  it('prefixes the caller id and passes the partial text through uncached', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ committed: 'hola', tentative: 'mundo' }), { status: 200 }),
    )
    const res = await POST(
      new Request(`http://x/api/live/${SID}?organization=7&offset=12`, { method: 'POST', body: new Uint8Array([1, 2]) }),
      ctx(SID),
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`http://audio:8080/v1/live/u42.${SID}/chunk?offset=12`)
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ committed: 'hola', tentative: 'mundo' })
  })

  it('refuses an oversized slice without forwarding it', async () => {
    const res = await POST(
      new Request(`http://x/api/live/${SID}?organization=7`, { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) }),
      ctx(SID),
    )
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes an upstream gap through so the client can resend', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'live_gap' }), { status: 409 }))
    const res = await POST(new Request(`http://x/api/live/${SID}?organization=7&offset=5`, { method: 'POST', body: 'a' }), ctx(SID))
    expect(res.status).toBe(409)
  })

  it('DELETE drops the caller-bound session', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx(SID))
    expect(res.status).toBe(204)
    expect(fetchMock.mock.calls[0][0]).toBe(`http://audio:8080/v1/live/u42.${SID}`)
  })

  const post = (query: string) =>
    POST(new Request(`http://x/api/live/${SID}${query}`, { method: 'POST', body: 'a' }), ctx(SID))

  it('🔴 403s when the ecosistema switched liveMic off, before touching audio-service', async () => {
    liveMic = false
    const res = await post('?organization=7')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'live_disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('🔴 403s for an ecosistema the caller is not a member of', async () => {
    const res = await post('?organization=8')
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s without an ecosistema', async () => {
    expect((await post('')).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a platform admin may name any ecosistema; the switch still applies', async () => {
    currentUser = { id: 'u1', isPlatformAdmin: true }
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    expect((await post('?organization=99')).status).toBe(200)
    liveMic = false
    expect((await post('?organization=99')).status).toBe(403)
  })

  it('DELETE is never gated: stopping always works', async () => {
    liveMic = false
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx(SID))
    expect(res.status).toBe(204)
  })

  it('🔴 with a conversation, its ecosistema is the one checked — not the one the caller named', async () => {
    memberOf = ['7', '8']
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    expect((await post('?organization=8&conversation=55')).status).toBe(200)
    expect(featureOrgs).toEqual(['7'])
  })

  it('🔴 a conversation the caller cannot read is a 403, whatever ecosistema is named', async () => {
    const res = await post('?organization=7&conversation=56')
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s a malformed conversation id', async () => {
    expect((await post('?organization=7&conversation=../x')).status).toBe(400)
  })
})
