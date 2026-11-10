/**
 * Selection, the offline town check, and the one-at-a-time reset for the
 * place-only re-gate. No model call: the gate is a recorded stub here.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const { everySurvivorIsTown, isPlaceOnlyHold, regatePlaceOnlyHolds } = await import('./regatePlaceHolds')

type Row = Record<string, unknown>

/** Survivors as the gate stores them: offsets into `heldText`, type only. */
function spansOf(heldText: string, findings: string[]): Array<{ start: number; end: number; type: string }> {
  return findings.map((f) => {
    const start = heldText.indexOf(f)
    if (start === -1) throw new Error(`not in text: ${f}`)
    return { start, end: start + f.length, type: 'lugar' }
  })
}

const TOWNS = 'Vivo en Xoxocotla, Morelos, con [Persona A].'
const COLONIA = 'Vivo en Santa Úrsula con [Persona A].'

const hold = (id: number, over: Row = {}): Row => ({
  id,
  organization: 1,
  contentKind: 'testimonio',
  publicationStatus: 'draft',
  anonymisationStatus: 'held',
  anonymisationError: 'verify: Quedaron 2 datos que podrían identificar a alguien.',
  heldText: TOWNS,
  anonymisationSurvivors: spansOf(TOWNS, ['Xoxocotla', 'Morelos']),
  ...over,
})

describe('isPlaceOnlyHold', () => {
  it.each([
    ['place-only verify hold', hold(1), true],
    ['a person among the findings', hold(1, { anonymisationSurvivors: [{ start: 0, end: 3, type: 'lugar' }, { start: 4, end: 8, type: 'persona' }] }), false],
    ['an "otro" finding', hold(1, { anonymisationSurvivors: [{ start: 0, end: 3, type: 'otro' }] }), false],
    ['no survivors recorded', hold(1, { anonymisationSurvivors: [] }), false],
    ['a structural hold', hold(1, { anonymisationError: 'structural: vacío' }), false],
    ['a published row', hold(1, { publicationStatus: 'published' }), false],
    ['a rejected row', hold(1, { anonymisationStatus: 'rejected' }), false],
    ['a documento', hold(1, { contentKind: 'documento' }), false],
  ])('%s → %s', (_case, row, expected) => {
    expect(isPlaceOnlyHold(row)).toBe(expected)
  })
})

describe('everySurvivorIsTown — offline, against heldText', () => {
  it('towns pass', () => {
    expect(everySurvivorIsTown(hold(1))).toBe(true)
  })
  it('🔴 a colonia-like name stays held', () => {
    expect(everySurvivorIsTown(hold(1, { heldText: COLONIA, anonymisationSurvivors: spansOf(COLONIA, ['Santa Úrsula']) }))).toBe(false)
  })
  it('one non-town among towns stays held', () => {
    const text = 'Vivo en Xoxocotla, en la colonia Portales.'
    expect(everySurvivorIsTown(hold(1, { heldText: text, anonymisationSurvivors: spansOf(text, ['Xoxocotla', 'Portales']) }))).toBe(false)
  })
  it('no heldText or broken offsets: stays held', () => {
    expect(everySurvivorIsTown(hold(1, { heldText: null }))).toBe(false)
    expect(everySurvivorIsTown(hold(1, { anonymisationSurvivors: [{ start: 5, end: 2, type: 'lugar' }] }))).toBe(false)
  })
})

describe('regatePlaceOnlyHolds', () => {
  function fakeDb(rows: Row[]) {
    const store = rows.map((r) => ({ ...r }))
    const payload = {
      find: vi.fn(async () => ({ docs: store.map((r) => ({ ...r })) })),
      update: vi.fn(async (args: { where: { and: Array<Record<string, { equals: unknown }>> }; data: Row }) => {
        const hits = store.filter((r) =>
          args.where.and.every((c) => Object.entries(c).every(([k, op]) => r[k] === op.equals)),
        )
        for (const r of hits) Object.assign(r, args.data)
        return { docs: hits }
      }),
      db: {} as never,
    }
    return { payload, store }
  }

  const rows = () => [
    hold(1),
    hold(2, { anonymisationSurvivors: [{ start: 0, end: 1, type: 'persona' }] }),
    hold(3, { heldText: COLONIA, anonymisationSurvivors: spansOf(COLONIA, ['Santa Úrsula']) }),
    hold(4, { organization: 3 }),
  ]

  it('🔴 a row held for consent is never reset or gated (query, per row, and a fresh read before the reset)', async () => {
    const db = fakeDb([hold(1, { consentHeld: true }), hold(4, { organization: 3 })])
    const gate = vi.fn()
    const report = await regatePlaceOnlyHolds(db.payload as never, { apply: true, gate })
    const where = (db.payload.find.mock.calls[0] as unknown as [{ where: { and: unknown[] } }])[0].where.and
    expect(where).toContainEqual({ consentHeld: { not_equals: true } })
    expect(gate.mock.calls.map((c) => c[1])).toEqual(['4'])
    expect(report).toMatchObject({ matched: 1, regated: 1, ids: ['4'] })
    expect(db.store[0]!.anonymisationStatus).toBe('held')

    // Held between the read and the reset: the fresh read stops it.
    const late = fakeDb([hold(1)])
    ;(late.payload as { db: unknown }).db = {
      drizzle: { execute: vi.fn(async () => ({ rows: [{ consent_held: true }] })) },
    }
    const gate2 = vi.fn()
    expect(await regatePlaceOnlyHolds(late.payload as never, { apply: true, gate: gate2 })).toMatchObject({ regated: 0 })
    expect(gate2).not.toHaveBeenCalled()
    expect(late.store[0]!.anonymisationStatus).toBe('held')
  })

  it('dry run lists, writes nothing, gates nothing', async () => {
    const db = fakeDb(rows())
    const gate = vi.fn()
    const report = await regatePlaceOnlyHolds(db.payload as never, { apply: false, gate })
    expect(report).toMatchObject({ placeOnly: 3, matched: 2, regated: 0, ids: ['1', '4'], kept: ['3'] })
    expect(db.payload.update).not.toHaveBeenCalled()
    expect(gate).not.toHaveBeenCalled()
  })

  it('🔴 apply resets and gates ONE row at a time', async () => {
    const db = fakeDb(rows())
    const order: string[] = []
    const gate = vi.fn(async (org: number, id: string) => {
      // When row 1 is gated, row 4 must not have been reset yet.
      order.push(`gate ${id} (row 4 is ${String(db.store[3]!.anonymisationStatus)})`)
      expect(org).toBe(id === '4' ? 3 : 1)
    })
    const report = await regatePlaceOnlyHolds(db.payload as never, { apply: true, gate })
    expect(report).toMatchObject({ matched: 2, regated: 2 })
    expect(order).toEqual(['gate 1 (row 4 is held)', 'gate 4 (row 4 is n/a)'])
    expect(db.store[0]).toMatchObject({ anonymisationStatus: 'n/a', heldText: null, publicationStatus: 'draft' })
    // The person hold and the colonia hold are untouched.
    expect(db.store[1]!.anonymisationStatus).toBe('held')
    expect(db.store[2]!.anonymisationStatus).toBe('held')
  })
})
