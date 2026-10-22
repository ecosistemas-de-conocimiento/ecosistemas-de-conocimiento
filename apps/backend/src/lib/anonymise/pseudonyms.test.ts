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
