/**
 * 🔴 WHO CAN SEE A DOCUMENT.
 *
 *   · a DRAFT — only the person who uploaded it. Membership in the ecosistema
 *     is NOT enough. This is the risk the ecosistema model introduces that a
 *     purely per-tenant scheme did not have: same-ecosistema, cross-person
 *     leakage.
 *   · a PUBLISHED document — every member of its ecosistema.
 *
 * `visibleToCaller` returns a Payload WHERE CONSTRAINT rather than a boolean,
 * so these tests assert on the shape of that constraint. That is the right
 * level: the constraint is what reaches the database, and a boolean returned by
 * mistake would be a full cross-tenant read that no row-level test would catch.
 *
 * The companion file `Documents.tenancy.test.ts` covers the WRITE side.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { visibleToCaller } from './Documents'

const ECO_A = 10
const ECO_B = 20
const ANA = 1 // ecosistema A
const BEN = 2 // ALSO ecosistema A
const CARLA = 3 // ecosistema B
const NOBODY = 4 // no memberships at all

/**
 * Memberships, the way `organizationIdsForUser` reads them: one query for the
 * membership rows, one for the organizations they point at.
 */
function reqAs(userId: number | null, opts: { platformAdmin?: boolean } = {}): PayloadRequest {
  const memberships: Record<string, number[]> = {
    [ANA]: [ECO_A],
    [BEN]: [ECO_A],
    [CARLA]: [ECO_B],
    [NOBODY]: [],
  }

  return {
    user:
      userId === null
        ? null
        : { id: userId, isActive: true, isPlatformAdmin: opts.platformAdmin === true },
    payload: {
      find: vi.fn(async ({ collection }: { collection: string }) => {
        if (collection === 'memberships') {
          const orgs = memberships[String(userId)] ?? []
          return { docs: orgs.map((o, i) => ({ id: i + 1, user: userId, organization: o, role: 'member' })) }
        }
        // organizations — echo back whatever ids were asked for, all active.
        const orgs = memberships[String(userId)] ?? []
        return { docs: orgs.map((o) => ({ id: o, slug: `eco-${o}`, isActive: true })) }
      }),
    },
  } as unknown as PayloadRequest
}

const constraintFor = (userId: number | null, opts?: { platformAdmin?: boolean }) =>
  visibleToCaller({ req: reqAs(userId, opts) } as never) as Promise<unknown>

describe('a published document is reachable by another member', () => {
  it('constrains reads to published documents in MY ecosistemas, plus my own', async () => {
    const where = (await constraintFor(BEN)) as {
      or: Array<Record<string, unknown>>
    }

    expect(where.or).toHaveLength(2)
    // Mine, whatever state they are in.
    expect(where.or[0]).toEqual({ uploadedBy: { equals: BEN } })
    // Everyone's, but only once published and only in my ecosistemas.
    expect(where.or[1]).toEqual({
      and: [{ publicationStatus: { equals: 'published' } }, { organization: { in: [ECO_A] } }],
    })
  })

  it('does NOT extend to an ecosistema I am not a member of', async () => {
    const where = (await constraintFor(CARLA)) as { or: Array<Record<string, unknown>> }
    const published = where.or[1] as { and: Array<{ organization?: { in: number[] } }> }
    const orgs = published.and.find((c) => c.organization)?.organization?.in
    expect(orgs).toEqual([ECO_B])
    expect(orgs).not.toContain(ECO_A)
  })
})

describe('🔴 a draft is NOT reachable by a colleague', () => {
  // Ana and Ben share ecosistema A. Ben's constraint lets him see PUBLISHED
  // documents there — but the published clause is guarded by
  // `publicationStatus: 'published'`, so Ana's drafts fall outside it, and the
  // only unguarded clause is `uploadedBy: Ben`.
  it('gates every non-own document behind publicationStatus === published', async () => {
    const where = (await constraintFor(BEN)) as { or: Array<Record<string, unknown>> }
    const shared = where.or[1] as { and: Array<Record<string, unknown>> }

    expect(shared.and).toContainEqual({ publicationStatus: { equals: 'published' } })
  })

  it('has exactly one unguarded clause, and it is "mine"', async () => {
    // ⚠ The property that matters is structural: if a second clause were ever
    // added without a publicationStatus guard, drafts would leak to the whole
    // ecosistema. This asserts the shape, not just one example row.
    const where = (await constraintFor(BEN)) as { or: Array<Record<string, unknown>> }
    const unguarded = where.or.filter((clause) => !('and' in clause))
    expect(unguarded).toEqual([{ uploadedBy: { equals: BEN } }])
  })
})

describe('a draft is reachable by its uploader', () => {
  it('always includes an unconditional "uploaded by me" clause', async () => {
    // Unconditional on purpose: a document mid-publish (`publishing`) must not
    // vanish from the person who owns it while the re-embed is in flight.
    const where = (await constraintFor(ANA)) as { or: Array<Record<string, unknown>> }
    expect(where.or[0]).toEqual({ uploadedBy: { equals: ANA } })
  })
})

describe('edge cases that decide whether this fails open or closed', () => {
  it('refuses an anonymous caller outright', async () => {
    await expect(constraintFor(null)).resolves.toBe(false)
  })

  // 🔴 NOT `{ organization: { in: [] } }`. An ORM can optimise an empty `IN`
  // away into "no constraint", and the failure mode is every ecosistema's
  // documents returned to somebody who belongs to none.
  it('falls back to own-documents-only when the caller has no memberships', async () => {
    const where = await constraintFor(NOBODY)
    expect(where).toEqual({ uploadedBy: { equals: NOBODY } })
  })

  it('lets a platform admin through unrestricted', async () => {
    await expect(constraintFor(ANA, { platformAdmin: true })).resolves.toBe(true)
  })
})
