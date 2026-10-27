import { describe, expect, it } from 'vitest'

import { canAdminOrg, isInvestigador, isStudent } from '../roles'
import { authorPage, buildReport, citedSurnames, matchPeers, mergeAuthors } from './logic'

const T = (id: number, label: string) => ({ id, label, docs: 1 })

describe('roles stub', () => {
  const u = { memberships: [{ organization: 8, role: 'estudiante' }, { organization: { id: 9 }, role: 'owner' }, { organization: 10, role: 'investigador', isActive: false }] }
  it('reads the raw role per ecosistema', () => {
    expect(isStudent(u, 8)).toBe(true)
    expect(isStudent(u, '9')).toBe(false)
    expect(canAdminOrg(u, 9)).toBe(true)
    expect(canAdminOrg(u, 8)).toBe(false)
    expect(isInvestigador(u, 10)).toBe(false)
    expect(canAdminOrg({ isPlatformAdmin: true }, 1)).toBe(true)
    expect(isStudent(null, 8)).toBe(false)
  })
})

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
      ['Siete', ['a', 'b'], 1],
      ['Ocho', ['a'], 0.25],
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
      docs: [{ id: 1, name: 'x', createdAt: '', status: 'published', kind: 'documento' }],
      topics: [T(1, 'a')],
      sessionTitles: ['s', 's'],
      corpusTop: [T(1, 'a'), T(2, 'b')],
      readings: [],
    })
    expect(r.summary).toEqual({ documents: 1, published: 1, topics: 1, conversations: 2 })
    expect(r.gaps).toEqual(['b'])
    expect(r.chatThemes).toEqual(['s'])
  })
})
