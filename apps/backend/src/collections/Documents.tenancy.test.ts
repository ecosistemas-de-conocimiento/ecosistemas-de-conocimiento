/**
 * 🔴 THE UPLOAD GATE, at the level a real request hits it.
 *
 * `lib/corpus.test.ts` proves the naming rule. This proves the rule is actually
 * WIRED to `POST /api/documents` — which is where it matters, because `create`
 * access on that collection is "any signed-in user" and the session id arrives
 * in the request body.
 *
 * Without this hook, a person in ecosistema A could POST a document naming a
 * session in ecosistema B. The row would carry ecosistema B, the ingest hook
 * would derive `eco-B-draft-…` from it, and the victim's own chat would later
 * retrieve a document the attacker planted and cite it as their own source.
 * That is INJECTION rather than disclosure, and in a knowledgebase it is worse.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { bindDocumentToEcosystem } from './Documents'

const ECO_A = 10
const ECO_B = 20
const ANA = 1 // ecosistema A
const BEN = 2 // ALSO ecosistema A
const CARLA = 3 // ecosistema B
const DUAL = 4 // belongs to BOTH
const NOBODY = 5 // no memberships

const ANA_SESSION = 100
const BEN_SESSION = 101
const CARLA_SESSION = 200

const MEMBERSHIPS: Record<string, number[]> = {
  [ANA]: [ECO_A],
  [BEN]: [ECO_A],
  [CARLA]: [ECO_B],
  [DUAL]: [ECO_A, ECO_B],
  [NOBODY]: [],
}

function reqAs(userId: number | null): PayloadRequest {
  const sessions: Record<string, { user: number; organization: number }> = {
    [ANA_SESSION]: { user: ANA, organization: ECO_A },
    [BEN_SESSION]: { user: BEN, organization: ECO_A },
    [CARLA_SESSION]: { user: CARLA, organization: ECO_B },
  }
  return {
    user: userId === null ? null : { id: userId, isActive: true, isPlatformAdmin: false },
    payload: {
      findByID: vi.fn(async ({ id }: { id: number | string }) => {
        const row = sessions[String(id)]
        if (!row) throw new Error('NotFound')
        return { id, ...row }
      }),
      find: vi.fn(async ({ collection }: { collection: string }) => {
        const orgs = MEMBERSHIPS[String(userId)] ?? []
        if (collection === 'memberships') {
          return {
            docs: orgs.map((o, i) => ({ id: i + 1, user: userId, organization: o, role: 'member' })),
          }
        }
        return { docs: orgs.map((o) => ({ id: o, slug: `eco-${o}`, isActive: true })) }
      }),
    },
  } as unknown as PayloadRequest
}

const create = (data: Record<string, unknown>, userId: number | null) =>
  bindDocumentToEcosystem({
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
  bindDocumentToEcosystem({
    data,
    originalDoc,
    operation: 'update',
    req: reqAs(userId),
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

// ---------------------------------------------------------------------------

describe('uploading into your own conversation', () => {
  it('stamps the ecosistema, the uploader and the draft state', async () => {
    const result = await create({ session: ANA_SESSION, name: 'notes.pdf' }, ANA)
    expect(result.session).toBe(ANA_SESSION)
    expect(result.organization).toBe(ECO_A)
    expect(result.uploadedBy).toBe(ANA)
    // ⚠ Everything starts private. Sharing is a separate, deliberate act.
    expect(result.publicationStatus).toBe('draft')
  })
})

describe('🔴 uploading into someone else\'s conversation', () => {
  it('is REFUSED across ecosistemas', async () => {
    await expect(create({ session: CARLA_SESSION, name: 'planted.pdf' }, ANA)).rejects.toThrow()
  })

  // 🔴 The same-ecosistema case. Ana and Ben share ecosistema A, and it is still
  // refused: a document lands in the UPLOADER'S private draft corpus, so writing
  // into Ben's session would put Ana's file where only Ben should be able to put
  // things.
  it('is REFUSED even inside the SAME ecosistema', async () => {
    await expect(create({ session: BEN_SESSION, name: 'planted.pdf' }, ANA)).rejects.toThrow()
  })

  it('is REFUSED on UPDATE too — re-pointing is the same attack in two steps', async () => {
    await expect(
      update({ session: CARLA_SESSION }, { id: 1, session: ANA_SESSION }, ANA),
    ).rejects.toThrow()
  })

  it('is REFUSED for a session that does not exist', async () => {
    await expect(create({ session: 999999 }, ANA)).rejects.toThrow()
  })
})

describe('🔴 the client cannot choose its own scope', () => {
  it('overwrites a client-supplied organization with the session\'s', async () => {
    const result = await create({ session: ANA_SESSION, organization: ECO_B }, ANA)
    expect(result.organization).toBe(ECO_A)
  })

  it('overwrites a client-supplied uploadedBy with the caller', async () => {
    // Drafts are private PER PERSON, so a forged `uploadedBy` would plant a
    // document in someone else's private corpus AND hide it from its real author.
    const result = await create({ session: ANA_SESSION, uploadedBy: BEN }, ANA)
    expect(result.uploadedBy).toBe(ANA)
  })

  it('forces publicationStatus to draft on create, whatever was sent', async () => {
    // Otherwise a document could be marked shared without a single chunk of it
    // being in the shared corpus — the row lies and search never finds it.
    const result = await create({ session: ANA_SESSION, publicationStatus: 'published' }, ANA)
    expect(result.publicationStatus).toBe('draft')
  })

  it('PINS publicationStatus to the stored value on a client update', async () => {
    // Publication moves only through lib/publishDocument.ts, which writes with
    // overrideAccess and never reaches this hook.
    //
    // 🔴 THE ASSERTION IS `toBe('draft')`, NOT `toBeUndefined()`. Payload merges
    // the body over the stored row before this hook runs, so removing the key
    // does not ignore the client's value — it deletes a `required: true` field
    // from the document about to be validated, and EVERY authenticated PATCH
    // 400s, rename included. That is what the earlier `toBeUndefined()` version
    // of this test asserted, and it is why the bug survived to the e2e suite.
    const result = await update(
      { publicationStatus: 'published', name: 'renamed.pdf' },
      {
        id: 1,
        session: ANA_SESSION,
        uploadedBy: ANA,
        organization: ECO_A,
        publicationStatus: 'draft',
      },
      ANA,
    )
    expect(result.publicationStatus).toBe('draft')
    expect(result.name).toBe('renamed.pdf')
  })

  it('does not let a client value survive when no stored row was supplied', async () => {
    // The degenerate case: Payload always hands `originalDoc` to an update, but
    // if it ever did not, the client's value must still not get through.
    const result = await update(
      { publicationStatus: 'published' },
      { id: 1, session: ANA_SESSION, uploadedBy: ANA, organization: ECO_A },
      ANA,
    )
    expect(result.publicationStatus).toBeUndefined()
  })

  it('holds an IN-FLIGHT publication state across an unrelated edit', async () => {
    // A rename during a publish must not roll the row back to `draft` — that
    // would lose the state machine's place and hide an in-progress move.
    const result = await update(
      { name: 'renamed-mid-publish.pdf' },
      {
        id: 1,
        session: ANA_SESSION,
        uploadedBy: ANA,
        organization: ECO_A,
        publicationStatus: 'publishing',
      },
      ANA,
    )
    expect(result.publicationStatus).toBe('publishing')
  })

  it('keeps uploadedBy immutable across updates', async () => {
    const result = await update(
      { uploadedBy: BEN },
      { id: 1, session: ANA_SESSION, uploadedBy: ANA, organization: ECO_A },
      ANA,
    )
    expect(result.uploadedBy).toBe(ANA)
  })
})

describe('uploading with no conversation attached', () => {
  it('derives the ecosistema when there is exactly one', async () => {
    const result = await create({ name: 'standalone.pdf' }, ANA)
    expect(result.organization).toBe(ECO_A)
    expect(result.uploadedBy).toBe(ANA)
  })

  it('REFUSES rather than guessing when the person belongs to several', async () => {
    // Guessing would file the document — and everything derived from it — under
    // the wrong customer, silently.
    await expect(create({ name: 'ambiguous.pdf' }, DUAL)).rejects.toThrow()
  })

  it('REFUSES when the person belongs to none', async () => {
    await expect(create({ name: 'homeless.pdf' }, NOBODY)).rejects.toThrow()
  })
})

describe('server-side writes', () => {
  // The ingest hook and the publish state machine write with overrideAccess and
  // no user. Those must pass through: they have no session to impersonate, and
  // failing them would strand every upload in `extracting`.
  it('pass through untouched when there is no authenticated user', async () => {
    const result = await create({ session: CARLA_SESSION, ingestStatus: 'ready' }, null)
    expect(result.ingestStatus).toBe('ready')
    expect(result.organization).toBeUndefined()
    expect(result.publicationStatus).toBeUndefined()
  })
})
