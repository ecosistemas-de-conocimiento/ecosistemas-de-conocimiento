/**
 * The allocator's contract is two properties, and both are safety properties.
 *
 *   · SAME PERSON → SAME LABEL, across spelling variants, or the anonymised
 *     testimony reads as though three people were in the room.
 *   · DIFFERENT PEOPLE → DIFFERENT LABELS, or the redaction fabricates a
 *     relationship nobody described.
 */

import { describe, expect, it } from 'vitest'

import { createPseudonymAllocator, normaliseName } from './pseudonyms'

describe('createPseudonymAllocator', () => {
  it('gives the same person the same label twice', () => {
    const a = createPseudonymAllocator()
    expect(a.labelFor('María López')).toBe('[Persona A]')
    expect(a.labelFor('María López')).toBe('[Persona A]')
    expect(a.count).toBe(1)
  })

  it('folds case, accents and repeated whitespace onto one person', () => {
    const a = createPseudonymAllocator()
    const label = a.labelFor('María López')
    expect(a.labelFor('maria lopez')).toBe(label)
    expect(a.labelFor('MARÍA  LÓPEZ')).toBe(label)
    expect(a.labelFor('  María   López  ')).toBe(label)
    // 🔴 One person, not four. Four labels here would corrupt the testimony.
    expect(a.count).toBe(1)
  })

  it('walks A, B, C for three distinct people', () => {
    const a = createPseudonymAllocator()
    expect(a.labelFor('Ana')).toBe('[Persona A]')
    expect(a.labelFor('Benito')).toBe('[Persona B]')
    expect(a.labelFor('Carla')).toBe('[Persona C]')
    expect(a.count).toBe(3)
  })

  it('rolls over to AA after Z rather than to BA', () => {
    const a = createPseudonymAllocator()
    for (let i = 0; i < 26; i += 1) a.labelFor(`persona-${i}`)
    expect(a.labelFor('persona-26')).toBe('[Persona AA]')
    expect(a.labelFor('persona-27')).toBe('[Persona AB]')
  })

  it('🔴 does not share labels between two allocators', () => {
    // Cross-document stability is the re-identification risk this design exists
    // to avoid: a reader who could follow "Persona A" through the corpus can
    // profile them by behaviour without ever seeing a name.
    const doc1 = createPseudonymAllocator()
    const doc2 = createPseudonymAllocator()
    doc1.labelFor('Ana')
    doc1.labelFor('Benito')
    // In the second document Benito is simply whoever was named first.
    expect(doc2.labelFor('Benito')).toBe('[Persona A]')
  })
})

describe('normaliseName', () => {
  it('strips every Spanish accent, including ñ and ü', () => {
    expect(normaliseName('Muñoz')).toBe('munoz')
    expect(normaliseName('Güemes')).toBe('guemes')
    expect(normaliseName('ÍÑIGO')).toBe('inigo')
  })
})

describe('titled aliases need a two-word name (audit 2026-10-21, X20)', () => {
  it('a bare surname is not merged into a full name: two people can share it', () => {
    const a = createPseudonymAllocator()
    expect(a.labelFor('Ana López')).toBe('[Persona A]')
    expect(a.labelFor('López')).toBe('[Persona B]')
  })
})

describe('a relative of a relative is a different person (owner ruling Q6, 2026-10-21)', () => {
  const labels = (...spans: string[]) => {
    const a = createPseudonymAllocator()
    return spans.map((s) => a.labelFor(s))
  }

  it('"la esposa de mi primo" is not "mi primo"', () => {
    const [primo, esposa] = labels('mi primo', 'la esposa de mi primo')
    expect(esposa).not.toBe(primo)
  })

  it('order does not matter: the chain first, the relative second', () => {
    const [esposa, primo] = labels('la esposa de mi primo', 'mi primo')
    expect(esposa).not.toBe(primo)
  })

  it('"la esposa de mi primo Arnulfo" is not "mi primo Arnulfo"', () => {
    const [primo, esposa] = labels('mi primo Arnulfo', 'la esposa de mi primo Arnulfo')
    expect(esposa).not.toBe(primo)
  })

  it('"el hijo de doña Lucrecia" is not "doña Lucrecia"', () => {
    const [lucrecia, hijo] = labels('doña Lucrecia', 'el hijo de doña Lucrecia')
    expect(hijo).not.toBe(lucrecia)
  })

  it('"la hermana de mi mamá" is not "mi mamá"', () => {
    const [mama, hermana] = labels('mi mamá', 'la hermana de mi mamá')
    expect(hermana).not.toBe(mama)
  })

  it('a chain does not merge through a shorter tail of the relative either', () => {
    // "primo arnulfo" is a tail of the chain too; the chain's extra words
    // ("la esposa de mi") still hold a "de".
    const [primo, esposa] = labels('primo Arnulfo', 'la esposa de mi primo Arnulfo')
    expect(esposa).not.toBe(primo)
  })

  it('each person keeps one label when both are repeated', () => {
    const out = labels('mi mamá', 'la hermana de mi mamá', 'mi mamá', 'la hermana de mi mamá')
    expect(out).toEqual(['[Persona A]', '[Persona B]', '[Persona A]', '[Persona B]'])
  })

  it('the titled-name merge still merges', () => {
    const [don, bare] = labels('Don Fernando Vázquez', 'Fernando Vázquez')
    expect(bare).toBe(don)
    const [title, plain] = labels('doña Lucrecia Ramos', 'Lucrecia Ramos')
    expect(plain).toBe(title)
  })

  it('a title in front of a name that itself holds "de" still merges', () => {
    const [don, bare] = labels('Don José de la Cruz', 'José de la Cruz')
    expect(bare).toBe(don)
  })

  it('two people who share a surname still get different labels', () => {
    const [ana, luis] = labels('Ana López', 'Luis López')
    expect(luis).not.toBe(ana)
  })
})
