import { describe, expect, it, vi } from 'vitest'

import { TITLE_BACKFILL_WHERE, backfillTestimonioTitles, titleSourceOf } from './backfillTestimonioTitles'
import type { TitleGenerator, TitleStore } from './testimonioTitle'

const READY = {
  id: 11,
  organization: 1,
  contentKind: 'testimonio',
  anonymisationStatus: 'ready',
  redactedText: 'Una madre cuenta que la escuela no tenía intérprete de señas para su hijo.',
}
const HELD = {
  id: 12,
  organization: 1,
  contentKind: 'testimonio',
  anonymisationStatus: 'held',
  heldText: 'Fui con Ofelia Ramos al centro de salud por el dengue.',
  anonymisationSurvivors: [{ start: 8, end: 20, type: 'persona' }],
  redactedText: null,
}
const STRUCTURAL = { ...HELD, id: 13, heldText: null }

function fakePayload(docs: Array<Record<string, unknown>>) {
  return { find: vi.fn(async (_args: unknown) => ({ docs })) }
}

function fakes(answers: string[]) {
  const sync = vi.fn(async () => ({ text: answers.shift() ?? '' }))
  const client: TitleGenerator = { generate: { sync } }
  const writes: unknown[][] = []
  const store: TitleStore = {
    otherTitles: async () => [],
    write: async (...args) => {
      writes.push(args)
      return 1
    },
  }
  return { client, sync, store, writes }
}

describe('titleSourceOf', () => {
  it('🔴 a cleared row is titled from redactedText; a held one from heldText, survivors forbidden', () => {
    expect(titleSourceOf(READY)).toEqual({ text: READY.redactedText, source: 'redacted', forbidden: [] })
    expect(titleSourceOf(HELD)).toEqual({ text: HELD.heldText, source: 'held', forbidden: ['Ofelia Ramos'] })
  })

  it('a structural hold (no heldText), a documento, a pending row: nothing', () => {
    expect(titleSourceOf(STRUCTURAL)).toBeNull()
    expect(titleSourceOf({ ...READY, contentKind: 'documento' })).toBeNull()
    expect(titleSourceOf({ ...READY, anonymisationStatus: 'pending' })).toBeNull()
  })
})

describe('backfillTestimonioTitles', () => {
  it('🔴 DRY RUN BY DEFAULT: no model call, counts candidates and input size', async () => {
    const { client, sync, store } = fakes([])
    const report = await backfillTestimonioTitles(fakePayload([READY, HELD, STRUCTURAL]) as never, () => client, { store })
    expect(sync).not.toHaveBeenCalled()
    expect(report).toMatchObject({ apply: false, candidates: 2, held: 1, written: 0, lastId: '12' })
    expect(report.inputChars).toBe(READY.redactedText.length + HELD.heldText.length)
  })

  it('asks for untitled testimonios only, unless force', async () => {
    const p = fakePayload([])
    await backfillTestimonioTitles(p as never, () => fakes([]).client, { organizationId: 2 })
    const where = (p.find.mock.calls[0]![0] as { where: { and: unknown[] } }).where.and
    expect(where).toEqual([...TITLE_BACKFILL_WHERE, { testimonioTitle: { exists: false } }, { organization: { equals: 2 } }])
    const p2 = fakePayload([])
    await backfillTestimonioTitles(p2 as never, () => fakes([]).client, { force: true })
    expect((p2.find.mock.calls[0]![0] as { where: { and: unknown[] } }).where.and).toEqual(TITLE_BACKFILL_WHERE)
  })

  it('with apply: titles each row from its gate output, with the right guard', async () => {
    const { client, store, writes } = fakes([
      'La escuela sin intérprete de señas',
      'Ir al centro de salud por el dengue',
    ])
    const report = await backfillTestimonioTitles(fakePayload([READY, HELD]) as never, () => client, {
      apply: true,
      store,
      sleep: async () => {},
    })
    expect(report).toMatchObject({ apply: true, candidates: 2, written: 2, failed: 0 })
    expect(writes).toEqual([
      [11, 'La escuela sin intérprete de señas', READY.redactedText, 'redacted'],
      [12, 'Ir al centro de salud por el dengue', HELD.heldText, 'held'],
    ])
  })
})
