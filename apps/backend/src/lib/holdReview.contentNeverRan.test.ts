/**
 * RETENCIÓN 1129 (dev, held since 2026-10-28, `json-invalido`, P-01).
 *
 * Before 2026-11-10 a `content` hold whose model never answered stored
 * stage 2's output as `heldText` (`gate.ts` at 727bb808, line 744:
 * `redactedText: deterministic.text`): members, emails and phones out, every
 * other name still in. The gate no longer writes that text (`gate.ts`,
 * "NO TEXT TRAVELS WITH THIS HOLD"), but rows held the old way still carry it.
 *
 * `holdReview.ts` now hides that text and refuses every approval of such a
 * hold (`modelNeverRan`): rejecting is the only way out.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { HoldReviewInputError, decideOnHold, heldDocument } from './holdReview'

const ORG = 7
const DOC = 1129
const REVIEWER = 42
const NAME = 'Gumersinda Talavera'
/** Stage 2's output: nothing a model checked. */
const LEGACY_HELD_TEXT = `Fui con ${NAME} a la clínica y esperamos dos horas.`

const LEGACY_ROW = {
  id: DOC,
  name: 'Un sordo espera dos horas en la clínica',
  organization: ORG,
  contentKind: 'testimonio',
  anonymisationStatus: 'held',
  anonymisationError:
    'content: La revisión automática no pudo terminar (json-invalido). Todavía no se agregó a la búsqueda.',
  anonymisationReport: { stages: [], pseudonyms: 0, addresses: 0, model: 'static' },
  anonymisationSurvivors: null,
  heldText: LEGACY_HELD_TEXT,
  extractedText: LEGACY_HELD_TEXT,
  updatedAt: '2026-10-28T10:00:00.000Z',
}

function fakePayload(rows: Array<Record<string, unknown>> = [LEGACY_ROW]) {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<{ id: unknown; data: Record<string, unknown> }> = []
  const find = vi.fn(async (args: { collection: string }) => {
    if (args.collection === 'memberships') {
      return { docs: [{ id: 1, user: REVIEWER, organization: ORG, role: 'investigador', isActive: true }] }
    }
    if (args.collection === 'organizations') return { docs: [{ id: ORG, slug: 'eco', isActive: true }] }
    if (args.collection === 'documents') return { docs: rows }
    return { docs: [] }
  })
  const payload = {
    find,
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data)
      return { id: 500 }
    }),
    update: vi.fn(async (args: { id: unknown; data: Record<string, unknown> }) => {
      updated.push({ id: args.id, data: args.data })
      return {}
    }),
    delete: vi.fn(async () => ({ docs: [] })),
    logger: { warn: vi.fn() },
  } as unknown as Payload
  return { payload, created, updated }
}

const user = { id: REVIEWER, isActive: true, isPlatformAdmin: false }

describe('a legacy `content` hold whose model never ran (1129)', () => {
  it('approving as-is is refused (holds today)', async () => {
    const { payload, created } = fakePayload()
    await expect(decideOnHold({ payload, documentId: DOC, user, decision: 'approve' })).rejects.toThrow(
      HoldReviewInputError,
    )
    expect(created).toHaveLength(0)
  })

  it('rejecting works and wipes the old text (holds today)', async () => {
    const { payload, updated } = fakePayload()
    const outcome = await decideOnHold({ payload, documentId: DOC, user, decision: 'reject' })
    expect(outcome.decision).toBe('rejected')
    expect(updated[0]!.data.heldText).toBeNull()
  })

  // GAP 1: Revisión shows stage 2's near-raw text to every reviewer.
  it('Revisión does not show the old near-raw `heldText`', async () => {
    const { payload } = fakePayload()
    const detail = await heldDocument({ payload, documentId: DOC, user })
    expect(detail.heldText).toBeNull()
  })

  // GAP 2: "edited" is only `text !== heldText`, so one added space approves
  // a text no model checked, with every name in it, into the corpus.
  it('a one-character "edit" of the old text is not an approval', async () => {
    const { payload, created, updated } = fakePayload()
    await expect(
      decideOnHold({ payload, documentId: DOC, user, decision: 'approve', text: `${LEGACY_HELD_TEXT} ` }),
    ).rejects.toThrow(HoldReviewInputError)
    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(0)
  })

  // GAP 3: the same through the API on a NEW row (heldText null): the UI shows
  // only "reject" (`NO_CHECKED_TEXT_NOTICE`), the backend accepts any text.
  it('a new never-ran hold (no heldText) is not approvable through the API either', async () => {
    const { payload, created } = fakePayload([{ ...LEGACY_ROW, heldText: null }])
    await expect(
      decideOnHold({ payload, documentId: DOC, user, decision: 'approve', text: `Fui con ${NAME}.` }),
    ).rejects.toThrow(HoldReviewInputError)
    expect(created).toHaveLength(0)
  })
})
