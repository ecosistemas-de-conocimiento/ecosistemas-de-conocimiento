/**
 * 🔴 `graph` and `combinedGraph` (`lib/features.ts`) at the graph routes:
 * off means no graph SQL runs for that ecosistema. Fake database; the handlers,
 * authorisation and the feature read are real.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { invalidateFeatures } from '../lib/features'
import { COMBINED_OFF, GRAPH_OFF, graphEntityEndpoint, graphRetrieveEndpoint, graphViewEndpoint } from './graph'

const MEMBER = { id: 1, email: 'ana@example.test', isActive: true }
const ADMIN = { id: 2, email: 'root@example.test', isActive: true, isPlatformAdmin: true }

function fakeRequest(
  url: string,
  opts: { memberOf: number[]; features: Record<number, Record<string, boolean>>; user?: unknown; body?: unknown; allOrgs?: number[] },
) {
  const sql: string[] = []
  const payload = {
    async find({ collection }: { collection: string }) {
      if (collection === 'memberships') {
        return { docs: opts.memberOf.map((id) => ({ id, organization: id, role: 'member', isActive: true })) }
      }
      if (collection === 'organizations') {
        return { docs: opts.memberOf.map((id) => ({ id, name: `Eco ${id}`, isActive: true })) }
      }
      return { docs: [] }
    },
    async findByID({ id }: { id: number }) {
      return { id, features: opts.features[Number(id)] ?? null }
    },
    db: {
      drizzle: {
        async execute(query: unknown) {
          sql.push(String((query as { queryChunks?: unknown[] })?.queryChunks?.length ?? ''))
          // authoriseCombined's admin listing reads ids first.
          if (sql.length === 1 && opts.allOrgs) return { rows: opts.allOrgs.map((id) => ({ id })) }
          return { rows: [] }
        },
      },
    },
  }
  const req = {
    user: opts.user ?? MEMBER,
    payload,
    searchParams: new URL(url, 'http://test.local').searchParams,
    routeParams: { id: '5' },
    headers: new Headers(),
    json: async () => opts.body ?? {},
  } as unknown as PayloadRequest
  return { req, sql }
}

const message = async (res: Response) =>
  ((await res.json()) as { errors?: { message?: string }[] }).errors?.[0]?.message

beforeEach(() => invalidateFeatures())

describe('graph off', () => {
  const off = { 3: { graph: false } }

  it('view → 404 before any graph SQL', async () => {
    const { req, sql } = fakeRequest('/api/graph/view?organization=3&type=tema', { memberOf: [3], features: off })
    const res = await graphViewEndpoint.handler(req)
    expect(res.status).toBe(404)
    expect(await message(res)).toBe(GRAPH_OFF)
    expect(sql).toEqual([])
  })

  it('entity → 404', async () => {
    const { req, sql } = fakeRequest('/api/graph/entity/5?organization=3', { memberOf: [3], features: off })
    expect((await graphEntityEndpoint.handler(req)).status).toBe(404)
    expect(sql).toEqual([])
  })

  it('retrieve → the empty answer the chat already handles', async () => {
    const { req, sql } = fakeRequest('/api/graph/retrieve', {
      memberOf: [3],
      features: off,
      body: { organization: 3, query: 'agua' },
    })
    const res = await graphRetrieveEndpoint.handler(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entities: [], edges: [], documents: [], terms: [] })
    expect(sql).toEqual([])
  })

  it('a platform admin gets the same 404', async () => {
    const { req } = fakeRequest('/api/graph/view?organization=3&type=tema', { memberOf: [], features: off, user: ADMIN })
    expect((await graphViewEndpoint.handler(req)).status).toBe(404)
  })

  it('still 403 for a non-member, before the switch is read', async () => {
    const { req } = fakeRequest('/api/graph/view?organization=3&type=tema', { memberOf: [4], features: off })
    expect((await graphViewEndpoint.handler(req)).status).toBe(403)
  })
})

describe('combined view', () => {
  it('🔴 404s when fewer than two of the caller’s ecosistemas allow it', async () => {
    const { req, sql } = fakeRequest('/api/graph/view?organization=all&type=tema', {
      memberOf: [3, 4],
      features: { 4: { combinedGraph: false } },
    })
    const res = await graphViewEndpoint.handler(req)
    expect(res.status).toBe(404)
    expect(await message(res)).toBe(COMBINED_OFF)
    expect(sql).toEqual([])
  })

  it('a graph switched off also leaves its ecosistema out of the combined view', async () => {
    const { req } = fakeRequest('/api/graph/view?organization=all&type=tema', {
      memberOf: [3, 4],
      features: { 3: { graph: false } },
    })
    expect((await graphViewEndpoint.handler(req)).status).toBe(404)
  })
})
