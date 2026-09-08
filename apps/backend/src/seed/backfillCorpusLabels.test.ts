/**
 * The one-off backfill that puts the corpus's ground truth onto the 250 rows
 * that were seeded before `documents.tema` / `documents.lengua` existed.
 *
 * Two things are worth testing and only one of them is obvious:
 *
 *   · the join (a `SIM_xxxx` id in `documents.name` → `MANIFEST.csv`), and
 *   · 🔴 THE HALF-JOIN. A seeded `testimonio` carries no `SIM_` id, because
 *     `seed/corpus.ts` keeps it off deliberately — that id is a key into a table
 *     with a `nombre` column. So a Voz can only be matched by the theme its own
 *     title prints, gets `tema`, and can never get `lengua`. Both halves of that
 *     are asserted, including the positive one: a documento DOES get a `lengua`,
 *     so "never on a testimonio" cannot pass by the feature being dead.
 */

import { describe, expect, it } from 'vitest'

import { planCorpusLabelBackfill, parseBackfillArgs } from './backfillCorpusLabels'
import { themeFromSeededTitle } from './corpus'

const MANIFEST = new Map([
  ['SIM_0001', { tema: 'traduccion', lengua: 'mazateco' }],
  ['SIM_0002', { tema: 'dengue', lengua: 'mixteco' }],
  ['SIM_0003', { tema: 'escuela', lengua: 'náhuatl' }],
])

describe('themeFromSeededTitle', () => {
  it('round-trips every title shape `seed/corpus.ts` produces', () => {
    expect(themeFromSeededTitle('Testimonio — traducción en salud (01)')).toBe('traduccion')
    expect(themeFromSeededTitle('Biografía oral — prevención del dengue (SIM_0044)')).toBe('dengue')
    expect(themeFromSeededTitle('Carta de presentación — acompañamiento escolar (SIM_0100)')).toBe(
      'escuela',
    )
    expect(themeFromSeededTitle('Diario personal — vida con discapacidad (SIM_0200)')).toBe(
      'discapacidad',
    )
  })

  it('returns null for anything this seed did not write', () => {
    expect(themeFromSeededTitle('acta-asamblea-2024.pdf')).toBeNull()
    expect(themeFromSeededTitle('')).toBeNull()
    // The separator and the trailing ` (` are both part of the match, so a
    // document that merely mentions a theme is not claimed.
    expect(themeFromSeededTitle('Notas sobre prevención del dengue')).toBeNull()
  })
})

describe('planCorpusLabelBackfill', () => {
  it('✅ joins a documento on its SIM id and writes BOTH labels', () => {
    const plan = planCorpusLabelBackfill(
      [{ id: 1, name: 'Carta de presentación — traducción en salud (SIM_0001)', contentKind: 'documento' }],
      MANIFEST,
    )
    expect(plan.changes).toEqual([
      { id: 1, contentKind: 'documento', via: 'manifest', tema: 'traduccion', lengua: 'mazateco' },
    ])
  })

  it('🔴 a testimonio that DOES carry a SIM id still gets no lengua', () => {
    // The seed never writes such a row, but a hand-uploaded one could exist and
    // the rule is about the content kind, not about how the row was matched.
    const plan = planCorpusLabelBackfill(
      [{ id: 2, name: 'algo (SIM_0002)', contentKind: 'testimonio' }],
      MANIFEST,
    )
    expect(plan.changes).toEqual([
      { id: 2, contentKind: 'testimonio', via: 'manifest', tema: 'dengue', lengua: null },
    ])
  })

  it('🔴 matches a seeded Voz by its title and gives it the theme only', () => {
    const plan = planCorpusLabelBackfill(
      [{ id: 3, name: 'Testimonio — prevención del dengue (07)', contentKind: 'testimonio' }],
      MANIFEST,
    )
    expect(plan.changes).toEqual([
      { id: 3, contentKind: 'testimonio', via: 'title', tema: 'dengue', lengua: null },
    ])
  })

  it('🔴 fails closed on an unreadable content kind — no lengua', () => {
    const plan = planCorpusLabelBackfill(
      [
        { id: 4, name: '(SIM_0001)', contentKind: undefined },
        { id: 5, name: '(SIM_0001)', contentKind: 'Documento' },
      ],
      MANIFEST,
    )
    expect(plan.changes.map((c) => c.lengua)).toEqual([null, null])
    expect(plan.changes.map((c) => c.tema)).toEqual(['traduccion', 'traduccion'])
  })

  it('leaves residue alone rather than guessing', () => {
    const plan = planCorpusLabelBackfill(
      [
        { id: 6, name: 'acta-asamblea.pdf', contentKind: 'documento' },
        { id: 7, name: 'grabación 3.m4a', contentKind: 'testimonio' },
      ],
      MANIFEST,
    )
    expect(plan.changes).toEqual([])
    expect(plan.unmatched).toBe(2)
  })

  it('🔴 refuses a SIM id this manifest does not contain', () => {
    // A regenerated corpus renumbers. Writing the wrong theme is worse than
    // writing none, so these are counted and skipped, never guessed.
    const plan = planCorpusLabelBackfill(
      [{ id: 8, name: 'Carta — x (SIM_9999)', contentKind: 'documento' }],
      MANIFEST,
    )
    expect(plan.changes).toEqual([])
    expect(plan.orphaned).toBe(1)
  })

  it('is idempotent — a second pass proposes nothing', () => {
    const rows = [
      {
        id: 1,
        name: 'Carta — traducción en salud (SIM_0001)',
        contentKind: 'documento',
        tema: 'traduccion',
        lengua: 'mazateco',
      },
      {
        id: 3,
        name: 'Testimonio — prevención del dengue (07)',
        contentKind: 'testimonio',
        tema: 'dengue',
        lengua: null,
      },
    ]
    const plan = planCorpusLabelBackfill(rows, MANIFEST)
    expect(plan.changes).toEqual([])
    expect(plan.unchanged).toBe(2)
  })

  it('🔴 proposes a write when a testimonio somehow already carries a lengua', () => {
    // Clearing it is the whole point: this is the repair path for a row written
    // before the rule existed.
    const plan = planCorpusLabelBackfill(
      [
        {
          id: 9,
          name: 'Testimonio — prevención del dengue (07)',
          contentKind: 'testimonio',
          tema: 'dengue',
          lengua: 'mixteco',
        },
      ],
      MANIFEST,
    )
    expect(plan.changes).toEqual([
      { id: 9, contentKind: 'testimonio', via: 'title', tema: 'dengue', lengua: null },
    ])
  })

  it('counts every row it looked at', () => {
    const plan = planCorpusLabelBackfill(
      [
        { id: 1, name: '(SIM_0001)', contentKind: 'documento' },
        { id: 6, name: 'acta.pdf', contentKind: 'documento' },
        { id: 8, name: '(SIM_9999)', contentKind: 'documento' },
      ],
      MANIFEST,
    )
    expect(plan.scanned).toBe(3)
    expect(plan.changes).toHaveLength(1)
    expect(plan.unmatched).toBe(1)
    expect(plan.orphaned).toBe(1)
  })
})

describe('parseBackfillArgs', () => {
  it('🔴 refuses to run without an explicit ecosistema', () => {
    const parsed = parseBackfillArgs(['--apply'])
    expect(parsed).toHaveProperty('error')
    expect((parsed as { error: string }).error).toMatch(/--organization/)
  })

  it('refuses a non-positive-integer id rather than coercing it', () => {
    for (const raw of ['0', '-1', 'abc', '1.5', '']) {
      expect(parseBackfillArgs([`--organization=${raw}`]), raw).toHaveProperty('error')
    }
  })

  it('🔴 is a DRY RUN unless --apply is passed', () => {
    expect(parseBackfillArgs(['--organization=1'])).toEqual({ organizationId: 1, apply: false })
    expect(parseBackfillArgs(['--organization=1', '--apply'])).toEqual({
      organizationId: 1,
      apply: true,
    })
  })

  it('does not care about flag order', () => {
    expect(parseBackfillArgs(['--apply', '--organization=42'])).toEqual({
      organizationId: 42,
      apply: true,
    })
  })
})
