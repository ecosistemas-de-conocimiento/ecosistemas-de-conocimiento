/**
 * 🔴 WHO CAN READ THE ACTUAL FILE.
 *
 * `Documents.visibility.test.ts` proves the DOCUMENT ROW is private. This file
 * proves the BYTES BEHIND IT are, which is a separate enforcement point:
 * Payload checks access per collection, so `media` was `Boolean(user)` on all
 * four operations while `documents` was airtight. Anyone with an account could
 * fetch — or delete — any file in the installation, across every ecosistema.
 *
 * The rules being asserted, mirrored from `Documents`:
 *   · the uploader reads their own file, always, in any publication state;
 *   · another member reads it only once a document of THEIRS publishes it into
 *     an ecosistema they share;
 *   · nobody else reads it, and only the uploader may update or delete it.
 *
 * As in the Documents tests, these assert on the shape of the WHERE CONSTRAINT
 * rather than on rows: the constraint is what reaches the database, and a
 * boolean returned by mistake would be the original bug back again.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import {
  bindMediaToEcosystem,
  MEDIA_MIME_TYPES,
  mediaUploaderOnly,
  mediaVisibleToCaller,
} from './Media'

const ECO_A = 10
const ECO_B = 20
const ANA = 1 // ecosistema A
const BEN = 2 // ALSO ecosistema A
const CARLA = 3 // ecosistema B
const NOBODY = 4 // no memberships at all
const DUAL = 5 // belongs to BOTH

/** Ana's published file, Ana's private draft file, Carla's published file. */
const ANA_PUBLISHED_MEDIA = 5000
const ANA_DRAFT_MEDIA = 5001
const CARLA_PUBLISHED_MEDIA = 6000

const MEMBERSHIPS: Record<string, number[]> = {
  [ANA]: [ECO_A],
  [BEN]: [ECO_A],
  [CARLA]: [ECO_B],
  [NOBODY]: [],
  [DUAL]: [ECO_A, ECO_B],
}

type DocRow = {
  id: number
  organization: number
  uploadedBy: number
  mediaFile: number | null
  publicationStatus: string
}

const DEFAULT_DOCS: DocRow[] = [
  {
    id: 500,
    organization: ECO_A,
    uploadedBy: ANA,
    mediaFile: ANA_PUBLISHED_MEDIA,
    publicationStatus: 'published',
  },
  // 🔴 The same-ecosistema draft. Ben must never reach this one.
  {
    id: 501,
    organization: ECO_A,
    uploadedBy: ANA,
    mediaFile: ANA_DRAFT_MEDIA,
    publicationStatus: 'draft',
  },
  // A different ecosistema entirely.
  {
    id: 600,
    organization: ECO_B,
    uploadedBy: CARLA,
    mediaFile: CARLA_PUBLISHED_MEDIA,
    publicationStatus: 'published',
  },
  // A markdown working-doc: published, but no file behind it.
  {
    id: 502,
    organization: ECO_A,
    uploadedBy: BEN,
    mediaFile: null,
    publicationStatus: 'published',
  },
]

/**
 * A `req` whose `payload.find` answers the three queries the access rule makes:
 * memberships, the organizations they point at, and the published documents of
 * those organizations. The documents query is filtered here the way Postgres
 * would filter it, so a rule that forgot a clause fails the test rather than
 * quietly getting a pre-filtered fixture.
 */
function reqAs(
  userId: number | null,
  opts: { platformAdmin?: boolean; docs?: DocRow[] } = {},
): PayloadRequest {
  const docs = opts.docs ?? DEFAULT_DOCS

  return {
    user:
      userId === null
        ? null
        : { id: userId, isActive: true, isPlatformAdmin: opts.platformAdmin === true },
    payload: {
      find: vi.fn(async ({ collection, where }: { collection: string; where?: unknown }) => {
        const orgs = MEMBERSHIPS[String(userId)] ?? []
        if (collection === 'memberships') {
          return {
            docs: orgs.map((o, i) => ({ id: i + 1, user: userId, organization: o, role: 'member' })),
          }
        }
        if (collection === 'organizations') {
          return { docs: orgs.map((o) => ({ id: o, slug: `eco-${o}`, isActive: true })) }
        }
        if (collection === 'documents') {
          const clauses = ((where as { and?: Array<Record<string, never>> })?.and ??
            []) as Array<Record<string, { equals?: unknown; in?: unknown[]; exists?: boolean }>>
          const status = clauses.find((c) => c.publicationStatus)?.publicationStatus?.equals
          const orgIn = clauses.find((c) => c.organization)?.organization?.in as
            | number[]
            | undefined
          const wantsFile = clauses.find((c) => c.mediaFile)?.mediaFile?.exists === true

          return {
            docs: docs.filter(
              (d) =>
                (status === undefined || d.publicationStatus === status) &&
                (orgIn === undefined || orgIn.includes(d.organization)) &&
                (!wantsFile || d.mediaFile !== null),
            ),
          }
        }
        return { docs: [] }
      }),
    },
  } as unknown as PayloadRequest
}

type SharedClause = { and: Array<Record<string, { equals?: number; in?: number[] }>> }
type OrConstraint = { or: Array<Record<string, unknown>> }

const constraintFor = (
  userId: number | null,
  opts?: { platformAdmin?: boolean; docs?: DocRow[] },
) => mediaVisibleToCaller({ req: reqAs(userId, opts) } as never) as Promise<unknown>

/** Every media id the shared (non-"mine") clauses could possibly match. */
function reachableIds(where: unknown): number[] {
  const or = (where as OrConstraint).or ?? []
  return or.flatMap((clause) => {
    const and = (clause as SharedClause).and
    if (!and) return []
    return (and.find((c) => c.id)?.id?.in ?? []) as number[]
  })
}

// ---------------------------------------------------------------------------

describe('🔴 the hole this collection used to have', () => {
  it('never returns a bare boolean true for an ordinary member', async () => {
    // `read: () => Boolean(user)` was the bug: every file in the installation,
    // readable and deletable by anyone with an account.
    for (const who of [ANA, BEN, CARLA, NOBODY]) {
      const where = await constraintFor(who)
      expect(where).not.toBe(true)
      expect(typeof where).toBe('object')
    }
  })
})

describe('🔴 a member of another ecosistema', () => {
  it('cannot reach ecosistema A\'s files', async () => {
    const where = await constraintFor(CARLA)
    expect(reachableIds(where)).not.toContain(ANA_PUBLISHED_MEDIA)
    expect(reachableIds(where)).not.toContain(ANA_DRAFT_MEDIA)
  })

  it('sees only its OWN ecosistema\'s published files', async () => {
    const where = await constraintFor(CARLA)
    expect(reachableIds(where)).toEqual([CARLA_PUBLISHED_MEDIA])
  })

  it('asks the database for published documents in MY ecosistemas only', async () => {
    const req = reqAs(CARLA)
    await mediaVisibleToCaller({ req } as never)
    const call = (req.payload.find as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[0] as { collection: string; where?: unknown })
      .find((args) => args.collection === 'documents')
    expect(call?.where).toEqual({
      and: [
        { publicationStatus: { equals: 'published' } },
        { organization: { in: [ECO_B] } },
        { mediaFile: { exists: true } },
      ],
    })
  })
})

describe('🔴 a colleague in the SAME ecosistema', () => {
  it('cannot reach another member\'s DRAFT file', async () => {
    // Ana and Ben share ecosistema A. Ana's draft is the risk this model
    // introduces that a purely per-tenant scheme did not have.
    const where = await constraintFor(BEN)
    expect(reachableIds(where)).not.toContain(ANA_DRAFT_MEDIA)
  })

  it('has exactly one unguarded clause, and it is "mine"', async () => {
    // Structural, not exemplary: if a clause were ever added without both a
    // publication guard and an uploader guard, every draft file in the
    // ecosistema would leak.
    const where = (await constraintFor(BEN)) as OrConstraint
    const unguarded = where.or.filter((clause) => !('and' in clause))
    expect(unguarded).toEqual([{ uploadedBy: { equals: BEN } }])
  })

  it('CAN reach a file whose document is published', async () => {
    const where = (await constraintFor(BEN)) as OrConstraint
    expect(where.or).toContainEqual({
      and: [{ uploadedBy: { equals: ANA } }, { id: { in: [ANA_PUBLISHED_MEDIA] } }],
    })
  })
})

describe('the uploader', () => {
  it('reaches their own DRAFT file unconditionally', async () => {
    // Unconditional on purpose: a file whose document is mid-publish, or whose
    // document never got created, must not vanish from the person who owns it.
    const where = (await constraintFor(ANA)) as OrConstraint
    expect(where.or[0]).toEqual({ uploadedBy: { equals: ANA } })
  })

  it('is the only one who may update or delete', async () => {
    expect(mediaUploaderOnly({ req: reqAs(ANA) } as never)).toEqual({
      uploadedBy: { equals: ANA },
    })
    // 🔴 Ben's delete constraint cannot match Ana's row, published or not.
    expect(mediaUploaderOnly({ req: reqAs(BEN) } as never)).toEqual({
      uploadedBy: { equals: BEN },
    })
  })

  it('refuses update/delete to an anonymous caller', () => {
    expect(mediaUploaderOnly({ req: reqAs(null) } as never)).toBe(false)
  })
})

describe('🔴 publishing someone else\'s file does not unlock it', () => {
  // `documents.mediaFile` is client-supplied and unvalidated, so Ben can create
  // a document pointing at Ana's private media id and publish it. The shared
  // clause pairs media id WITH uploader, so the id Ben published is only
  // reachable for files Ben uploaded — and this one is Ana's.
  const hijack: DocRow[] = [
    ...DEFAULT_DOCS,
    {
      id: 503,
      organization: ECO_A,
      uploadedBy: BEN,
      mediaFile: ANA_DRAFT_MEDIA,
      publicationStatus: 'published',
    },
  ]

  it('pairs every shared media id with the uploader who published it', async () => {
    const where = (await constraintFor(BEN, { docs: hijack })) as OrConstraint
    const anaClause = where.or.find(
      (c) => (c as SharedClause).and?.some((p) => p.uploadedBy?.equals === ANA),
    )
    // Ana's clause exists (her published file) and does NOT contain her draft.
    expect((anaClause as SharedClause).and.find((p) => p.id)?.id?.in).toEqual([
      ANA_PUBLISHED_MEDIA,
    ])
  })

  it('leaves the hijacked id matchable only against BEN as uploader', async () => {
    const where = (await constraintFor(BEN, { docs: hijack })) as OrConstraint
    const clausesWithDraft = where.or.filter((c) =>
      ((c as SharedClause).and?.find((p) => p.id)?.id?.in ?? []).includes(ANA_DRAFT_MEDIA),
    )
    expect(clausesWithDraft).toHaveLength(1)
    // Ana's row has uploadedBy: ANA, so this clause matches nothing.
    expect((clausesWithDraft[0] as SharedClause).and).toContainEqual({
      uploadedBy: { equals: BEN },
    })
  })
})

describe('edge cases that decide whether this fails open or closed', () => {
  it('refuses an anonymous caller outright', async () => {
    await expect(constraintFor(null)).resolves.toBe(false)
  })

  // 🔴 NOT `{ organization: { in: [] } }`. An ORM can optimise an empty `IN`
  // away into "no constraint", and the failure mode is every file in the
  // installation returned to somebody who belongs to nothing.
  it('falls back to own-files-only when the caller has no memberships', async () => {
    await expect(constraintFor(NOBODY)).resolves.toEqual({ uploadedBy: { equals: NOBODY } })
  })

  it('falls back to own-files-only when the ecosistema has published nothing', async () => {
    await expect(constraintFor(BEN, { docs: [] })).resolves.toEqual({
      uploadedBy: { equals: BEN },
    })
  })

  it('ignores a published document that carries no uploader', async () => {
    // A document with no owner cannot vouch for a file. Skipped rather than
    // widened to "anyone in the ecosistema".
    const orphanedDoc = [
      {
        id: 700,
        organization: ECO_A,
        uploadedBy: null as unknown as number,
        mediaFile: ANA_DRAFT_MEDIA,
        publicationStatus: 'published',
      },
    ]
    await expect(constraintFor(BEN, { docs: orphanedDoc })).resolves.toEqual({
      uploadedBy: { equals: BEN },
    })
  })

  it('lets a platform admin through unrestricted', async () => {
    await expect(constraintFor(ANA, { platformAdmin: true })).resolves.toBe(true)
  })
})

describe('🔴 the orphan case — a file no document points at', () => {
  // Every upload is an orphan for the width of a round trip: the BFF POSTs the
  // bytes to /api/media, gets an id back, and only then creates the documents
  // row. A file whose document was deleted is an orphan forever.
  it('is reachable by its uploader and by nobody else', async () => {
    // ANA_DRAFT_MEDIA stands in for an orphan here: no PUBLISHED document
    // references it, so it appears in no shared clause at all.
    const ben = await constraintFor(BEN)
    expect(reachableIds(ben)).not.toContain(ANA_DRAFT_MEDIA)

    const ana = (await constraintFor(ANA)) as OrConstraint
    // Ana's unconditional clause is the only thing that can match it, and it
    // does not depend on any document existing.
    expect(ana.or[0]).toEqual({ uploadedBy: { equals: ANA } })
  })
})

// ---------------------------------------------------------------------------
// The upload gate
// ---------------------------------------------------------------------------

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
  userId: number,
) =>
  bindMediaToEcosystem({
    data,
    originalDoc,
    operation: 'update',
    req: reqAs(userId),
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

describe('🔴 the client cannot choose who owns its upload', () => {
  it('stamps the caller as uploader', async () => {
    const result = await create({ alt: 'notes' }, ANA)
    expect(result.uploadedBy).toBe(ANA)
  })

  it('overwrites a client-supplied uploadedBy', async () => {
    // `uploadedBy` IS the unconditional read clause and the delete rule. A
    // forged value hands both away.
    const result = await create({ uploadedBy: BEN }, ANA)
    expect(result.uploadedBy).toBe(ANA)
  })

  it('keeps uploadedBy immutable across updates', async () => {
    const result = await update({ uploadedBy: BEN }, { id: 1, uploadedBy: ANA }, ANA)
    expect(result.uploadedBy).toBe(ANA)
  })

  it('overwrites a client-supplied organization on update', async () => {
    const result = await update(
      { organization: ECO_B },
      { id: 1, uploadedBy: ANA, organization: ECO_A },
      ANA,
    )
    expect(result.organization).toBe(ECO_A)
  })
})

describe('the ecosistema label', () => {
  it('is derived when the uploader belongs to exactly one', async () => {
    const result = await create({}, ANA)
    expect(result.organization).toBe(ECO_A)
  })

  it('is left unset — not guessed — when the uploader belongs to several', async () => {
    // POST /api/media carries only the file, so there is nothing to
    // disambiguate with. Refusing would break uploads for multi-ecosistema
    // members outright, and the read rule does not depend on this field.
    const result = await create({ organization: ECO_B }, DUAL)
    expect(result.organization).toBeUndefined()
  })

  it('is left unset when the uploader belongs to none', async () => {
    const result = await create({ organization: ECO_A }, NOBODY)
    expect(result.organization).toBeUndefined()
    expect(result.uploadedBy).toBe(NOBODY)
  })
})

describe('server-side writes', () => {
  it('pass through untouched when there is no authenticated user', async () => {
    const result = await create({ alt: 'seeded', uploadedBy: ANA }, null)
    expect(result.uploadedBy).toBe(ANA)
    expect(result.organization).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Accepted uploads
// ---------------------------------------------------------------------------

describe('accepted mime types', () => {
  it('keeps the existing document types', () => {
    expect(MEDIA_MIME_TYPES).toContain('application/pdf')
    expect(MEDIA_MIME_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(MEDIA_MIME_TYPES).toContain('text/markdown')
    expect(MEDIA_MIME_TYPES).toContain('text/plain')
  })

  it('accepts what audio-service can actually transcribe', () => {
    // The m4a spellings in particular: browsers disagree, and rejecting the
    // wrong one turns a working phone recording into an upload error.
    for (const type of [
      'audio/mpeg',
      'audio/mp4',
      'audio/x-m4a',
      'audio/m4a',
      'audio/aac',
      'audio/wav',
      'audio/ogg',
      'audio/opus',
      'audio/webm',
      'audio/flac',
      'video/mp4',
      'video/quicktime',
    ]) {
      expect(MEDIA_MIME_TYPES).toContain(type)
    }
  })

  it('does NOT accept application/octet-stream', () => {
    // audio-service tolerates it because ffprobe is its real gate. Accepting it
    // here would make the allowlist decorative — it is what a browser sends for
    // anything it cannot sniff, including an executable.
    expect(MEDIA_MIME_TYPES).not.toContain('application/octet-stream')
  })
})
