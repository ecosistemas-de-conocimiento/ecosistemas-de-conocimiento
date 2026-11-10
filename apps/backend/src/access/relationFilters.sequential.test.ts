/**
 * 🔴 THE LOOKUPS BEHIND A FILTER THROUGH A RELATION RUN ONE AT A TIME
 * (audit 2026-11-10, D1). In parallel, every list was held at once; with
 * 20 000 ids per term that stalled the event loop for seconds. This failed on
 * a3c9df9f (three lookups in flight). The bounds themselves are measured in
 * `relationFilters.bounds.pg.test.ts`.
 */

import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { constrainRelationQueries, type QueryField } from './relationFilters'

const fields: QueryField[] = [{ name: 'session', type: 'relationship', relationTo: 'sessions' }]

function fakeReq(rows: number) {
  const seen = { inFlight: 0, most: 0, calls: 0, limit: undefined as number | undefined }
  const req = {
    user: { id: 2, collection: 'users', isActive: true },
    t: (k: string) => k,
    payload: {
      collections: { sessions: { config: { flattenedFields: [{ name: 'title', type: 'text' }] } } },
      find: async ({ limit }: { limit?: number }) => {
        seen.calls++
        seen.limit = limit
        seen.inFlight++
        seen.most = Math.max(seen.most, seen.inFlight)
        await new Promise((r) => setTimeout(r, 5))
        seen.inFlight--
        const n = Math.min(rows, limit ?? rows)
        return { docs: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) }
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

  it('past the term cap: refused before any lookup', async () => {
    const { req, seen } = fakeReq(2)
    await expect(run(req, terms(6))).rejects.toMatchObject({ status: 400 })
    expect(seen.calls).toBe(0)
  })

  it('past the id cap: refused, and the lookup asked for no more than one past it', async () => {
    const { req, seen } = fakeReq(10_000)
    await expect(run(req, terms(1))).rejects.toThrow(/matches too many rows/)
    expect(seen.calls).toBe(1)
    expect(seen.limit).toBe(5001)
  })
})
