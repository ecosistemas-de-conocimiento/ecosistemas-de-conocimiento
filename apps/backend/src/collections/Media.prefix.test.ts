/**
 * THE OBJECT-KEY PREFIX — and the line it must never cross.
 *
 * 🔴 THE PREFIX IS NOT AN ACCESS BOUNDARY. Anyone with a working bucket
 * credential reads every key under every prefix; it is a naming convention, not
 * a wall. The only thing between a user and someone else's file is
 * `mediaVisibleToCaller`, evaluated per request by Payload.
 *
 * So the first test here asserts the NEGATIVE: the read constraint does not
 * mention the prefix, and did not change shape when the prefix arrived. That is
 * the property a future "let's just filter by prefix, it's cheaper" refactor
 * would break, and it would break it silently.
 *
 * The rest cover what the prefix IS for — per-ecosistema operability — and the
 * one way it can hurt: a stale value makes an intact object 404, because the
 * serve route rebuilds the key from the stored prefix.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { bindMediaToEcosystem, mediaObjectPrefix, mediaVisibleToCaller } from './Media'

const ECO_A = 10
const ECO_B = 20
const ANA = 1 // ecosistema A only
const DUAL = 5 // belongs to BOTH — organization stays unset
const NOBODY = 4 // no memberships at all

const MEMBERSHIPS: Record<string, number[]> = {
  [ANA]: [ECO_A],
  [DUAL]: [ECO_A, ECO_B],
  [NOBODY]: [],
}

function reqAs(userId: number | null): PayloadRequest {
  return {
    user: userId === null ? null : { id: userId, isActive: true, isPlatformAdmin: false },
    payload: {
      find: vi.fn(async ({ collection }: { collection: string }) => {
        const orgs = MEMBERSHIPS[String(userId)] ?? []
        if (collection === 'memberships') {
          return {
            docs: orgs.map((o, i) => ({ id: i + 1, user: userId, organization: o, role: 'member' })),
          }
        }
        if (collection === 'organizations') {
          return { docs: orgs.map((o) => ({ id: o, slug: `eco-${o}`, isActive: true })) }
        }
        return { docs: [] }
      }),
    },
  } as unknown as PayloadRequest
}

const create = (data: Record<string, unknown>, userId: number | null) =>
  bindMediaToEcosystem({
    data,
    operation: 'create',
    req: reqAs(userId),
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

const update = (
  data: Record<string, unknown>,
  originalDoc: Record<string, unknown>,
  userId: number | null,
) =>
  bindMediaToEcosystem({
    data,
    originalDoc,
    operation: 'update',
    req: reqAs(userId),
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

const access = (userId: number | null) =>
  mediaVisibleToCaller({ req: reqAs(userId) } as never) as Promise<unknown>

describe('🔴 the media read rule is unchanged by object storage', () => {
  it('still refuses an anonymous caller outright', async () => {
    await expect(access(null)).resolves.toBe(false)
  })

  it('still returns the uploader-only WHERE constraint, and NOT a boolean', async () => {
    // A boolean would stop reaching the query, and the file route would go back
    // to being readable by any signed-in account — the original bug.
    await expect(access(NOBODY)).resolves.toEqual({ uploadedBy: { equals: NOBODY } })
  })

  it('never constrains on the prefix — the prefix grants and denies nothing', async () => {
    const constraint = JSON.stringify(await access(ANA))

    expect(constraint).not.toContain('prefix')
    expect(constraint).not.toContain('eco_')
  })
})

describe('where an object lands', () => {
  it('puts a single-ecosistema member under eco_{orgId}/u_{uploaderId}', async () => {
    const result = await create({ alt: 'notes' }, ANA)

    expect(result.prefix).toBe(`eco_${ECO_A}/u_${ANA}`)
  })

  it('falls back to eco_none when the ecosistema is ambiguous', async () => {
    // `POST /api/media` carries only the file, so a member of several
    // ecosistemas leaves `organization` unset. That nullability is exactly why
    // the prefix could never be a tenancy check.
    const result = await create({ alt: 'notes' }, DUAL)

    expect(result.organization).toBeUndefined()
    expect(result.prefix).toBe(`eco_none/u_${DUAL}`)
  })

  it('keeps the uploader segment even with no ecosistema at all, so orphans stay attributable', async () => {
    // Every file is an orphan for the width of the media→documents round trip,
    // and stays one forever if the second call fails.
    const result = await create({ alt: 'notes' }, NOBODY)

    expect(result.prefix).toBe(`eco_none/u_${NOBODY}`)
  })

  it('gives seed and ingest writes a deterministic key rather than the bucket root', async () => {
    const result = await create({ organization: ECO_B, uploadedBy: ANA }, null)

    expect(result.prefix).toBe(`eco_${ECO_B}/u_${ANA}`)
  })

  it('ignores a client-supplied prefix on create', async () => {
    const result = await create({ prefix: '../../etc' }, ANA)

    expect(result.prefix).toBe(`eco_${ECO_A}/u_${ANA}`)
  })
})

describe('the prefix is immutable', () => {
  it('rejects a client attempt to move an object by rewriting its prefix', async () => {
    // ⚠ Rewriting it moves NO object. It only stops the serve route computing
    // the key the upload actually used, so the file 404s while sitting intact in
    // the bucket.
    const result = await update({ prefix: 'eco_999/u_1' }, { id: 1, prefix: 'eco_10/u_1' }, ANA)

    expect(result.prefix).toBe('eco_10/u_1')
  })

  it('holds for overrideAccess writers too, who have no user to check', async () => {
    const result = await update({ prefix: 'eco_999/u_1' }, { id: 1, prefix: 'eco_10/u_1' }, null)

    expect(result.prefix).toBe('eco_10/u_1')
  })

  it('leaves a pre-object-storage row alone rather than inventing a prefix for it', async () => {
    // Rows written while files were on local disk have no prefix, and an empty
    // one means "bucket root" — which is right for bytes that were never in a
    // bucket.
    const result = await update({ alt: 'edited' }, { id: 1, uploadedBy: ANA }, ANA)

    expect(result.prefix).toBeUndefined()
  })
})

describe('mediaObjectPrefix', () => {
  it('is stable and contains no path traversal, whatever the ids', () => {
    expect(mediaObjectPrefix(10, 1)).toBe('eco_10/u_1')
    expect(mediaObjectPrefix(null, null)).toBe('eco_none/u_none')
    expect(mediaObjectPrefix('abc', 'def')).toBe('eco_abc/u_def')
  })
})
