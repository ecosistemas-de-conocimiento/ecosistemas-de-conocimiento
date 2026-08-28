import { describe, expect, it } from 'vitest'

import {
  EcosystemNotVisibleError,
  ecosystemMetrics,
  type EcosystemMetrics,
} from './ecosystemMetrics'

/**
 * These pin two different promises, and both are load-bearing:
 *
 *   1. THE NUMBERS ARE THE ECOSISTEMA'S, not the caller's. That is the bug this
 *      endpoint exists to fix — a platform admin counting through the ordinary
 *      REST list gets their OWN conversations back, silently.
 *   2. THE NUMBERS ARE ALL THAT COMES BACK. The counting runs elevated, so the
 *      only thing standing between an admin and everyone's private chat history
 *      is that the response has no row in it. `no content ever reaches the
 *      response body` below is the test that keeps that true as this file grows.
 */

// ---------------------------------------------------------------------------
// A fake Payload that answers by collection
// ---------------------------------------------------------------------------

type Call = { collection: string; where: unknown; overrideAccess: unknown }

interface World {
  /** Ecosistemas that exist AND are active, by id. */
  organizations: Record<string, { id: number; name: string; slug: string }>
  /** Organization ids each user id holds an active membership in. */
  memberships: Record<string, number[]>
  /** What `count` should answer, keyed by collection. Default 0. */
  counts?: (collection: string, where: unknown) => number
}

const makePayload = (world: World) => {
  const counted: Call[] = []
  const found: Call[] = []

  const payload = {
    count: async ({
      collection,
      where,
      overrideAccess,
    }: {
      collection: string
      where?: unknown
      overrideAccess?: unknown
    }) => {
      counted.push({ collection, where, overrideAccess })
      return { totalDocs: world.counts?.(collection, where) ?? 0 }
    },
    find: async ({
      collection,
      where,
      overrideAccess,
    }: {
      collection: string
      where?: unknown
      overrideAccess?: unknown
    }) => {
      found.push({ collection, where, overrideAccess })

      if (collection === 'organizations') {
        // Two shapes reach here: the metrics lookup (`id equals`, from this
        // file) and `organizationIdsForUser`'s hydration (`id in`).
        const clauses = (where as { and?: Array<Record<string, never>> })?.and ?? []
        const idClause = clauses.find((c) => 'id' in c) as
          | { id?: { equals?: unknown; in?: unknown[] } }
          | undefined
        if (idClause?.id?.equals !== undefined) {
          const org = world.organizations[String(idClause.id.equals)]
          return { docs: org ? [{ ...org, isActive: true }] : [] }
        }
        const ids = (idClause?.id?.in ?? []).map(String)
        return {
          docs: ids
            .map((id) => world.organizations[id])
            .filter(Boolean)
            .map((org) => ({ ...org, isActive: true })),
        }
      }

      if (collection === 'memberships') {
        const clauses = (where as { and?: Array<Record<string, never>> })?.and ?? []
        const userClause = clauses.find((c) => 'user' in c) as
          | { user?: { equals?: unknown } }
          | undefined
        const orgIds = world.memberships[String(userClause?.user?.equals)] ?? []
        return {
          docs: orgIds.map((organization, i) => ({
            id: i + 1,
            user: userClause?.user?.equals,
            organization,
            role: 'member',
            isActive: true,
          })),
        }
      }

      return { docs: [] }
    },
  }

  // The fake only implements what this file calls; the cast keeps the test
  // honest about that rather than stubbing the whole Payload surface.
  return { payload: payload as never, counted, found }
}

const ACME = { id: 7, name: 'Acme', slug: 'acme' }
const OTRO = { id: 9, name: 'Otro', slug: 'otro' }

const world = (over: Partial<World> = {}): World => ({
  organizations: { '7': ACME, '9': OTRO },
  memberships: { '100': [7] },
  ...over,
})

const admin = { id: 1, isPlatformAdmin: true, isActive: true }
const member = { id: 100, isActive: true }
const stranger = { id: 200, isActive: true }

const run = (w: World, user: unknown, organizationId: number | string = 7) => {
  const { payload, counted, found } = makePayload(w)
  return {
    counted,
    found,
    result: ecosystemMetrics({ payload, organizationId, user }),
  }
}

// ---------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------

describe('who may ask for an ecosistema’s numbers', () => {
  it('a platform admin may ask about an ecosistema they do not belong to', async () => {
    // The whole point: an admin holds no membership anywhere, and that is
    // exactly why their own access rules under-count.
    const { result } = run(world({ memberships: {} }), admin)
    await expect(result).resolves.toMatchObject({ ecosystem: { id: '7', slug: 'acme' } })
  })

  it('a member may ask about their own ecosistema', async () => {
    const { result } = run(world(), member)
    await expect(result).resolves.toMatchObject({ ecosystem: { id: '7' } })
  })

  it('🔴 a member may NOT ask about an ecosistema they do not belong to', async () => {
    const { result } = run(world(), member, 9)
    await expect(result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 someone with no memberships at all is refused, not given everything', async () => {
    // The empty-list trap: `{ organization: { in: [] } }` optimising away into
    // "no constraint" is how a no-tenant user reads every tenant.
    const { result } = run(world(), stranger)
    await expect(result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 a deactivated account is refused even if it is a platform admin', async () => {
    // Deactivation is the revoke switch. It has to win over the admin flag.
    const { result } = run(world(), { ...admin, isActive: false })
    await expect(result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('nobody signed in is refused', async () => {
    await expect(run(world(), null).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('an unknown ecosistema is refused', async () => {
    const { result } = run(world(), admin, 4242)
    await expect(result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('a malformed id is refused rather than crashing', async () => {
    // Postgres raises a cast error on `id = 'abc'`; that must look like any
    // other miss, not like a 500.
    const { payload } = makePayload(world())
    const exploding = {
      ...(payload as unknown as Record<string, unknown>),
      find: async () => {
        throw new Error('invalid input syntax for type integer')
      },
    }
    await expect(
      ecosystemMetrics({ payload: exploding as never, organizationId: 'abc', user: admin }),
    ).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 refusals are indistinguishable from each other', async () => {
    // 404-shaped, one message. A distinct "not yours" would confirm the
    // ecosistema exists and make this an enumeration oracle over every tenant.
    const notMine = await run(world(), member, 9).result.catch((e: Error) => e.message)
    const missing = await run(world(), member, 4242).result.catch((e: Error) => e.message)
    const inactiveUser = await run(world(), { ...member, isActive: false }).result.catch(
      (e: Error) => e.message,
    )
    expect(new Set([notMine, missing, inactiveUser]).size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 🔴 The guarantee
// ---------------------------------------------------------------------------

/** Every `path -> value` leaf in the response, flattened. */
const leaves = (value: unknown, path = ''): Array<[string, unknown]> => {
  if (value === null || typeof value !== 'object') return [[path, value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, path ? `${path}.${k}` : k),
  )
}

describe('🔴 no conversation content ever reaches the response body', () => {
  it('every leaf is a number, except the ecosistema’s own name and slug', async () => {
    // ⚠ THIS IS THE TEST THAT KEEPS THE ELEVATION SAFE. The counting runs with
    // `overrideAccess: true`, so an admin's read is NOT narrowed to their own
    // conversations. What stops that from being a content leak is that the
    // response has no row in it. If someone adds `recentMessages`, a rating
    // `comment`, or a "who talked to whom" list, this fails — which is the
    // whole reason it is written as a shape assertion and not a field list.
    const { result } = run(world({ counts: () => 3 }), admin)
    const body = await result

    const stringPaths = leaves(body)
      .filter(([, v]) => typeof v === 'string')
      .map(([p]) => p)
      .sort()

    expect(stringPaths).toEqual(['ecosystem.id', 'ecosystem.name', 'ecosystem.slug'])

    for (const [path, value] of leaves(body)) {
      if (path.startsWith('ecosystem.')) continue
      expect(
        typeof value === 'number' || value === null,
        `${path} is not a number — see the file header`,
      ).toBe(true)
    }
  })

  it('🔴 no session, message or rating ROW is ever loaded', async () => {
    // Counting via `find` would materialize the rows — message text, rating
    // comments and all — inside a process that then serializes an object built
    // from them. `count` returns `{ totalDocs }` and cannot.
    const { found, result } = run(world({ counts: () => 5 }), admin)
    await result
    expect(found.map((c) => c.collection)).not.toContain('sessions')
    expect(found.map((c) => c.collection)).not.toContain('messages')
    expect(found.map((c) => c.collection)).not.toContain('ratings')
    expect(found.map((c) => c.collection)).not.toContain('documents')
  })
})

// ---------------------------------------------------------------------------
// How the counting is done
// ---------------------------------------------------------------------------

describe('the counting', () => {
  it('🔴 every count is elevated — the caller’s own rules are what under-count', async () => {
    const { counted, result } = run(world({ counts: () => 1 }), admin)
    await result
    expect(counted.length).toBeGreaterThan(0)
    for (const call of counted) expect(call.overrideAccess).toBe(true)
  })

  it('🔴 every count is scoped to the one ecosistema that was asked for', async () => {
    // Elevation removes the access filter, so the tenant filter has to be in
    // the query itself. A count with no `organization` in it is a cross-tenant
    // total wearing a tenant's label.
    const { counted, result } = run(world({ counts: () => 1 }), admin)
    await result
    for (const call of counted) {
      expect(JSON.stringify(call.where)).toContain('organization')
      expect(JSON.stringify(call.where)).toContain('7')
    }
  })

  it('messages are scoped through their session, since they carry no organization', async () => {
    const { counted, result } = run(world({ counts: () => 1 }), admin)
    await result
    const messages = counted.filter((c) => c.collection === 'messages')
    expect(messages).toHaveLength(1)
    expect(messages[0].where).toEqual({ 'session.organization': { equals: 7 } })
  })

  it('counts conversations and messages independently of each other', async () => {
    const { result } = run(
      world({
        counts: (collection) =>
          collection === 'sessions' ? 12 : collection === 'messages' ? 61 : 0,
      }),
      admin,
    )
    await expect(result).resolves.toMatchObject({
      conversations: { sessions: 12, messages: 61 },
    })
  })
})

describe('documents', () => {
  it('breaks the total down by publication status, always with all four keys', async () => {
    const { result } = run(
      world({
        counts: (collection, where) => {
          if (collection !== 'documents') return 0
          const json = JSON.stringify(where)
          if (json.includes('"published"')) return 8
          if (json.includes('"draft"')) return 5
          if (json.includes('publicationStatus')) return 0
          return 0
        },
      }),
      admin,
    )
    const { documents } = await result
    expect(documents.byPublicationStatus).toEqual({
      draft: 5,
      publishing: 0,
      published: 8,
      unpublishing: 0,
    })
  })

  it('derives `inProgress` by exclusion, so a new pipeline state still counts', async () => {
    // 10 documents, 6 settled (ready / n-a / failed) ⇒ 4 still moving. Listing
    // the in-flight states positively would go stale silently the next time the
    // pipeline grows one.
    const { result } = run(
      world({
        counts: (collection, where) => {
          if (collection !== 'documents') return 0
          const json = JSON.stringify(where)
          // ⚠ Match the SETTLED set first. Its `in` list also contains
          // "failed", so a looser test for that word matches both queries.
          if (json.includes('"ingestStatus":{"in"')) return 6
          if (json.includes('"ingestStatus":{"equals":"failed"}')) return 2
          if (json.includes('publicationStatus')) return 0
          return 10
        },
      }),
      admin,
    )
    const { documents } = await result
    expect(documents.total).toBe(10)
    expect(documents.failed).toBe(2)
    expect(documents.inProgress).toBe(4)
  })

  it('never reports a negative `inProgress`', async () => {
    const { result } = run(
      world({
        counts: (collection, where) => {
          if (collection !== 'documents') return 0
          const json = JSON.stringify(where)
          if (json.includes('ingestStatus')) return 99
          if (json.includes('publicationStatus')) return 0
          return 1
        },
      }),
      admin,
    )
    expect((await result).documents.inProgress).toBe(0)
  })
})

describe('ratings', () => {
  const withStars = (byStars: Record<number, number>) =>
    run(
      world({
        counts: (collection, where) => {
          if (collection !== 'ratings') return 0
          const match = /"stars":\{"equals":(\d)\}/.exec(JSON.stringify(where))
          return match ? (byStars[Number(match[1])] ?? 0) : 0
        },
      }),
      admin,
    ).result

  it('counts stars into five buckets and averages them', async () => {
    // 2×5 + 1×3 = 13 over 3 ratings.
    const { ratings } = await withStars({ 3: 1, 5: 2 })
    expect(ratings.byStars).toEqual([0, 0, 1, 0, 2])
    expect(ratings.total).toBe(3)
    expect(ratings.average).toBeCloseTo(13 / 3)
  })

  it('averages to null rather than 0 when nobody has rated anything', async () => {
    // 0 stars average would render as "promedio 0.0 de 5" — an ecosistema with
    // no feedback would look like an ecosistema everybody hated.
    const { ratings } = await withStars({})
    expect(ratings.total).toBe(0)
    expect(ratings.average).toBeNull()
  })

  it('🔴 never asks for a rating’s comment, not even to sample it', async () => {
    // Comments are restricted to their author and Investigador-and-up. Star
    // counts are tenant-wide. The aggregate carries the second and never the
    // first, and it cannot carry the first because it never loads a row.
    const { counted, result } = run(world({ counts: () => 1 }), admin)
    const body: EcosystemMetrics = await result
    for (const call of counted.filter((c) => c.collection === 'ratings')) {
      expect(JSON.stringify(call.where)).not.toContain('comment')
    }
    expect(JSON.stringify(body)).not.toContain('comment')
  })
})
