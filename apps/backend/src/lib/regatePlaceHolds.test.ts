/**
 * Selection and reset for the place-only re-gate. No model call: the gate
 * itself is not run here.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const { isPlaceOnlyHold, resetPlaceOnlyHolds } = await import('./regatePlaceHolds')

type Row = Record<string, unknown>

const hold = (id: number, over: Row = {}): Row => ({
  id,
  organization: 1,
  contentKind: 'testimonio',
  publicationStatus: 'draft',
  anonymisationStatus: 'held',
  anonymisationError: 'verify: Quedaron 2 datos que podrían identificar a alguien.',
  anonymisationSurvivors: [
    { start: 0, end: 5, type: 'lugar' },
    { start: 9, end: 14, type: 'lugar' },
  ],
  heldText: 'texto retenido',
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

describe('resetPlaceOnlyHolds', () => {
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

  it('dry run lists, writes nothing', async () => {
    const db = fakeDb([hold(1), hold(2, { anonymisationSurvivors: [{ start: 0, end: 1, type: 'persona' }] }), hold(3, { organization: 3 })])
    const report = await resetPlaceOnlyHolds(db.payload as never, { apply: false })
    expect(report).toMatchObject({ matched: 2, reset: 0, byOrganization: { '1': ['1'], '3': ['3'] } })
    expect(db.payload.update).not.toHaveBeenCalled()
  })

  it('apply resets only the place-only holds to the retryable state', async () => {
    const db = fakeDb([hold(1), hold(2, { anonymisationSurvivors: [{ start: 0, end: 1, type: 'persona' }] })])
    const report = await resetPlaceOnlyHolds(db.payload as never, { apply: true })
    expect(report).toMatchObject({ matched: 1, reset: 1, byOrganization: { '1': ['1'] } })
    expect(db.store[0]).toMatchObject({ anonymisationStatus: 'n/a', heldText: null, anonymisationSurvivors: null, publicationStatus: 'draft' })
    expect(db.store[1]!.anonymisationStatus).toBe('held')
    // Idempotent.
    const again = await resetPlaceOnlyHolds(db.payload as never, { apply: true })
    expect(again.matched).toBe(0)
  })
})
