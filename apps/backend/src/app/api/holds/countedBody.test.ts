/**
 * 🔴 `/api/holds/:id` and `/api/published/:id` count the body they read
 * (re-audit 2026-11-10, N2). A multipart label skips the middleware, and
 * `request.json()` reads any size it is sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('payload', () => ({ getPayload: async () => ({ auth: async () => ({ user: { id: 1 } }) }) }))
vi.mock('@payload-config', () => ({ default: {} }))
const decideOnHold = vi.fn(async (args: { decision: string }) => ({ decision: args.decision }))
vi.mock('@/lib/holdReview', async (orig) => ({ ...(await orig<object>()), decideOnHold }))
const rejectPublished = vi.fn(async () => ({ decision: 'reject' }))
vi.mock('@/lib/rejectPublished', () => ({ rejectPublished }))
vi.mock('@/lib/aiClient', () => ({ getAdminAIClient: () => ({}) }))

import { API_BODY_MAX_BYTES } from '@/lib/bodyCap'

const MiB = 1024 * 1024
const holds = await import('./[id]/route')
const published = await import('../published/[id]/route')
const ctx = { params: Promise.resolve({ id: '1' }) }

function counted(total: number) {
  const seen = { bytes: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (seen.bytes >= total) return c.close()
      seen.bytes += MiB
      c.enqueue(new Uint8Array(MiB).fill(0x61))
    },
  })
  return { body, seen }
}

const post = (body: BodyInit | ReadableStream<Uint8Array>, type: string) =>
  new Request('http://backend.test/api/x/1', {
    method: 'POST',
    body,
    headers: { 'content-type': type },
    duplex: 'half',
  } as RequestInit)

beforeEach(() => {
  decideOnHold.mockClear()
  rejectPublished.mockClear()
})

describe.each([
  ['holds', () => holds.POST, '{"decision":"reject"}'],
  ['published', () => published.POST, '{"decision":"reject","note":"Ñandú"}'],
] as const)('/api/%s/:id', (_name, route, ok) => {
  it('🔴 a multipart-labelled 64 MiB body is 413, not read to the end', async () => {
    const { body, seen } = counted(64 * MiB)
    const res = await route()(post(body, 'multipart/form-data; boundary=x'), ctx)
    expect(res.status).toBe(413)
    expect(seen.bytes).toBeLessThan(API_BODY_MAX_BYTES + 4 * MiB)
    expect(decideOnHold).not.toHaveBeenCalled()
    expect(rejectPublished).not.toHaveBeenCalled()
  })

  it('reads a JSON body under the cap as before', async () => {
    const res = await route()(post(ok, 'application/json'), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ decision: 'reject' })
  })

  it('a body that is not JSON is still 400', async () => {
    const res = await route()(post('{nope', 'application/json'), ctx)
    expect(res.status).toBe(400)
  })
})
