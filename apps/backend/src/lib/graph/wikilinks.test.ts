import { describe, expect, it } from 'vitest'

import { extractMarkdownLinks } from '../extract/markdown'
import type { GraphExtraction } from './types'
import {
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
