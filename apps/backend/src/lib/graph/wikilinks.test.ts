import { describe, expect, it } from 'vitest'

import { extractMarkdownLinks } from '../extract/markdown'
import type { GraphExtraction } from './types'
import { canonicalKey } from './normalise'
import {
  authorBlocker,
  blockedAuthorNames,
  dropKeptAuthors,
  emptyExtraction,
  mergeWikiSeeds,
  nameForms,
  personaBlocker,
  safeWikiLinks,
  splitStoredSeedEntities,
  wholeWordCount,
  wikiLinkLabel,
  wikiSeedTitle,
  wikiSeedsForRow,
} from './wikilinks'

const labels = (links: { label: string }[]) => links.map((l) => l.label)

describe('extractMarkdownLinks', () => {
  it('returns raw targets, de-duplicated, skipping embeds and fenced code', () => {
    const md = 'Ver [[Semiótica]] y [[Peirce|el lógico]].\n![[imagen.png]]\n```\n[[NoEsLink]]\n```\n[[Semiótica]]'
    expect(extractMarkdownLinks(md)).toEqual(['Semiótica', 'Peirce'])
  })
})

describe('safeWikiLinks', () => {
  it('keeps a target that occurs whole-word in the corpus text', () => {
    const out = safeWikiLinks(['Semiótica'], 'La semiótica estudia signos. Semiótica otra vez.', 'documento')
    expect(out).toEqual([{ label: 'Semiótica', occurrences: 2 }])
  })

  it('🔴 drops a name the gate redacted (absent from the redacted text)', () => {
    const redacted = 'Conversé con [PERSONA] sobre semiótica en [LUGAR].'
    expect(labels(safeWikiLinks(['María López', 'semiótica'], redacted, 'documento'))).toEqual(['semiótica'])
  })

  it('🔴 drops an alias-hidden target: only the alias is visible', () => {
    const md = 'Hablé con [[María López|la vecina]] de [[Semiótica]].'
    const text = 'Hablé con la vecina de Semiótica.'
    expect(labels(safeWikiLinks(extractMarkdownLinks(md), text, 'documento'))).toEqual(['Semiótica'])
  })

  it('🔴 a word containing a name does not match it', () => {
    expect(safeWikiLinks(['Ana'], 'Mariana y Anabel hablaron.', 'documento')).toEqual([])
    expect(wholeWordCount('Ana', 'Mariana y Anabel; Ana llegó.')).toBe(1)
  })

  it('drops targets under 3 characters, noise and duplicates by canonical key', () => {
    const text = 'IA y semiotica; Semiótica; náhuatl.'
    expect(labels(safeWikiLinks(['IA', 'Semiótica', 'semiotica', 'náhuatl'], text, 'documento'))).toEqual([
      'Semiótica',
    ])
  })

  it('🔴 fails closed on any content kind but documento', () => {
    for (const kind of ['testimonio', 'conversacion', null, undefined, 'otro']) {
      expect(safeWikiLinks(['Semiótica'], 'Semiótica', kind)).toEqual([])
    }
  })

  it('reads the page part and the last path segment of a target', () => {
    expect(wikiLinkLabel('carpeta/Semiótica#Historia')).toBe('Semiótica')
    expect(wikiLinkLabel('#Notas')).toBe('')
    expect(wikiLinkLabel('Signo.md')).toBe('Signo')
  })
})

describe('wikiSeedTitle', () => {
  it('uses an ungated documento name, without the extension', () => {
    expect(wikiSeedTitle({ contentKind: 'documento', name: 'Peirce.md', gated: false, corpusText: '' })).toBe('Peirce')
  })
  it('🔴 a gated documento title must survive the redacted text too', () => {
    const args = { contentKind: 'documento', name: 'Juan Pérez', gated: true }
    expect(wikiSeedTitle({ ...args, corpusText: 'Habló [PERSONA].' })).toBeNull()
    expect(wikiSeedTitle({ ...args, corpusText: 'Habló Juan Pérez.' })).toBe('Juan Pérez')
  })
  it('never seeds a neutral title', () => {
    expect(wikiSeedTitle({ contentKind: 'documento', name: 'Documento sin título', gated: false, corpusText: '' })).toBeNull()
  })
})

describe('mergeWikiSeeds', () => {
  const model: GraphExtraction = {
    ...emptyExtraction('v'),
    entities: [
      { type: 'lugar', label: 'Oaxaca', canonicalKey: 'oaxaca', occurrences: 3, aliases: [], snippet: 's' },
      { type: 'tema', label: 'Signos', canonicalKey: 'signos', occurrences: 1, aliases: [], snippet: null },
      { type: 'persona', label: 'Charles Peirce', canonicalKey: 'charles peirce', occurrences: 1, aliases: [], snippet: null },
    ],
  }
  const keys = (m: { extraction: GraphExtraction }) => m.extraction.entities.map((e) => `${e.type}:${e.canonicalKey}`)

  it('attaches to the model entity by canonical key and adds title→link edges', () => {
    const out = mergeWikiSeeds(model, { title: 'Signos', links: [{ label: 'oaxaca', occurrences: 1 }] })
    expect(keys(out)).toEqual(['lugar:oaxaca', 'tema:signos', 'persona:charles peirce'])
    expect(out.extraction.relations).toEqual([{ fromKey: 'signos', toKey: 'oaxaca', type: 'relacionado_con' }])
    expect(out.links).toEqual([{ label: 'oaxaca', occurrences: 1 }])
  })

  it('🔴 never creates a node: a link the model was silent about drops (audit 2026-10-28)', () => {
    const out = mergeWikiSeeds(emptyExtraction('v'), {
      title: 'Rosa Martínez',
      links: [{ label: 'Juan Pérez', occurrences: 2 }, { label: 'Lupita Gómez', occurrences: 1 }],
    })
    expect(out.extraction.entities).toEqual([])
    expect(out.extraction.relations).toEqual([])
    expect(out.links).toBeNull()
  })

  it('attaches to a stored non-persona node, with its stored type and label', () => {
    const out = mergeWikiSeeds(
      emptyExtraction('v'),
      { title: null, links: [{ label: 'semiotica', occurrences: 2 }] },
      { known: [{ type: 'tema', label: 'Semiótica', canonicalKey: 'semiotica' }] },
    )
    expect(out.extraction.entities).toMatchObject([{ type: 'tema', label: 'Semiótica', occurrences: 2, snippet: null }])
  })

  it('🔴 never a persona: model personas, personaKeys and personaLabels drop, even over a known node', () => {
    const out = mergeWikiSeeds(
      { ...model, personaKeys: ['juana perez'] },
      {
        title: 'Signos',
        links: [
          { label: 'Charles Peirce', occurrences: 1 },
          { label: 'Juana Pérez', occurrences: 1 },
          { label: 'Umberto Eco', occurrences: 1 },
        ],
      },
      {
        personaLabels: ['Umberto Eco'],
        known: [
          { type: 'tema', label: 'Juana Pérez', canonicalKey: 'juana perez' },
          { type: 'tema', label: 'Umberto Eco', canonicalKey: 'umberto eco' },
        ],
      },
    )
    expect(keys(out)).toEqual(keys({ extraction: model }))
    expect(out.extraction.relations).toEqual([])
  })
})

describe('splitStoredSeedEntities', () => {
  // 🔴 These fail if either half of the stored-persona rule is removed.
  const rows = [
    { type: 'tema', label: 'Rosa Martínez', canonicalKey: 'rosa martinez', mentionedElsewhere: true },
    { type: 'persona', label: 'Rosa Martínez', canonicalKey: 'rosa martinez' },
    { type: 'persona', label: 'Juan Pérez', canonicalKey: 'juan perez' },
    { type: 'lugar', label: 'Oaxaca', canonicalKey: 'oaxaca', mentionedElsewhere: true },
    // 🔴 An orphan: entities are never deleted, so no mention elsewhere = no node.
    { type: 'tema', label: 'Pedro Ramírez', canonicalKey: 'pedro ramirez', mentionedElsewhere: false },
    { type: 'tema', label: 'Signo', canonicalKey: 'signo' },
  ]
  it('every key a stored row types persona is a persona key', () => {
    expect(splitStoredSeedEntities(rows).personaKeys.sort()).toEqual(['juan perez', 'rosa martinez'])
  })
  it('known holds non-persona rows another document mentions, minus any persona key', () => {
    expect(splitStoredSeedEntities(rows).known.map((k) => `${k.type}:${k.canonicalKey}`)).toEqual(['lugar:oaxaca'])
  })
})

describe('wikiSeedsForRow', () => {
  it('only reads a markdown row with a bodyMarkdown source', () => {
    const row = { kind: 'pdf', contentKind: 'documento', name: 'X', bodyMarkdown: '[[Semiótica]]' }
    expect(wikiSeedsForRow(row, 'Semiótica', false)).toBeNull()
    expect(wikiSeedsForRow({ ...row, kind: 'markdown' }, 'Semiótica', false)).toEqual({
      title: null,
      links: [{ label: 'Semiótica', occurrences: 1 }],
    })
  })
})

describe('personaBlocker (alias-aware, audit 2026-10-28 item 3)', () => {
  it('compares full names and surnames both ways', () => {
    expect(nameForms('Charles Peirce')).toEqual(['charles peirce', 'peirce'])
    expect(nameForms('Eco')).toEqual(['eco'])
    const blocked = personaBlocker(['Peirce', 'Noam Chomsky'])
    expect(blocked('charles peirce')).toBe(true) // model saw "Peirce"
    expect(blocked('chomsky')).toBe(true) // surname of a stored persona
    expect(blocked('semiotica')).toBe(false)
  })
  it('a stored persona\'s aliases block too', () => {
    const rows = [
      { type: 'persona', label: 'Noam Chomsky', canonicalKey: 'noam chomsky', aliases: ['El lingüista'] },
      { type: 'tema', label: 'El lingüista', canonicalKey: 'el linguista', mentionedElsewhere: true },
    ]
    expect(splitStoredSeedEntities(rows).known).toEqual([])
    expect(splitStoredSeedEntities(rows.slice(1), ['El lingüista']).known).toEqual([])
  })
})

describe('blockedAuthorNames — the cited authors are no node either (owner decision 2026-11-07)', () => {
  const log = (...names: string[]) => names.map((name) => ({ name, model: 'm', at: '2026-11-07T00:00:00.000Z' }))

  it('joins the document author and the cited names, each once', () => {
    expect(blockedAuthorNames({ authorsKept: log('Ana Ruiz'), citedAuthorsKept: log('Ulloa', 'Quiroga, T.', 'Ulloa') })).toEqual([
      'Ana Ruiz',
      'Ulloa',
      'Quiroga',
    ])
    expect(blockedAuthorNames({})).toEqual([])
  })

  it('🔴 a cited surname kept in the text never becomes a node or a seed', () => {
    const names = blockedAuthorNames({ citedAuthorsKept: log('Ulloa', 'Quiroga, T.') })
    const blocked = authorBlocker(names)
    for (const label of ['Ulloa', 'ULLOA', 'Quiroga', 'Teresa Quiroga', 'Quiroga, T.']) expect(blocked(label), label).toBe(true)
    for (const label of ['Semiótica', 'Mercado central']) expect(blocked(label), label).toBe(false)
    const tema = (label: string) =>
      ({ type: 'tema', label, canonicalKey: canonicalKey(label), occurrences: 1, aliases: [], snippet: null }) as GraphExtraction['entities'][number]
    const out = dropKeptAuthors({ ...emptyExtraction('v'), entities: [tema('Ulloa'), tema('Semiótica')], relations: [] }, names)
    expect(out.entities.map((e) => e.label)).toEqual(['Semiótica'])
  })
})

describe('dropKeptAuthors', () => {
  const entity = (label: string, aliases: string[] = []) =>
    ({ type: 'tema', label, canonicalKey: canonicalKey(label), occurrences: 1, aliases, snippet: null }) as GraphExtraction['entities'][number]
  const extraction = (): GraphExtraction => ({
    ...emptyExtraction('v'),
    entities: [entity('Ana María Rentería'), entity('Semiótica'), entity('La autora', ['Ana María Rentería']), entity('Signo')],
    relations: [
      { fromKey: 'semiotica', toKey: 'ana maria renteria', type: 'relacionado_con' },
      { fromKey: 'la autora', toKey: 'signo', type: 'relacionado_con' },
      { fromKey: 'semiotica', toKey: 'signo', type: 'relacionado_con' },
    ],
  })

  it('drops the name, an alias of it and their edges; the input is not touched', () => {
    const input = extraction()
    const out = dropKeptAuthors(input, ['Ana María Rentería'])
    expect(out.entities.map((e) => e.label)).toEqual(['Semiótica', 'Signo'])
    expect(out.relations).toEqual([{ fromKey: 'semiotica', toKey: 'signo', type: 'relacionado_con' }])
    expect(input.entities).toHaveLength(4)
  })

  it('without an author, or with another one, nothing goes', () => {
    const input = extraction()
    expect(dropKeptAuthors(input, [])).toBe(input)
    expect(dropKeptAuthors(input, ['Luis Gómez'])).toBe(input)
  })

  describe.each([
    {
      author: 'Ana María López Ruiz',
      dropped: [
        'Ana María López Ruiz',
        'ANA MARÍA LÓPEZ RUIZ',
        'Ana María López',
        'Ana López',
        'López',
        'López Ruiz',
        'Ruiz',
        'Ana María',
        'Ana Ruiz',
        'López, Ana María',
        'Ruiz; López',
        'Seminario Ana María López Ruiz sobre semiosis',
        'Archivo Ana María López Ruiz de Oaxaca',
        'Colonia Ruiz',
      ],
      kept: ['Semiosis', 'Oaxaca', 'López Mateos', 'Derechos de la infancia', 'Mariana', '2021'],
    },
    {
      author: 'Ana María López',
      dropped: [
        'Ana María López (autora)',
        'Ana María López 2021',
        'Metodología de Ana María López sobre semiosis',
        'Dra. Ana María López',
        'Ana María López Ruiz',
        'López, Ana María',
        'Ana-María López',
        'Colonia López',
      ],
      kept: ['Semiosis', 'Oaxaca', 'López Mateos', 'Ana Gómez', 'Metodología sobre semiosis'],
    },
    {
      author: 'María de la Vega',
      dropped: ['María de la Vega', 'Vega', 'de la Vega', 'María Vega', 'Vega, María de la'],
      kept: ['Derechos de la infancia', 'Casa de la Cultura', 'Vega Alta'],
    },
    {
      author: 'María Guadalupe',
      dropped: ['María Guadalupe', 'Guadalupe', 'María', 'Virgen de Guadalupe'],
      kept: ['Oaxaca', 'María Gómez'],
    },
    {
      // A surname under three letters ends too many phrases to fail closed on.
      author: 'Ana Li',
      dropped: ['Ana Li', 'Li, Ana', 'Li', 'Seminario Ana Li'],
      kept: ['Colonia Li'],
    },
  ])('$author', ({ author, dropped, kept }) => {
    it.each(dropped)('🔴 drops "%s", and an alias of it', (label) => {
      expect(dropKeptAuthors({ ...emptyExtraction('v'), entities: [entity(label)] }, [author]).entities).toEqual([])
      expect(dropKeptAuthors({ ...emptyExtraction('v'), entities: [entity('La autora', [label])] }, [author]).entities).toEqual([])
    })

    it.each(kept)('keeps "%s"', (label) => {
      const input = { ...emptyExtraction('v'), entities: [entity(label)] }
      expect(dropKeptAuthors(input, [author])).toBe(input)
    })
  })

  it('drops an edge whose end names the author, with or without a node', () => {
    const input: GraphExtraction = {
      ...emptyExtraction('v'),
      entities: [entity('Semiosis'), entity('Oaxaca'), entity('Ana María López')],
      relations: [
        { fromKey: 'ana maria lopez', toKey: 'semiosis', type: 'relacionado_con' },
        { fromKey: 'semiosis', toKey: 'lopez, ana maria', type: 'relacionado_con' },
        { fromKey: 'semiosis', toKey: 'oaxaca', type: 'relacionado_con' },
      ],
    }
    expect(dropKeptAuthors(input, ['Ana María López Ruiz']).relations).toEqual([
      { fromKey: 'semiosis', toKey: 'oaxaca', type: 'relacionado_con' },
    ])
  })

  it('🔴 clears a kept node\'s snippet that holds the whole name, and no other', () => {
    const withSnippet = (label: string, snippet: string | null) => ({ ...entity(label), snippet })
    const input: GraphExtraction = {
      ...emptyExtraction('v'),
      entities: [
        withSnippet('Semiosis', 'Ana María López escribió sobre semiosis'),
        withSnippet('Oaxaca', 'ANA MARIA\nLÓPEZ vive en Oaxaca'),
        withSnippet('Signo', 'el signo y su objeto'),
        withSnippet('Índice', 'López estudió el índice'),
        withSnippet('Objeto', null),
      ],
    }
    const out = dropKeptAuthors(input, ['Ana María López'])
    expect(out.entities.map((e) => [e.label, e.snippet])).toEqual([
      ['Semiosis', null],
      ['Oaxaca', null],
      ['Signo', 'el signo y su objeto'],
      ['Índice', 'López estudió el índice'],
      ['Objeto', null],
    ])
    expect(input.entities[0]?.snippet).toBe('Ana María López escribió sobre semiosis')
  })

  it('a name with no letters, or a blank one, blocks nothing', () => {
    const input = { ...emptyExtraction('v'), entities: [entity('Semiosis'), entity('2021')] }
    expect(dropKeptAuthors(input, ['', '  ', '123'])).toBe(input)
    expect(authorBlocker(['Ana López'])('')).toBe(false)
  })

  it('⚠ does not catch part of the name inside a longer phrase (declared in the privacy docs)', () => {
    const blocked = authorBlocker(['Ana María López'])
    expect(blocked('Seminario Ana López sobre semiosis')).toBe(false)
    expect(blocked('Metodología de López sobre semiosis')).toBe(false)
    expect(blocked('López (autora)')).toBe(false)
  })
})

describe('mergeWikiSeeds with the author kept visible', () => {
  const key = (label: string) => canonicalKey(label)
  const seedLabels = ['Ana María', 'Ana María López', 'López', 'Ana López Ruiz', 'Ruiz', 'López, Ana María', 'Seminario Ana María López Ruiz']
  const links = [...seedLabels, 'Semiosis', 'Oaxaca'].map((label) => ({ label, occurrences: 1 }))
  const known = [...seedLabels, 'Semiosis', 'Oaxaca'].map((label) => ({ type: 'tema' as const, label, canonicalKey: key(label) }))

  it('🔴 attaches no link that names the author, and keeps the rest', () => {
    const merged = mergeWikiSeeds(emptyExtraction('v'), { title: 'Notas', links }, { known, authorNames: ['Ana María López Ruiz'] })
    expect(merged.extraction.entities.map((e) => e.label)).toEqual(['Semiosis', 'Oaxaca'])
    expect(merged.links?.map((l) => l.label)).toEqual(['Semiosis', 'Oaxaca'])
  })

  it('🔴 a title naming the author is no node and draws no edge', () => {
    const title = 'Notas de Ana María López Ruiz'
    const merged = mergeWikiSeeds(
      emptyExtraction('v'),
      { title, links },
      { known: [...known, { type: 'tema', label: title, canonicalKey: key(title) }], authorNames: ['Ana María López Ruiz'] },
    )
    expect(merged.extraction.entities.map((e) => e.label)).toEqual(['Semiosis', 'Oaxaca'])
    expect(merged.extraction.relations).toEqual([])
  })

  it('without an author every known link attaches', () => {
    const merged = mergeWikiSeeds(emptyExtraction('v'), { title: null, links }, { known })
    expect(merged.links).toHaveLength(links.length)
  })

  it('edges drop with the link: title to a surviving link only', () => {
    const merged = mergeWikiSeeds(
      emptyExtraction('v'),
      { title: 'Oaxaca', links },
      { known, authorNames: ['Ana María López Ruiz'] },
    )
    expect(merged.extraction.relations).toEqual([{ fromKey: 'oaxaca', toKey: 'semiosis', type: 'relacionado_con' }])
  })
})
