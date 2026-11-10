import { describe, expect, it } from 'vitest'

import { authorPage, buildReport, citedSurnames, matchPeers, mergeAuthors, reportTestimonios } from './logic'

const T = (id: number, label: string) => ({ id, label, docs: 1 })

describe('matchPeers', () => {
  it('ranks by Jaccard, drops zero overlap, shows shared labels only', () => {
    const peers = matchPeers(
      [T(1, 'a'), T(2, 'b')],
      new Map([
        [7, [T(1, 'a'), T(2, 'b')]],
        [8, [T(1, 'a'), T(3, 'c'), T(4, 'd')]],
        [9, [T(5, 'e')]],
      ]),
      [{ id: 8, name: 'Ocho' }, { id: 7, name: 'Siete' }, { id: 9, name: 'Nueve' }],
    )
    expect(peers.map((p) => [p.name, p.topics, p.score])).toEqual([
      ['Siete', [{ id: 1, label: 'a' }, { id: 2, label: 'b' }], 1],
      ['Ocho', [{ id: 1, label: 'a' }], 0.25],
    ])
  })
  it('no topics of mine → nobody', () => {
    expect(matchPeers([], new Map([[7, [T(1, 'a')]]]), [{ id: 7, name: 'x' }])).toEqual([])
  })
})

describe('citedSurnames', () => {
  it('reads author-date citations, both styles', () => {
    const got = citedSurnames([
      'Como afirma Peirce (1903), el signo… (Eco y Sebeok, 1983; Lotman 1996: 12). Peirce (1931) insiste. En (2001) no.',
    ])
    expect(got).toEqual([
      { label: 'Peirce', count: 2 },
      { label: 'Eco', count: 1 },
      { label: 'Lotman', count: 1 },
      { label: 'Sebeok', count: 1 },
    ])
  })
})

describe('authorPage / mergeAuthors', () => {
  const pages = [
    { id: 1, name: 'Autores/Charles S. Peirce' },
    { id: 2, name: 'Eco, Umberto' },
    { id: 3, name: 'Una historia larga sobre la semiótica de Eco y otros autores' },
  ]
  it('exact name, then a short page with the surname', () => {
    expect(authorPage('Charles S. Peirce', pages)?.id).toBe(1)
    expect(authorPage('Umberto Eco', pages)?.id).toBe(2)
    expect(authorPage('Lotman', pages)).toBeNull()
  })
  it('a cited surname already covered by a graph author is dropped', () => {
    const out = mergeAuthors([T(5, 'Charles S. Peirce')], [{ label: 'Peirce', count: 3 }, { label: 'Eco', count: 1 }], pages)
    expect(out.map((a) => [a.name, a.page?.id ?? null])).toEqual([
      ['Charles S. Peirce', 1],
      ['Eco', 2],
    ])
  })
})

describe('buildReport', () => {
  it('gaps are corpus topics the student has not touched', () => {
    const r = buildReport({
      student: { id: 1, name: 'Ana' },
      docs: [{ id: 1, name: 'x', title: 'x', createdAt: '', status: 'published', kind: 'documento' }],
      topics: [T(1, 'a')],
      sessionCount: 2,
      corpusTop: [T(1, 'a'), T(2, 'b')],
      readings: [],
    })
    expect(r.summary).toEqual({ documents: 1, published: 1, topics: 1, conversations: 2 })
    expect(r.gaps).toEqual(['b'])
    // 🔴 Owner ruling Q23: the count, never the titles.
    expect('chatThemes' in r).toBe(false)
  })

  const base = {
    student: { id: 1, name: 'Ana' },
    topics: [],
    sessionCount: 0,
    corpusTop: [],
    readings: [],
  }

  it('🔴 documents only, and a draft carries no name', () => {
    const r = buildReport({
      ...base,
      docs: [
        { id: 1, name: 'Mi ensayo', title: 'Mi ensayo', createdAt: 'a', status: 'published', kind: 'documento' },
        { id: 2, name: 'Borrador secreto', title: 'Borrador secreto', createdAt: 'b', status: 'draft', kind: 'documento' },
        { id: 3, name: 'Testimonio de María López.mp3', title: 'Testimonio', createdAt: 'c', status: 'published', kind: 'testimonio' },
        { id: 4, name: 'Conversación con Pedro', title: 'Conversación', createdAt: 'd', status: 'published', kind: 'conversacion' },
      ],
    })
    expect(r.uploads).toEqual([
      { id: 1, name: 'Mi ensayo', createdAt: 'a', status: 'published', kind: 'documento' },
      { id: 2, name: null, createdAt: 'b', status: 'draft', kind: 'documento' },
    ])
    expect(r.summary).toMatchObject({ documents: 2, published: 1 })
    expect(JSON.stringify(r)).not.toMatch(/secreto|María|Pedro/)
  })

  it('🔴 P-13 (R4-03): a published gated note carries its gated title, never its raw name', () => {
    const r = buildReport({
      ...base,
      docs: [
        { id: 1, name: 'Entrevista con doña Rosa Martínez', title: 'Entrevista con [Persona A]', createdAt: 'a', status: 'published', kind: 'documento' },
        { id: 2, name: 'Notas de Juana Pérez', title: 'Documento', createdAt: 'b', status: 'published', kind: 'documento' },
      ],
    })
    expect(r.uploads.map((u) => u.name)).toEqual(['Entrevista con [Persona A]', 'Documento'])
    expect(JSON.stringify(r)).not.toMatch(/Rosa|Martínez|Juana|Pérez/)
  })

  it('without testimonios (switch off) the report has no testimonios key', () => {
    expect('testimonios' in buildReport({ ...base, docs: [] })).toBe(false)
    expect('testimonios' in buildReport({ ...base, docs: [], testimonios: null })).toBe(false)
  })

  it('with testimonios (switch on) they are in the report', () => {
    const r = buildReport({ ...base, docs: [], testimonios: [] })
    expect(r.testimonios).toEqual([])
  })
})

describe('reportTestimonios — what a teacher sees of a student\'s testimonio', () => {
  const row = (status: string, extra: Partial<{ redactedText: string | null; title: string | null }> = {}) => ({
    id: 7,
    createdAt: '2026-10-01',
    status,
    redactedText: 'Habló [Persona A] sobre el río.',
    title: 'El río y la comunidad',
    ...extra,
  })

  it('approved or ready: the redacted text and the neutral title', () => {
    for (const status of ['approved', 'ready']) {
      expect(reportTestimonios([row(status)])).toEqual([
        { id: 7, createdAt: '2026-10-01', state: 'visible', title: 'El río y la comunidad', text: 'Habló [Persona A] sobre el río.' },
      ])
    }
  })

  it('no generated title → "Testimonio" (titleFor), never anything else', () => {
    expect(reportTestimonios([row('approved', { title: null })])[0]).toMatchObject({ title: 'Testimonio' })
    expect(reportTestimonios([row('approved', { title: '   ' })])[0]).toMatchObject({ title: 'Testimonio' })
  })

  it('🔴 held, rejected, pending or unknown: a status line, no text, no title', () => {
    const out = reportTestimonios([row('held'), row('rejected'), row('pending'), row('n/a'), row('weird')])
    expect(out.map((t) => t.state)).toEqual(['held', 'rejected', 'pending', 'pending', 'pending'])
    for (const t of out) expect(Object.keys(t).sort()).toEqual(['createdAt', 'id', 'state'])
  })

  it('🔴 a cleared status with no redacted text is a status line, not an empty card', () => {
    expect(reportTestimonios([row('approved', { redactedText: null })])[0]).toEqual({
      id: 7,
      createdAt: '2026-10-01',
      state: 'pending',
    })
  })
})
