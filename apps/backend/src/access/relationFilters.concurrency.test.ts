/**
 * 🔴 ONE PERSON'S FILTERS THROUGH A RELATION: AT MOST N AT ONCE, M A MINUTE
 * (audit 2026-11-10, D2). Twenty at once from one member held another
 * person's `/api/users/me` for seconds; nothing bounded them. Every test here
 * but the controls failed before `takeRelationSlot`. Over REST, against a real
 * Postgres: `relationFilters.bounds.pg.test.ts`.
 */

import type { PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DB_POOL_CONNECTION_TIMEOUT_MS } from '../lib/dbPool'
import { resetRateLimits } from '../lib/rateLimit'
import {
  constrainRelationQueries,
  RELATION_SLOT_LEASE_MS,
  relationSlotsHeld,
  releaseRelationSlot,
  releaseRelationSlotOnError,
  type QueryField,
} from './relationFilters'

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

/** `beforeOperation` alone: the operation's query has not run yet. */
const begin = (req: PayloadRequest, where: unknown = crossing, extra: Record<string, unknown> = {}) =>
  rule({ args: { where, ...extra }, operation: 'read', collection: { flattenedFields: fields }, req } as never)

/** `afterOperation`: the operation that ran with these args has ended. */
const end = (args: unknown) => releaseRelationSlot({ args, result: undefined } as never)

/** The whole operation: the hook, the query, `afterOperation`. */
const run = async (req: PayloadRequest, where: unknown = crossing, extra: Record<string, unknown> = {}) => {
  const args = await begin(req, where, extra)
  end(args)
  return args
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

beforeEach(() => resetRateLimits())
afterEach(() => {
  vi.useRealTimers()
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

  it('🔴 the slot is held through the query itself: a third is refused while two are past their lookups', async () => {
    const first = await begin(fakeReq())
    const second = await begin(fakeReq())
    // Both lookups are done; their queries are running.
    expect(relationSlotsHeld(2)).toBe(2)
    await expect(begin(fakeReq())).rejects.toMatchObject({ status: 429 })
    end(first)
    expect(relationSlotsHeld(2)).toBe(1)
    end(second)
    end(second)
    expect(relationSlotsHeld(2)).toBe(0)
  })

  it('🔴 an error after beforeOperation frees it: afterError on REST, the lease elsewhere', async () => {
    const req = fakeReq()
    await begin(req)
    expect(relationSlotsHeld(2)).toBe(1)
    await releaseRelationSlotOnError({ req, error: new Error('statement timeout'), context: {} } as never)
    expect(relationSlotsHeld(2)).toBe(0)
    // A second call, or the args' own release after it, frees nothing more.
    const other = await begin(fakeReq())
    await releaseRelationSlotOnError({ req, error: new Error('again'), context: {} } as never)
    expect(relationSlotsHeld(2)).toBe(1)
    end(other)

    vi.useFakeTimers()
    await begin(fakeReq())
    expect(relationSlotsHeld(2)).toBe(1)
    vi.advanceTimersByTime(RELATION_SLOT_LEASE_MS - 1)
    expect(relationSlotsHeld(2)).toBe(1)
    vi.advanceTimersByTime(1)
    expect(relationSlotsHeld(2)).toBe(0)
  })

  it('🔴 a request still running past 30 s keeps its slot: a third is refused', async () => {
    // The lease was 30 s, and a stuck pool held live requests past it: three
    // ran at once at 30.5 s (audit 2026-11-10). Each checkout now fails after
    // the pool's timeout, and a request at the caps makes about 36 of them in
    // a row (5 terms × count and find, each with its access lookups, then the
    // query; inferred from the code), so the lease sits above that.
    expect(RELATION_SLOT_LEASE_MS).toBeGreaterThan(36 * DB_POOL_CONNECTION_TIMEOUT_MS)
    vi.useFakeTimers()
    const first = await begin(fakeReq())
    const second = await begin(fakeReq())
    vi.advanceTimersByTime(36 * DB_POOL_CONNECTION_TIMEOUT_MS)
    expect(relationSlotsHeld(2)).toBe(2)
    await expect(begin(fakeReq())).rejects.toMatchObject({ status: 429 })
    end(first)
    end(second)
    expect(relationSlotsHeld(2)).toBe(0)
  })

  it("a lookup's own afterOperation does not free the slot of the query it resolves", async () => {
    const opts: Opts = {}
    const req = fakeReq(opts)
    let depth = 0
    opts.nested = async () => {
      if (depth++ === 0) end(await begin(req))
    }
    const outer = await begin(req)
    expect(relationSlotsHeld(2)).toBe(1)
    end(outer)
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
