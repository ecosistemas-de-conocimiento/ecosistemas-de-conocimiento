/**
 * The one-off reset for rows held only because the detector never answered.
 * 🔴 The property under test: a content hold is never touched.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { isInfraHold, resetInfraHolds } from './resetInfraHolds'

type Row = Record<string, unknown>
type Where = { and?: Array<Record<string, Record<string, unknown>>> }
const NOT_ADDED = 'Por eso todavía no se agregó al acervo.'

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  const matches = (r: Row, where: Where) =>
    (where.and ?? []).every((c) =>
      Object.entries(c).every(([f, op]) =>
        'like' in op
          ? String(r[f] ?? '').includes(String(op.like))
          : String(r[f] ?? '') === String(op.equals),
      ),
    )
  const payload = {
    db: {
      drizzle: {
        execute: async () => {
          throw new Error('unused')
        },
      },
    },
    find: async (args: { where: Where }) => ({
      docs: store.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
    }),
    update: async (args: { where: Where; data: Row }) => {
      const hits = store.filter((r) => matches(r, args.where))
      for (const r of hits) Object.assign(r, args.data)
      return { docs: hits }
    },
  }
  return { payload: payload as never, row: (id: number) => store.find((r) => r.id === id)! }
}

const infra = (id: number, over: Row = {}): Row => ({
  id,
  anonymisationStatus: 'held',
  anonymisationError: `content: La revisión automática no pudo terminar (transporte). ${NOT_ADDED}`,
  heldText: 'texto parcial',
  ingestStatus: 'failed',
  ingestError: `anonymisation_held: content: La revisión automática no pudo terminar (transporte). ${NOT_ADDED}`,
  ...over,
})

const rows = (): Row[] => [
  infra(1),
  infra(2, {
    anonymisationError: `verify: La segunda revisión automática no pudo terminar (tiempo-agotado). ${NOT_ADDED}`,
    ingestStatus: 'pending',
    ingestError: null,
  }),
  // 🔴 content holds and non-infra failures
  infra(3, { anonymisationError: 'verify: La revisión encontró 3 datos señalados.' }),
  infra(4, {
    anonymisationError: `content: La revisión automática no pudo terminar (json-invalido). ${NOT_ADDED}`,
  }),
  infra(5, { anonymisationError: 'gate_crashed: no pudo terminar (transporte)' }),
  infra(6, { anonymisationStatus: 'approved' }),
  infra(7, { anonymisationStatus: 'rejected' }),
]

describe('resetInfraHolds', () => {
  it('matches only the transport/timeout holds', () => {
    expect(rows().filter(isInfraHold).map((r) => r.id)).toEqual([1, 2])
  })

  it('a dry run writes nothing', async () => {
    const db = fakeDb(rows())
    const report = await resetInfraHolds(db.payload, { apply: false })
    expect(report).toMatchObject({ matched: 2, reset: 0, ids: [1, 2] })
    expect(db.row(1).anonymisationStatus).toBe('held')
  })

  it('🔴 apply moves ONLY the infra holds to the retryable state', async () => {
    const db = fakeDb(rows())
    const report = await resetInfraHolds(db.payload, { apply: true })
    expect(report).toMatchObject({ matched: 2, reset: 2 })

    expect(db.row(1)).toMatchObject({ anonymisationStatus: 'n/a', heldText: null, redactedText: null })
    expect(String(db.row(1).anonymisationError)).toMatch(/^gate_unavailable: content: /)
    // The draft-path row is relabelled so the ingest-recovery sweep re-drives it.
    expect(String(db.row(1).ingestError)).toMatch(/^anonymisation_unavailable: content: /)
    // A seed-path row keeps its ingest columns; the seed re-run gates it.
    expect(db.row(2)).toMatchObject({ anonymisationStatus: 'n/a', ingestStatus: 'pending', ingestError: null })

    for (const id of [3, 4, 5, 6, 7]) {
      expect(db.row(id)).toEqual(rows().find((r) => r.id === id))
    }
  })
})
