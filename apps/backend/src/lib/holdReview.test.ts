/**
 * THE REVIEW SURFACE FOR HELD DOCUMENTS.
 *
 * Three properties are worth testing here, and the second and third are the
 * reason this file exists rather than a couple of lines somewhere else:
 *
 *   · 🔴 EVERY ACCESS BRANCH REFUSES 404-SHAPED. Not a member, a member without
 *     `holds:review`, a deactivated account, an unknown id, a document that is
 *     not held — one indistinguishable answer, or this endpoint becomes an
 *     enumeration oracle over every tenant on the installation.
 *   · 🔴 THE AUDIT ROW IS WRITTEN BEFORE THE TEXT MOVES. An approval with no
 *     record is indistinguishable from the gate having been bypassed, and
 *     ai-service has no per-document delete to undo it with.
 *   · 🔴 THE RAW ORIGINAL NEVER LEAVES. Not in a list, not in a detail, not on
 *     an approval — including the approval that edits nothing.
 *
 * Fake Payload throughout. No database, no model, no network.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import {
  HoldNotVisibleError,
  HoldReviewInputError,
  decideOnHold,
  heldDocument,
  listHeldDocuments,
} from './holdReview'
import { PERMISSIONS } from './permissions'

const ORG = 7
const OTHER_ORG = 8
const DOC = 99
const REVIEWER = 42

/** The name that lives in `extractedText` and must never reach a response. */
const NAME = 'María López'
const RAW = `Vivo en Calle Morelos No. 45 con ${NAME}.`
/** What the gate produced before verify refused it — the name survived. */
const HELD_TEXT = `Vivo en [Domicilio A] con ${NAME}.`

const HELD_ROW = {
  id: DOC,
  name: 'Testimonio de María López.m4a',
  organization: ORG,
  contentKind: 'testimonio',
  anonymisationStatus: 'held',
  anonymisationError: 'verify: La verificación encontró 1 dato(s) personal(es) que siguen en el texto.',
  anonymisationReport: { stages: [], pseudonyms: 0, addresses: 1, model: 'static' },
  anonymisationSurvivors: [{ start: 21, end: 33, type: 'persona' }],
  heldText: HELD_TEXT,
  extractedText: RAW,
  updatedAt: '2026-08-28T10:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A Payload whose `memberships`/`organizations` reads decide what the caller
 * holds. `organizationIdsForUserWithPermission` runs for real against these, so
 * the permission→role mapping is exercised rather than stubbed.
 */
function fakePayload(opts: {
  role?: string
  rows?: Array<Record<string, unknown>>
  orgId?: number
} = {}) {
  const { role = 'investigador', rows = [HELD_ROW], orgId = ORG } = opts

  const created: Array<Record<string, unknown>> = []
  const updated: Array<{ id: unknown; data: Record<string, unknown>; context?: unknown }> = []
  const deleted: Array<{ collection: string; where: unknown }> = []
  /** Write order, so "audit first" is assertable rather than assumed. */
  const order: string[] = []

  const find = vi.fn(async (args: { collection: string; where?: unknown }) => {
    if (args.collection === 'memberships') {
      return role === 'none'
        ? { docs: [] }
        : { docs: [{ id: 1, user: REVIEWER, organization: orgId, role, isActive: true }] }
    }
    if (args.collection === 'organizations') {
      return { docs: [{ id: orgId, slug: 'eco', isActive: true }] }
    }
    if (args.collection === 'documents') return { docs: rows }
    return { docs: [] }
  })

  const payload = {
    find,
    create: vi.fn(async (args: { collection: string; data: Record<string, unknown> }) => {
      order.push(`create:${args.collection}`)
      created.push(args.data)
      return { id: 500 }
    }),
    update: vi.fn(
      async (args: { collection: string; id: unknown; data: Record<string, unknown>; context?: unknown }) => {
        order.push(`update:${args.collection}`)
        updated.push({ id: args.id, data: args.data, context: args.context })
        return {}
      },
    ),
    delete: vi.fn(async (args: { collection: string; where: unknown }) => {
      order.push(`delete:${args.collection}`)
      deleted.push({ collection: args.collection, where: args.where })
      return { docs: [] }
    }),
    logger: { warn: vi.fn() },
  } as unknown as Payload

  return { payload, created, updated, order, deleted }
}

const user = (over: Record<string, unknown> = {}) => ({
  id: REVIEWER,
  isActive: true,
  isPlatformAdmin: false,
  ...over,
})

// ---------------------------------------------------------------------------
// Who may review
// ---------------------------------------------------------------------------

describe('holds — 🔴 who may review, and every refusal is 404-shaped', () => {
  it('an Investigador may list the holds of their own ecosistema', async () => {
    const { payload } = fakePayload({ role: 'investigador' })
    const result = await listHeldDocuments({ payload, organizationId: ORG, user: user() })
    expect(result.holds).toHaveLength(1)
  })

  it('an admin and an owner may too — the grant is inherited, not re-granted', async () => {
    // `ADMIN_PERMISSIONS` builds on `INVESTIGADOR_PERMISSIONS`. A rank that does
    // not come with the lower role's grants is a lie that shows up as an admin
    // being refused something a colleague can do.
    for (const role of ['admin', 'owner']) {
      const { payload } = fakePayload({ role })
      await expect(
        listHeldDocuments({ payload, organizationId: ORG, user: user() }),
      ).resolves.toBeTruthy()
    }
  })

  it('🔴 a plain member is refused — reviewing means reading un-cleared text', async () => {
    // `member` holds `documents:read`, so they can see the ROW. This endpoint
    // shows the gate's REFUSED OUTPUT, which is a different thing, and
    // `holds:review` is what separates the two.
    const { payload } = fakePayload({ role: 'member' })
    await expect(listHeldDocuments({ payload, organizationId: ORG, user: user() })).rejects.toThrow(
      HoldNotVisibleError,
    )
  })

  it('🔴 an Investigador of ANOTHER ecosistema is refused', async () => {
    const { payload } = fakePayload({ role: 'investigador', orgId: OTHER_ORG })
    await expect(listHeldDocuments({ payload, organizationId: ORG, user: user() })).rejects.toThrow(
      HoldNotVisibleError,
    )
  })

  it('🔴 a deactivated account is refused, whatever its role says', async () => {
    // Deactivation is the revoke switch at three levels (`lib/permissions.ts`),
    // and it has to bite before any elevated read happens.
    const { payload } = fakePayload({ role: 'owner' })
    await expect(
      listHeldDocuments({ payload, organizationId: ORG, user: user({ isActive: false }) }),
    ).rejects.toThrow(HoldNotVisibleError)
  })

  it('a platform admin may review anywhere', async () => {
    const { payload } = fakePayload({ role: 'none' })
    await expect(
      listHeldDocuments({ payload, organizationId: ORG, user: user({ isPlatformAdmin: true }) }),
    ).resolves.toBeTruthy()
  })

  it('🔴 "not held" is indistinguishable from "no such document"', async () => {
    // Answering differently would let anyone holding the permission ANYWHERE
    // probe whether a given id is held in an ecosistema they cannot see.
    const { payload } = fakePayload({ rows: [] })
    await expect(heldDocument({ payload, documentId: DOC, user: user() })).rejects.toThrow(
      HoldNotVisibleError,
    )
    await expect(
      decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' }),
    ).rejects.toThrow(HoldNotVisibleError)
  })

  it('⚠ every refusal carries the SAME message', async () => {
    const messages = new Set<string>()
    for (const [role, orgId] of [
      ['member', ORG],
      ['investigador', OTHER_ORG],
      ['none', ORG],
    ] as const) {
      const { payload } = fakePayload({ role, orgId })
      await listHeldDocuments({ payload, organizationId: ORG, user: user() }).catch(
        (err: Error) => messages.add(err.message),
      )
    }
    expect(messages.size).toBe(1)
  })

  it('the permission is a real, named grant an Investigador holds', () => {
    expect(PERMISSIONS.holdsReview).toBe('holds:review')
  })
})

// ---------------------------------------------------------------------------
// What a reviewer sees
// ---------------------------------------------------------------------------

describe('holds — 🔴 what the reviewer sees, and what never leaves', () => {
  it('shows the gate’s refused output, the report and the survivor offsets', async () => {
    const { payload } = fakePayload()
    const detail = await heldDocument({ payload, documentId: DOC, user: user() })

    expect(detail.heldText).toBe(HELD_TEXT)
    expect(detail.stage).toBe('verify')
    expect(detail.reason).toContain('1 dato(s) personal(es)')
    expect(detail.survivors).toEqual([{ start: 21, end: 33, type: 'persona' }])
    expect(detail.report?.addresses).toBe(1)
  })

  it('🔴 never returns `extractedText` — the raw original', async () => {
    // The job is to judge the REDACTION. Handing over the original would make
    // every review a second full disclosure of the material the gate protects.
    const { payload } = fakePayload()
    const detail = await heldDocument({ payload, documentId: DOC, user: user() })
    expect(detail).not.toHaveProperty('extractedText')
    expect(JSON.stringify(detail)).not.toContain('Calle Morelos')
  })

  it('🔴 the queue carries NO text at all, and no uploader-typed name', async () => {
    // `documents.name` is free text nobody gated — "Testimonio de María
    // López.m4a" is the exact failure `lib/contentKind.ts` documents, and a
    // queue screen would leak it on the index page before anyone opened a thing.
    const { payload } = fakePayload()
    const { holds } = await listHeldDocuments({ payload, organizationId: ORG, user: user() })

    const serialized = JSON.stringify(holds)
    expect(serialized).not.toContain(NAME)
    expect(serialized).not.toContain(HELD_TEXT)
    expect(serialized).not.toContain('.m4a')
    expect(holds[0]!.title).toBe('Testimonio retenido')
    // The COUNT is fine — it is a number, and it is what triage needs.
    expect(holds[0]!.survivorCount).toBe(1)
  })

  it('a held testimonio with a generated title lists it, the neutral label as secondary', async () => {
    const { payload } = fakePayload({
      rows: [{ ...HELD_ROW, testimonioTitle: 'Vivir con la familia en el barrio' }],
    })
    const { holds } = await listHeldDocuments({ payload, organizationId: ORG, user: user() })
    expect(holds[0]).toMatchObject({
      title: 'Vivir con la familia en el barrio',
      label: 'Testimonio retenido',
      generatedTitle: 'Vivir con la familia en el barrio',
    })
  })

  it('without a generated title the label is the title', async () => {
    const { payload } = fakePayload()
    const { holds } = await listHeldDocuments({ payload, organizationId: ORG, user: user() })
    expect(holds[0]).toMatchObject({ title: 'Testimonio retenido', label: 'Testimonio retenido', generatedTitle: null })
  })

  it('🔴 a rejection clears the title made from the discarded held text', async () => {
    const { payload, updated } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'reject' })
    expect(updated[0]!.data).toHaveProperty('testimonioTitle', null)
  })

  it('⚠ nothing in the response identifies the speaker', async () => {
    const { payload } = fakePayload()
    const detail = await heldDocument({ payload, documentId: DOC, user: user() })
    // These keys do not exist anywhere in `apps/backend/src` except in comments
    // saying why they do not exist. This pins that the review API did not
    // quietly invent one.
    for (const forbidden of ['subject', 'speaker', 'onBehalf', 'consent', 'uploadedBy']) {
      expect(detail).not.toHaveProperty(forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe('holds — 🔴 approving is an audited override, and the only way out', () => {
  it('writes the AUDIT ROW BEFORE it releases the text', async () => {
    // The other order fails the other way: a document released into a permanent
    // corpus with no record of who released it, which is indistinguishable from
    // the gate having been bypassed.
    const { payload, order } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' })

    expect(order).toEqual(['create:anonymisation-reviews', 'update:documents'])
  })

  it('records who, when, and a COPY of the gate report they judged', async () => {
    const { payload, created } = fakePayload()
    await decideOnHold({
      payload,
      documentId: DOC,
      user: user(),
      decision: 'approve',
      note: 'Revisado en campo.',
    })

    const row = created[0]!
    expect(row.reviewer).toBe(REVIEWER)
    expect(row.document).toBe(DOC)
    expect(row.organization).toBe(ORG)
    expect(row.decision).toBe('approved')
    // 🔴 A COPY, not a pointer. The document's report is overwritten by the next
    // gate run, and an audit entry that resolves to "whatever it says today"
    // records nothing about the decision that was actually made.
    expect(row.gateReport).toEqual(HELD_ROW.anonymisationReport)
    expect(row.gateStage).toBe('verify')
    expect(row.note).toBe('Revisado en campo.')
  })

  // 🔴 THE REGRESSION THIS FILE MISSED ONCE, AND WHY.
  //
  // Every test around it passes `documentId: DOC`, a NUMBER. A real HTTP caller
  // cannot: the id arrives from the URL, so the route hands this function the
  // string `'86'`. That string went straight into the audit row's `document`
  // relationship, `documents` has integer ids, and Payload refused it — so
  // EVERY approve and reject failed with a 500 in production while this suite
  // stayed green. The fix reads `row.id` (what Payload returned for the row we
  // just validated) instead of the caller's parameter.
  //
  // These two tests exist to keep the string path exercised. Testing only the
  // convenient type is how the bug survived review.
  it('accepts a STRING id, the way an HTTP route always passes it', async () => {
    const { payload, created, order } = fakePayload()
    await decideOnHold({ payload, documentId: String(DOC), user: user(), decision: 'approve' })

    expect(order).toEqual(['create:anonymisation-reviews', 'update:documents'])
    // The relationship carries the row's own id, so it is a number even though
    // the caller passed a string.
    expect(created[0]!.document).toBe(DOC)
  })

  it('rejects with a STRING id too', async () => {
    const { payload, created } = fakePayload()
    await decideOnHold({ payload, documentId: String(DOC), user: user(), decision: 'reject' })

    expect(created[0]!.document).toBe(DOC)
    expect(created[0]!.decision).toBe('rejected')
  })

  it('approving without an edit releases the GATE’S output, never the original', async () => {
    const { payload, updated, created } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' })

    const write = updated[0]!.data
    expect(write.redactedText).toBe(HELD_TEXT)
    expect(write.redactedText).not.toBe(RAW)
    expect(write.anonymisationStatus).toBe('approved')
    expect(created[0]!.textEdited).toBe(false)
  })

  it('🔴 an EDITED redaction is what gets embedded, and the original still never does', async () => {
    const corrected = 'Vivo en [Domicilio A] con [Persona A].'
    const { payload, updated, created } = fakePayload()
    await decideOnHold({
      payload,
      documentId: DOC,
      user: user(),
      decision: 'approve',
      text: corrected,
    })

    const write = updated[0]!.data
    expect(write.redactedText).toBe(corrected)
    // `extractedText` is untouched: it stays in Postgres as the record of what
    // was actually said, and the ingest path reads `redactedText`.
    expect(write).not.toHaveProperty('extractedText')
    expect(JSON.stringify(write)).not.toContain(NAME)
    expect(created[0]!.textEdited).toBe(true)
  })

  it('clears the held text and the survivors on the way out', async () => {
    // They are offsets into a string that is about to stop being current. Left
    // behind, they would show the next reader last time's flags over this time's
    // text.
    const { payload, updated } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' })
    expect(updated[0]!.data.heldText).toBeNull()
    expect(updated[0]!.data.anonymisationSurvivors).toBeNull()
  })

  it('🔴 clears the title made from the held text; the ingest hook re-titles from the approved text', async () => {
    const { payload, updated } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' })
    expect(updated[0]!.data).toHaveProperty('testimonioTitle', null)
  })

  it('⚠ re-enters the ORDINARY ingest hook — no second, subtly-different path', async () => {
    // `__skipDocsExtract` absent is the mechanism: the afterChange hook picks the
    // row up, sees `approved`, skips the gate and enqueues `redactedText`.
    const { payload, updated } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' })
    expect(updated[0]!.context).toBeUndefined()
    expect(updated[0]!.data.ingestStatus).toBe('pending')
  })

  it('🔴 REFUSES an empty approved text', async () => {
    // An empty chunk matches nothing and can never be found or corrected — the
    // same silent permanent hole the gate's structural stage holds on.
    const { payload, created } = fakePayload()
    for (const text of ['', '   ']) {
      await expect(
        decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve', text }),
      ).rejects.toThrow(HoldReviewInputError)
    }
    // ⚠ And no audit row was written for a decision that did not happen.
    expect(created).toHaveLength(0)
  })

  it('🔴 refuses to approve a hold that produced no text, rather than reaching for the original', async () => {
    // A `structural` hold has no output. The tempting fallback is
    // `extractedText`, which is the raw original — so there is no fallback.
    const { payload } = fakePayload({ rows: [{ ...HELD_ROW, heldText: null }] })
    await expect(
      decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' }),
    ).rejects.toThrow(HoldReviewInputError)
  })

  it('rejecting is terminal, audited, and wipes the reviewable text', async () => {
    const { payload, created, updated } = fakePayload()
    const outcome = await decideOnHold({
      payload,
      documentId: DOC,
      user: user(),
      decision: 'reject',
      note: 'No se puede anonimizar sin destruirlo.',
    })

    expect(outcome.anonymisationStatus).toBe('rejected')
    expect(created[0]!.decision).toBe('rejected')
    const write = updated[0]!.data
    expect(write.anonymisationStatus).toBe('rejected')
    expect(write.heldText).toBeNull()
    // 🔴 `redactedText` is CLEARED, not merely left alone. A rejected row can
    // still be carrying a redaction from an earlier run that cleared the gate,
    // and the publish path reads that column without re-running the gate — so
    // "never ingested" is only true if the column is emptied.
    expect(write.redactedText).toBeNull()
  })

  it('🔴 a rejection drops the document\'s graph rows and marks it skipped', async () => {
    const { payload, updated, deleted } = fakePayload()
    await decideOnHold({ payload, documentId: DOC, user: user(), decision: 'reject' })
    expect(deleted.map((d) => d.collection)).toEqual(['graphMentions', 'graphRelations'])
    for (const d of deleted) {
      expect((d.where as { and: unknown[] }).and).toEqual(
        expect.arrayContaining([{ organization: { equals: ORG } }, { document: { equals: DOC } }]),
      )
    }
    expect(updated.at(-1)!.data).toMatchObject({ graphStatus: 'skipped' })
  })

  it('🔴 a rejection cannot be re-decided through this API', async () => {
    // Only `held` rows are reviewable. A settled row is not in the queue and
    // cannot be reached by id either — the same 404 as everything else.
    const { payload } = fakePayload({ rows: [] })
    await expect(
      decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' }),
    ).rejects.toThrow(HoldNotVisibleError)
  })

  it('⚠ a member cannot decide, and nothing is written when they try', async () => {
    const { payload, created, updated } = fakePayload({ role: 'member' })
    await expect(
      decideOnHold({ payload, documentId: DOC, user: user(), decision: 'approve' }),
    ).rejects.toThrow(HoldNotVisibleError)
    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(0)
  })

  it('rejects a junk `decision` without touching anything', async () => {
    const { payload, created } = fakePayload()
    await expect(
      decideOnHold({
        payload,
        documentId: DOC,
        user: user(),
        decision: 'aprobar' as never,
      }),
    ).rejects.toThrow(HoldReviewInputError)
    expect(created).toHaveLength(0)
  })
})
