/**
 * 🔴 ONE PERSON'S FILTERS THROUGH A RELATION: AT MOST N AT ONCE, M A MINUTE
 * (audit 2026-11-10, D2). Twenty at once from one member held another
 * person's `/api/users/me` for seconds; nothing bounded them. Every test here
 * but the controls failed before `takeRelationSlot`. Over REST, against a real
 * Postgres: `relationFilters.bounds.pg.test.ts`.
 */

import type { PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetRateLimits } from '../lib/rateLimit'
import { constrainRelationQueries, relationSlotsHeld, type QueryField } from './relationFilters'

const fields: QueryField[] = [{ name: 'session', type: 'relationship', relationTo: 'sessions' }]
const rule = constrainRelationQueries({ follow: false, fieldRule: true })
const crossing = { 'session.title': { like: 't' } }

type Opts = { id?: number; rows?: number; gate?: Promise<void>; fail?: boolean; admin?: boolean; nested?: () => Promise<unknown> }

function fakeReq(o: Opts = {}) {
  const req = {
    user: { id: o.id ?? 2, collection: 'users', isActive: true, isPlatformAdmin: o.admin === true },
    t: (k: string) => k,
    context: {},
    payload: {
      collections: { sessions: { config: { flattenedFields: [{ name: 'title', type: 'text' }] } } },
      count: async () => ({ totalDocs: o.rows ?? 1 }),
      find: async () => {
        await o.gate
        if (o.nested) await o.nested()
        if (o.fail) throw new Error('database went away')
        return { docs: Array.from({ length: o.rows ?? 1 }, (_, i) => ({ id: i + 1 })) }
      },
    },
  } as unknown as PayloadRequest
  return req
}

const run = (req: PayloadRequest, where: unknown = crossing, extra: Record<string, unknown> = {}) =>
  rule({ args: { where, ...extra }, operation: 'read', collection: { flattenedFields: fields }, req } as never)

function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

beforeEach(() => resetRateLimits())
afterEach(() => {
  delete process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER
  delete process.env.QUERY_RELATION_RATELIMIT_USER_MAX
})

describe('🔴 filters through a relation: per-person concurrency', () => {
  it('a third at once is a 429 with Retry-After, at once; the two finish and free their slots', async () => {
    const g = gate()
    const a = run(fakeReq({ gate: g.promise }))
    const b = run(fakeReq({ gate: g.promise }))
    await new Promise((r) => setTimeout(r, 0))
    expect(relationSlotsHeld(2)).toBe(2)
    const third = fakeReq()
    await expect(run(third)).rejects.toMatchObject({ status: 429, name: 'RelationFilterBusy' })
    expect(third.responseHeaders?.get('Retry-After')).toBe('1')
    g.open()
    await Promise.all([a, b])
    expect(relationSlotsHeld(2)).toBe(0)
    await expect(run(fakeReq())).resolves.toBeDefined()
  })

  it('the cap is env-tunable', async () => {
    process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER = '1'
    const g = gate()
    const a = run(fakeReq({ gate: g.promise }))
    await new Promise((r) => setTimeout(r, 0))
    await expect(run(fakeReq())).rejects.toMatchObject({ status: 429 })
    g.open()
    await a
  })

  it('another person is not held by them', async () => {
    const g = gate()
    const held = [run(fakeReq({ gate: g.promise })), run(fakeReq({ gate: g.promise }))]
    await new Promise((r) => setTimeout(r, 0))
    await expect(run(fakeReq({ id: 3 }))).resolves.toBeDefined()
    g.open()
    await Promise.all(held)
  })

  it('the slot comes back on a 400 and on a throw', async () => {
    await expect(run(fakeReq({ rows: 10_000 }))).rejects.toMatchObject({ status: 400 })
    expect(relationSlotsHeld(2)).toBe(0)
    await expect(run(fakeReq({ fail: true }))).rejects.toThrow(/went away/)
    expect(relationSlotsHeld(2)).toBe(0)
  })

  it("a lookup the request runs itself reuses the request's slot", async () => {
    process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER = '1'
    const opts: Opts = {}
    const req = fakeReq(opts)
    let depth = 0
    opts.nested = async () => {
      if (depth++ === 0) await run(req)
    }
    await expect(run(req)).resolves.toBeDefined()
    expect(relationSlotsHeld(2)).toBe(0)
  })

  it('controls: no crossing, a platform admin, a server read and no user take no slot', async () => {
    process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER = '1'
    const g = gate()
    const a = run(fakeReq({ gate: g.promise }))
    await new Promise((r) => setTimeout(r, 0))
    await expect(run(fakeReq(), { title: { like: 'x' } })).resolves.toBeDefined()
    await expect(run(fakeReq({ admin: true }))).resolves.toBeDefined()
    await expect(run(fakeReq(), crossing, { overrideAccess: true })).resolves.toBeDefined()
    const anon = fakeReq()
    ;(anon as { user: unknown }).user = null
    await expect(run(anon)).resolves.toBeDefined()
    g.open()
    await a
  })
})

describe('🔴 filters through a relation: per-person rate', () => {
  it('past the minute\'s budget: 429 with Retry-After, the slot given back', async () => {
    process.env.QUERY_RELATION_RATELIMIT_USER_MAX = '3'
    for (let i = 0; i < 3; i++) await run(fakeReq())
    const req = fakeReq()
    await expect(run(req)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/Retry in \d+s/) })
    expect(Number(req.responseHeaders?.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    expect(relationSlotsHeld(2)).toBe(0)
    await expect(run(fakeReq({ id: 3 }))).resolves.toBeDefined()
  })

  it('the default is 30 a minute', async () => {
    for (let i = 0; i < 30; i++) await run(fakeReq())
    await expect(run(fakeReq())).rejects.toMatchObject({ status: 429 })
  })
})
