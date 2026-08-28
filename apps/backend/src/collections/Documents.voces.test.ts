/**
 * 🔴 WHO MAY FILE SOMEBODY ELSE'S WORDS — the Investigador upload gate.
 *
 * A `testimonio` (a Voz) is not the uploader's own material. It is a person's
 * testimony, collected offline and filed under the Investigador's name; it goes
 * through the anonymisation gate and lands in the ecosistema's SHARED corpus as
 * an anonymous voice. That is a different act from uploading a PDF you own, so
 * it rides on its own permission (`voces:upload`) rather than on
 * `documents:write` — otherwise any participant who put `contentKind:
 * 'testimonio'` in a request body would be publishing an unattributable
 * document into their colleagues' corpus.
 *
 * Three properties are load-bearing here, and each fails silently:
 *
 *   1. 🔴 THE PERMISSION IS HELD *IN* AN ORGANIZATION. An Investigador of
 *      ecosistema B has no standing in ecosistema A. A global "is this person an
 *      investigador anywhere" check would be a cross-tenant hole.
 *   2. 🔴 `contentKind` IS IMMUTABLE. Without that the check is a formality:
 *      create a `documento`, PATCH it to `testimonio`, and the gate has already
 *      been skipped because it runs at INGEST time. Worse, the ingested chunk
 *      keeps saying `documento` while the row claims otherwise — and the chunk
 *      is the copy retrieval actually reads.
 *   3. 🔴 `conversacion` IS NEVER ACCEPTED FROM A BODY, by anyone. Conversation
 *      chunks are produced from `messages` rows; a hand-written one would wear
 *      the "this came from a previous answer" label that citations trust.
 *
 * Tested at the hook, the way `Documents.tenancy.test.ts` does, because that is
 * where the rule actually runs — `create` access on this collection is only "any
 * signed-in user".
 */

import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { bindDocumentToEcosystem, planIngestRetry } from './Documents'

const ECO_A = 10
const ECO_B = 20

const ANA = 1 // plain `member` of ECO_A
const IRIS = 2 // `investigador` of ECO_A
const IVAN = 3 // `investigador` of ECO_B — and only a `member` of ECO_A
const ADA = 4 // `admin` of ECO_A
const OSCAR = 5 // `owner` of ECO_A
const ROOT = 6 // platform admin, with a session in ECO_A

/** Every user's memberships: `[organization, role]`. */
const MEMBERSHIPS: Record<number, Array<[number, string]>> = {
  [ANA]: [[ECO_A, 'member']],
  [IRIS]: [[ECO_A, 'investigador']],
  // ⚠ THE CROSS-TENANT CASE. Ivan really is an Investigador — just not here.
  [IVAN]: [[ECO_B, 'investigador'], [ECO_A, 'member']],
  [ADA]: [[ECO_A, 'admin']],
  [OSCAR]: [[ECO_A, 'owner']],
  [ROOT]: [[ECO_A, 'member']],
}

/** One session per user, all in ECO_A, so every upload lands in the same tenant. */
const SESSION_OF: Record<number, number> = {
  [ANA]: 101,
  [IRIS]: 102,
  [IVAN]: 103,
  [ADA]: 104,
  [OSCAR]: 105,
  [ROOT]: 106,
}

function reqAs(userId: number): PayloadRequest {
  const sessions = Object.fromEntries(
    Object.entries(SESSION_OF).map(([uid, sid]) => [
      String(sid),
      { user: Number(uid), organization: ECO_A },
    ]),
  )

  return {
    user: { id: userId, isActive: true, isPlatformAdmin: userId === ROOT },
    payload: {
      findByID: vi.fn(async ({ id }: { id: number | string }) => {
        const row = sessions[String(id)]
        if (!row) throw new Error('NotFound')
        return { id, ...row }
      }),
      find: vi.fn(async ({ collection }: { collection: string }) => {
        const rows = MEMBERSHIPS[userId] ?? []
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
        // `organizations`, resolved from the membership rows above.
        return { docs: rows.map(([org]) => ({ id: org, slug: `eco-${org}`, isActive: true })) }
      }),
    },
  } as unknown as PayloadRequest
}

const create = (data: Record<string, unknown>, userId: number) =>
  bindDocumentToEcosystem({
    data: { session: SESSION_OF[userId], name: 'voz.mp3', ...data },
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

/**
 * Assert the hook refused, that it blamed `contentKind`, and that the refusal is
 * in SPANISH — this message reaches an Investigador in the field, and an English
 * validation string is a message nobody can act on.
 */
async function expectContentKindRefusal(promise: Promise<unknown>, fragment: string) {
  let thrown: unknown
  try {
    await promise
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected the upload gate to refuse this write').toBeDefined()
  const said = `${String((thrown as { message?: unknown })?.message ?? '')} ${JSON.stringify(
    (thrown as { data?: unknown })?.data ?? {},
  )}`
  expect(said).toContain('contentKind')
  expect(said).toContain(fragment)
  return thrown
}

// ---------------------------------------------------------------------------

describe('🔴 filing a Voz (contentKind: testimonio)', () => {
  it('REFUSES a plain member, in Spanish, on the contentKind path', async () => {
    // Without this, any participant could publish an unattributable document
    // into their whole ecosistema's shared corpus from a request body.
    await expectContentKindRefusal(
      create({ contentKind: 'testimonio' }, ANA),
      'Solo una persona con el rol de Investigador',
    )
  })

  it('ALLOWS an investigador in that ecosistema', async () => {
    const result = await create({ contentKind: 'testimonio' }, IRIS)
    expect(result.contentKind).toBe('testimonio')
    expect(result.organization).toBe(ECO_A)
    // ⚠ `uploadedBy` is still the Investigador: it records WHO PERFORMED THE
    // UPLOAD. The words are somebody else's and the system never learns whose.
    expect(result.uploadedBy).toBe(IRIS)
  })

  it('🔴 REFUSES an investigador of a DIFFERENT ecosistema', async () => {
    // Ivan holds `voces:upload` — in ECO_B. Here he is an ordinary member. A
    // global "is this person an investigador" check would pass this write, and
    // that is a cross-tenant hole: he would be filing anonymous testimony into a
    // corpus he has no standing in.
    await expectContentKindRefusal(
      create({ contentKind: 'testimonio' }, IVAN),
      'Solo una persona con el rol de Investigador',
    )
  })

  it('ALLOWS an admin — the rank outranks investigador and carries its grants', async () => {
    // ⚠ ADMIN_PERMISSIONS is built on INVESTIGADOR_PERMISSIONS. A rank that did
    // not come with the lower role's grants would show up as an admin being
    // refused something a colleague can do.
    const result = await create({ contentKind: 'testimonio' }, ADA)
    expect(result.contentKind).toBe('testimonio')
  })

  it('ALLOWS an owner', async () => {
    const result = await create({ contentKind: 'testimonio' }, OSCAR)
    expect(result.contentKind).toBe('testimonio')
  })

  it('ALLOWS a platform admin', async () => {
    const result = await create({ contentKind: 'testimonio' }, ROOT)
    expect(result.contentKind).toBe('testimonio')
  })
})

describe('🔴 contentKind: conversacion is never accepted from a request body', () => {
  // 🔴 Conversation chunks are produced by `lib/conversationIngest.ts` from
  // `messages` rows. A hand-written `documents` row claiming to be one would be
  // a fabricated chunk wearing the "this came from a previous answer" label that
  // citations trust — the mitigation for the ingest feedback loop, turned into
  // an attack surface.
  it('REFUSES a plain member', async () => {
    await expectContentKindRefusal(
      create({ contentKind: 'conversacion' }, ANA),
      'Las conversaciones entran al corpus solas',
    )
  })

  it('REFUSES an investigador — the Voz permission does not cover it', async () => {
    await expectContentKindRefusal(
      create({ contentKind: 'conversacion' }, IRIS),
      'Las conversaciones entran al corpus solas',
    )
  })

  it('REFUSES an owner', async () => {
    await expectContentKindRefusal(
      create({ contentKind: 'conversacion' }, OSCAR),
      'Las conversaciones entran al corpus solas',
    )
  })

  it('REFUSES A PLATFORM ADMIN TOO — the check runs BEFORE the admin bypass', async () => {
    // Verified against the code: `declared === 'conversacion'` throws above the
    // `isPlatformAdminUser` early return, so there is no ordinary create path
    // that produces one. This is not a permission question — there is no role
    // for which a hand-written conversation chunk is a legitimate object.
    await expectContentKindRefusal(
      create({ contentKind: 'conversacion' }, ROOT),
      'Las conversaciones entran al corpus solas',
    )
  })
})

describe('🔴 contentKind is immutable after creation', () => {
  it('a documento PATCHed to testimonio stays a documento', async () => {
    // Without this the permission check is a formality: the anonymisation gate
    // runs at INGEST time, which has already happened by the time the PATCH
    // lands. The row would claim `testimonio` while the chunk already in the
    // corpus — the copy retrieval reads — says `documento`, unscrubbed.
    const created = await create({ contentKind: 'documento' }, ANA)
    expect(created.contentKind).toBe('documento')

    const patched = await update(
      { contentKind: 'testimonio' },
      {
        id: 1,
        session: SESSION_OF[ANA],
        uploadedBy: ANA,
        organization: ECO_A,
        publicationStatus: 'draft',
        contentKind: created.contentKind,
      },
      ANA,
    )
    expect(patched.contentKind).toBe('documento')
  })

  it('an investigador cannot re-label their own documento either', async () => {
    // The rule is about the ORDER of the gate, not about who is asking. Even
    // someone entitled to file a Voz must file it AS one, at creation.
    const patched = await update(
      { contentKind: 'testimonio' },
      {
        id: 2,
        session: SESSION_OF[IRIS],
        uploadedBy: IRIS,
        organization: ECO_A,
        contentKind: 'documento',
      },
      IRIS,
    )
    expect(patched.contentKind).toBe('documento')
  })

  it('a testimonio cannot be downgraded to a documento', async () => {
    // The other direction matters too: `contentKind` is what the ingest reads
    // to decide the gate runs at all.
    const patched = await update(
      { contentKind: 'documento' },
      {
        id: 3,
        session: SESSION_OF[IRIS],
        uploadedBy: IRIS,
        organization: ECO_A,
        contentKind: 'testimonio',
      },
      IRIS,
    )
    expect(patched.contentKind).toBe('testimonio')
  })

  it('PINS to the stored value rather than deleting the key', async () => {
    // ⚠ `contentKind` is `required: true`. Deleting it on update does not
    // "ignore the client's value" — it removes a required field from the
    // document about to be validated, and EVERY authenticated PATCH 400s,
    // rename included. Same bug shape as `publicationStatus`; see
    // `Documents.tenancy.test.ts`.
    const patched = await update(
      { name: 'renombrado.pdf' },
      { id: 4, session: SESSION_OF[ANA], uploadedBy: ANA, organization: ECO_A, contentKind: 'testimonio' },
      ANA,
    )
    expect(patched.contentKind).toBe('testimonio')
    expect(patched.name).toBe('renombrado.pdf')
  })

  it('🔴 writes NOTHING when the stored value is unreadable, rather than defaulting to `documento`', async () => {
    // 🔴 THE FAIL-OPEN THIS REPLACES. Defaulting an unreadable kind to
    // `documento` looks like the cautious choice and is the opposite: a
    // testimony reclassified as an ordinary document makes `corpusTextFor`
    // select `extractedText` instead of `redactedText`, and the next publish
    // promotes the UNREDACTED original into the ecosistema's shared corpus —
    // which has no per-document delete.
    //
    // This hook exists to stop a client CHANGING the kind, not to invent one.
    // With nothing readable on either side it declines to write the field at
    // all and leaves the NOT NULL column holding whatever it already had.
    const patched = await update(
      { name: 'x.pdf' },
      { id: 5, session: SESSION_OF[ANA], uploadedBy: ANA, organization: ECO_A, contentKind: 'vozzz' },
      ANA,
    )
    expect(patched).not.toHaveProperty('contentKind')
  })

  it('🔴 a client cannot downgrade a stored `testimonio` to `documento`', async () => {
    // The escalation the immutability rule actually blocks: the gate runs at
    // ingest time, so a kind that could change afterwards is a gate that can be
    // skipped after the fact.
    const patched = await update(
      { name: 'x.pdf', contentKind: 'documento' },
      {
        id: 6,
        session: SESSION_OF[ANA],
        uploadedBy: ANA,
        organization: ECO_A,
        contentKind: 'testimonio',
      },
      ANA,
    )
    expect(patched.contentKind).toBe('testimonio')
  })
})

describe('the default', () => {
  it('defaults contentKind to `documento` when the body omits it', async () => {
    // A plain upload is a `documento`. The other two are never a default: a
    // testimonio is chosen explicitly, a conversacion has no user form at all.
    const result = await create({}, ANA)
    expect(result.contentKind).toBe('documento')
  })

  it('normalises a junk contentKind to `documento` rather than refusing', async () => {
    const result = await create({ contentKind: 'no-such-kind' }, ANA)
    expect(result.contentKind).toBe('documento')
  })
})

describe('🔴 a hold is visible and has exactly one way out', () => {
  it('a held document is retryable, and the retry is what clears the hold', () => {
    // 🔴 THE TWO BUGS THIS PINS.
    //
    // (1) A hold used to leave `ingestStatus` at `extracting` / `transcribing` —
    //     non-terminal states with nothing left to move them. To the person who
    //     uploaded a testimony that is indistinguishable from an upload still
    //     working, forever. It is now `failed` with a reason, which is true and
    //     which `planIngestRetry` accepts.
    //
    // (2) `runExtractAndIngest` refuses to re-gate a `held` row on an ordinary
    //     save. Before that, RENAMING a held testimony re-ran the whole gate —
    //     two more model calls, and because the detector IS a model, a chance of
    //     a different verdict. Rename it enough times and one run comes back
    //     `ready`: an "ingest anyway" button nobody meant to build.
    //
    // So the ONLY way out is this explicit retry, and it must clear the hold or
    // it would answer 202 and then do nothing at all.
    expect(
      planIngestRetry({
        kind: 'audio',
        ingestStatus: 'failed',
        extractedText: 'el testimonio completo',
        anonymisationStatus: 'held',
      }),
    ).toMatchObject({
      ingestStatus: 'pending',
      anonymisationStatus: 'n/a',
      anonymisationError: null,
    })
  })

  it('a row that is not terminally failed has nothing to retry', () => {
    // Re-running a job that is still going would double-transcribe and leave two
    // callbacks racing for one row.
    expect(planIngestRetry({ kind: 'audio', ingestStatus: 'embedding' })).toBeNull()
  })
})
