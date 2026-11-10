/**
 * OLA 4, CARRIL F: a `verify` hold whose verification never finished.
 *
 * `gate.ts` holds with `stage: 'verify'` and "La segunda revisión automática
 * no pudo terminar (…)" when the detector throws during a verify round
 * (transport, invalid JSON, timeout). Its `heldText` is stage 3's output: a
 * model redacted it, none checked the result. So, like a `content` hold
 * (P-01), it is approved only with an edit, never as-is, and an "edit" that
 * only changes spacing, punctuation or case is not one.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { HoldContentAsIsError, decideOnHold, heldDocument, substantivelyEdited } from './holdReview'

const ORG = 7
const DOC = 77
const REVIEWER = 42
const HELD_TEXT = 'Vivo en [Domicilio A] con Gumersinda Talavera.\nNos vimos el martes.'

const ROW = {
  id: DOC,
  name: 'x',
  organization: ORG,
  contentKind: 'testimonio',
  anonymisationStatus: 'held',
  anonymisationError:
    'verify: La segunda revisión automática no pudo terminar (json-invalido). Todavía no se agregó a la búsqueda.',
  anonymisationReport: { stages: [], pseudonyms: 0, addresses: 1, model: 'static' },
  anonymisationSurvivors: null,
  heldText: HELD_TEXT,
  extractedText: HELD_TEXT,
  updatedAt: '2026-11-10T10:00:00.000Z',
}

function fakePayload(rows: Array<Record<string, unknown>> = [ROW]) {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const payload = {
    find: vi.fn(async (args: { collection: string }) => {
      if (args.collection === 'memberships') {
        return { docs: [{ id: 1, user: REVIEWER, organization: ORG, role: 'investigador', isActive: true }] }
      }
      if (args.collection === 'organizations') return { docs: [{ id: ORG, slug: 'eco', isActive: true }] }
      if (args.collection === 'documents') return { docs: rows }
      return { docs: [] }
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data)
      return { id: 500 }
    }),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => {
      updated.push(args.data)
      return {}
    }),
    delete: vi.fn(async () => ({ docs: [] })),
    logger: { warn: vi.fn() },
  } as unknown as Payload
  return { payload, created, updated }
}

const user = { id: REVIEWER, isActive: true, isPlatformAdmin: false }
const approve = (payload: Payload, text?: string) =>
  decideOnHold({ payload, documentId: DOC, user, decision: 'approve', ...(text === undefined ? {} : { text }) })

describe('a `verify` hold whose verification never finished', () => {
  it('shows stage 3 text to edit', async () => {
    const { payload } = fakePayload()
    expect((await heldDocument({ payload, documentId: DOC, user })).heldText).toBe(HELD_TEXT)
  })

  it('🔴 is not approved as-is', async () => {
    const { payload, created, updated } = fakePayload()
    await expect(approve(payload)).rejects.toThrow(HoldContentAsIsError)
    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(0)
  })

  it.each([
    ['a trailing space', `${HELD_TEXT} `],
    ['a doubled space and CRLF', HELD_TEXT.replace(' con', '  con').replace('\n', '\r\n')],
    ['a zero-width space', HELD_TEXT.replace('con', 'c​on')],
    ['punctuation only', HELD_TEXT.replace('martes.', 'martes!')],
    ['case only', HELD_TEXT.replace('Gumersinda Talavera', 'gumersinda talavera')],
  ])('🔴 %s is not an edit', async (_label, text) => {
    const { payload, created } = fakePayload()
    await expect(approve(payload, text)).rejects.toThrow(HoldContentAsIsError)
    expect(created).toHaveLength(0)
  })

  it('a real correction is approved and recorded as edited', async () => {
    const corrected = HELD_TEXT.replace('Gumersinda Talavera', '[Persona A]')
    const { payload, created, updated } = fakePayload()
    await approve(payload, corrected)
    expect(updated[0]!.redactedText).toBe(corrected)
    expect(created[0]!.textEdited).toBe(true)
  })

  it('removing one word counts as a correction', async () => {
    const { payload } = fakePayload()
    await expect(approve(payload, HELD_TEXT.replace(' Talavera', ''))).resolves.toMatchObject({ decision: 'approved' })
  })

  it('a verify hold with survivors is still approvable as-is', async () => {
    const row = { ...ROW, anonymisationError: 'verify: La verificación encontró 1 dato(s) personal(es) que siguen en el texto.' }
    const { payload, updated } = fakePayload([row])
    await approve(payload)
    expect(updated[0]!.redactedText).toBe(HELD_TEXT)
  })

  it('🔴 a `content` hold: a whitespace "edit" is not one either (carril D, gap 2)', async () => {
    const row = {
      ...ROW,
      anonymisationError: 'content: La revisión automática señaló un dato que no se pudo ubicar en el texto. x',
    }
    const { payload, created } = fakePayload([row])
    await expect(approve(payload, `${HELD_TEXT}\n`)).rejects.toThrow(HoldContentAsIsError)
    expect(created).toHaveLength(0)
  })
})

describe('substantivelyEdited', () => {
  it('compares words and numbers, not spacing, punctuation or case', () => {
    expect(substantivelyEdited('Ana  vive.', 'ana vive')).toBe(false)
    expect(substantivelyEdited('Ana vive en 3', 'Ana vive en 4')).toBe(true)
    expect(substantivelyEdited('Ana vive', 'vive')).toBe(true)
    expect(substantivelyEdited('x', null)).toBe(true)
  })
})
