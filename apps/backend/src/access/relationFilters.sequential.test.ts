/**
 * 🔴 THE LOOKUPS BEHIND A FILTER THROUGH A RELATION RUN ONE AT A TIME
 * (audit 2026-11-10, D1). In parallel, every list was held at once; with
 * 20 000 ids per term that stalled the event loop for seconds. The first test
 * failed on a3c9df9f (three lookups in flight); the object-form tests fail
 * with `Promise.all` back in the per-key leaves loop (D3, checked by hand
 * 2026-11-10). The bounds themselves are measured in
 * `relationFilters.bounds.pg.test.ts`.
 */

import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { constrainRelationQueries, type QueryField } from './relationFilters'

const fields: QueryField[] = [
  { name: 'session', type: 'relationship', relationTo: 'sessions' },
  { name: 'message', type: 'relationship', relationTo: 'messages' },
]

function fakeReq(rows: number) {
  const seen = { inFlight: 0, most: 0, calls: 0, counts: 0, limit: undefined as number | undefined }
  const lookup = async <T>(answer: () => T): Promise<T> => {
    seen.inFlight++
    seen.most = Math.max(seen.most, seen.inFlight)
    await new Promise((r) => setTimeout(r, 5))
    seen.inFlight--
    return answer()
  }
  const req = {
    user: { id: 2, collection: 'users', isActive: true },
    t: (k: string) => k,
    payload: {
      collections: {
        sessions: { config: { flattenedFields: [{ name: 'title', type: 'text' }, { name: 'summary', type: 'text' }] } },
        messages: { config: { flattenedFields: [{ name: 'content', type: 'text' }] } },
      },
      count: async () => {
        seen.counts++
        return lookup(() => ({ totalDocs: rows }))
      },
      find: async ({ limit }: { limit?: number }) => {
        seen.calls++
        seen.limit = limit
        return lookup(() => {
          const n = Math.min(rows, limit ?? rows)
          return { docs: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) }
        })
      },
    },
  } as unknown as PayloadRequest
  return { req, seen }
}

const rule = constrainRelationQueries({ follow: false, fieldRule: true })
const run = (req: PayloadRequest, where: unknown) =>
  rule({ args: { where }, operation: 'read', collection: { flattenedFields: fields }, req } as never)
const terms = (n: number) => ({ or: Array.from({ length: n }, (_, i) => ({ 'session.title': { like: `t${i}` } })) })

describe('🔴 a filter through a relation reads the target one lookup at a time', () => {
  it('never has two lookups in flight', async () => {
    const { req, seen } = fakeReq(2)
    await run(req, terms(3))
    expect(seen.calls).toBe(3)
    expect(seen.most).toBe(1)
  })

  // D3: the array form above never reaches the per-key leaves loop with more
  // than one leaf. These do: one key, several leaves, and several keys in one object.
  it('object form: several leaves under one key, one lookup at a time', async () => {
    const { req, seen } = fakeReq(2)
    await run(req, { and: [{ session: { title: { like: 'a' }, summary: { like: 'b' } } }] })
    expect(seen.calls).toBe(2)
    expect(seen.most).toBe(1)
  })

  it('object form: several crossing keys in one object, one lookup at a time', async () => {
    const { req, seen } = fakeReq(2)
    await run(req, {
      and: [{ 'session.title': { like: 'a' }, 'session.summary': { like: 'b' }, message: { content: { like: 'c' } } }],
    })
    expect(seen.calls).toBe(3)
    expect(seen.most).toBe(1)
  })

  it('past the term cap: refused before any lookup', async () => {
    const { req, seen } = fakeReq(2)
    await expect(run(req, terms(6))).rejects.toMatchObject({ status: 400 })
    expect(seen.calls + seen.counts).toBe(0)
  })

  it('past the id cap: refused on the count, no row read (D2)', async () => {
    const { req, seen } = fakeReq(10_000)
    await expect(run(req, terms(1))).rejects.toThrow(/matches too many rows/)
    expect(seen.counts).toBe(1)
    expect(seen.calls).toBe(0)
  })

  it('under the id cap: the read still asks for no more than one past it', async () => {
    const { req, seen } = fakeReq(3)
    await run(req, terms(1))
    expect(seen.calls).toBe(1)
    expect(seen.limit).toBe(5001)
  })
})
