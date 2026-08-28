/**
 * 🔴 THE COMMENT IS THE ONLY PART OF A RATING THAT CONTAINS SOMEBODY'S WORDS.
 *
 * `read` on `ratings` is TENANT-WIDE, and that is right for `stars` and
 * `reason`: they are counts, and they name nobody. It was wrong for `comment`.
 * Tenant-wide read meant every member of an ecosistema could read every
 * colleague's written complaint about an answer. The UI does warn people the
 * field is not private, which is honest — but "not private" was quietly being
 * implemented as "published to everyone you work with".
 *
 * So `comment` is narrowed to whoever holds `ratings:read-comments` IN THE
 * ECOSISTEMA THE RATING BELONGS TO (Investigador and up), plus its author.
 *
 * ⚠ FIELD access, not collection access. Hiding the row would take the star
 * counts with it and break the quality view an admin needs; a field gate strips
 * exactly one key from the response.
 *
 * 🔴 AND IT FAILS CLOSED. If the row's ecosistema cannot be determined from what
 * Payload hands the callback, the answer is `false`. An undeterminable tenant is
 * the one case where guessing is a disclosure.
 */

import { describe, expect, it, vi } from 'vitest'
import type { FieldAccessArgs, PayloadRequest } from 'payload'

import { canReadRatingComment } from './Ratings'

const ECO_A = 10
const ECO_B = 20

const ANA = 1 // plain `member` of ECO_A — wrote the rating below
const BEN = 2 // plain `member` of ECO_A — a colleague
const IRIS = 3 // `investigador` of ECO_A
const IVAN = 4 // `investigador` of ECO_B only
const ADA = 5 // `admin` of ECO_A
const OSCAR = 6 // `owner` of ECO_A
const ROOT = 7 // platform admin

const MEMBERSHIPS: Record<number, Array<[number, string]>> = {
  [ANA]: [[ECO_A, 'member']],
  [BEN]: [[ECO_A, 'member']],
  [IRIS]: [[ECO_A, 'investigador']],
  [IVAN]: [[ECO_B, 'investigador']],
  [ADA]: [[ECO_A, 'admin']],
  [OSCAR]: [[ECO_A, 'owner']],
  [ROOT]: [],
}

function reqAs(userId: number | null): PayloadRequest {
  return {
    user:
      userId === null
        ? null
        : { id: userId, isActive: true, isPlatformAdmin: userId === ROOT },
    payload: {
      find: vi.fn(async ({ collection }: { collection: string }) => {
        const rows = MEMBERSHIPS[userId as number] ?? []
        if (collection === 'memberships') {
          return {
            docs: rows.map(([org, role], i) => ({
              id: i + 1,
              user: userId,
              organization: org,
              role,
              isActive: true,
            })),
          }
        }
        return { docs: rows.map(([org]) => ({ id: org, slug: `eco-${org}`, isActive: true })) }
      }),
    },
  } as unknown as PayloadRequest
}

/** ANA's rating of an answer in ECO_A, with a written note. */
const ANAS_RATING = { id: 900, user: ANA, organization: ECO_A, stars: 2, reason: 'other' }

const canRead = (userId: number | null, row?: Record<string, unknown>, via: 'doc' | 'data' = 'doc') =>
  canReadRatingComment({
    req: reqAs(userId),
    ...(row ? { [via]: row } : {}),
  } as unknown as FieldAccessArgs) as Promise<boolean>

// ---------------------------------------------------------------------------

describe('the author of a rating', () => {
  it('can always read their own comment', async () => {
    // ⚠ Without this the person who just wrote a comment would watch it vanish
    // from the response on the very next GET. That reads as DATA LOSS, not as a
    // privacy rule, and it is the fastest way to make people stop leaving
    // feedback at all.
    await expect(canRead(ANA, ANAS_RATING)).resolves.toBe(true)
  })

  it('is matched across a string/number id mismatch', async () => {
    // Every REST body is JSON, and a `1` vs `'1'` mismatch here would silently
    // hide people's own notes from them.
    await expect(canRead(ANA, { ...ANAS_RATING, user: String(ANA) })).resolves.toBe(true)
  })

  it('is matched when the relationship arrives populated', async () => {
    await expect(canRead(ANA, { ...ANAS_RATING, user: { id: ANA } })).resolves.toBe(true)
  })
})

describe('🔴 colleagues in the same ecosistema', () => {
  it('a plain member CANNOT read someone else\'s comment', async () => {
    // This is the whole point of the field gate: `read` on the collection is
    // tenant-wide, so before it existed Ben could read every complaint Ana ever
    // wrote about an answer.
    await expect(canRead(BEN, ANAS_RATING)).resolves.toBe(false)
  })

  it('an investigador CAN — that is what `ratings:read-comments` is for', async () => {
    // An Investigador reads the free text behind low ratings to understand what
    // the corpus is missing. That is the job the permission exists for.
    await expect(canRead(IRIS, ANAS_RATING)).resolves.toBe(true)
  })

  it('an admin CAN', async () => {
    // ⚠ ADMIN_PERMISSIONS is built on INVESTIGADOR_PERMISSIONS: a rank that did
    // not carry the lower role's grants would be a lie.
    await expect(canRead(ADA, ANAS_RATING)).resolves.toBe(true)
  })

  it('an owner CAN', async () => {
    await expect(canRead(OSCAR, ANAS_RATING)).resolves.toBe(true)
  })

  it('a platform admin CAN', async () => {
    await expect(canRead(ROOT, ANAS_RATING)).resolves.toBe(true)
  })
})

describe('🔴 the permission is held IN an ecosistema', () => {
  it('an investigador of a DIFFERENT ecosistema CANNOT read this one\'s comments', async () => {
    // Ivan genuinely holds `ratings:read-comments` — in ECO_B. Checking "is this
    // person an investigador anywhere" instead of "…in the ecosistema this row
    // belongs to" would be a cross-tenant disclosure of somebody's words.
    await expect(canRead(IVAN, ANAS_RATING)).resolves.toBe(false)
  })

  it('the same investigador CAN read a comment in their OWN ecosistema', async () => {
    // The mirror of the test above — otherwise a broken permission lookup would
    // pass the cross-tenant case for the wrong reason.
    await expect(
      canRead(IVAN, { id: 901, user: ANA, organization: ECO_B }),
    ).resolves.toBe(true)
  })
})

describe('🔴 it fails closed', () => {
  it('refuses when the row\'s ecosistema cannot be determined', async () => {
    // 🔴 An undeterminable tenant is the one case where guessing is a
    // disclosure: there is no organization to check the permission against, so
    // "allow" would mean allowing it everywhere.
    await expect(canRead(IRIS, { id: 902, user: BEN })).resolves.toBe(false)
    await expect(canRead(ADA, { id: 903, user: BEN, organization: null })).resolves.toBe(false)
  })

  it('refuses when Payload hands the callback NO doc and NO data', async () => {
    // The empty-args case is real — Payload calls field access on paths where it
    // has no row yet. Nothing to scope against means no.
    await expect(canRead(IRIS)).resolves.toBe(false)
    await expect(canRead(ADA)).resolves.toBe(false)
  })

  it('refuses an unauthenticated caller outright', async () => {
    await expect(canRead(null, ANAS_RATING)).resolves.toBe(false)
  })
})

describe('where the row comes from', () => {
  it('reads the tenant off `data` when Payload passes no `doc`', async () => {
    // On a write path Payload hands `data` rather than `doc`. Reading only `doc`
    // would fail closed there — safe, but it would hide the comment from the
    // Investigador who is entitled to it right after it is written.
    await expect(canRead(IRIS, ANAS_RATING, 'data')).resolves.toBe(true)
    await expect(canRead(BEN, ANAS_RATING, 'data')).resolves.toBe(false)
  })
})
