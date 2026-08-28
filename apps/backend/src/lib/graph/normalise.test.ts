/**
 * Entity identity. The `ñ` block is the important one — it is the decision the
 * ADR left open, and over-folding it silently merges distinct Spanish words
 * into one node whose support count is the sum of two unrelated things.
 */
import { describe, expect, it } from 'vitest'

import { canonicalKey, displayLabel, MAX_ALIASES, mergeAliases } from './normalise'

describe('canonicalKey', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(canonicalKey('  Consulta   Indígena \n Regional ')).toBe('consulta indigena regional')
  })

  it('folds accents on vowels, so a typed-fast label matches the careful one', () => {
    expect(canonicalKey('México')).toBe('mexico')
    expect(canonicalKey('Mexico')).toBe('mexico')
    expect(canonicalKey('México')).toBe(canonicalKey('MEXICO'))
  })

  it('folds the diéresis — it marks pronunciation, not a different word', () => {
    expect(canonicalKey('pingüino')).toBe('pinguino')
    expect(canonicalKey('bilingüe')).toBe(canonicalKey('bilingue'))
  })

  it('treats a precomposed and a decomposed accent as the same key', () => {
    // "acción" typed normally vs. arriving already decomposed (macOS, some
    // PDF extractors, some transcript pipelines).
    const precomposed = 'acción'
    const decomposed = 'accio\u0301n'
    expect(precomposed).not.toBe(decomposed)
    expect(canonicalKey(precomposed)).toBe(canonicalKey(decomposed))
    expect(canonicalKey(precomposed)).toBe('accion')
  })

  it('returns an empty key for empty, whitespace-only and non-string input', () => {
    expect(canonicalKey('')).toBe('')
    expect(canonicalKey('   \n  ')).toBe('')
    expect(canonicalKey(null)).toBe('')
    expect(canonicalKey(undefined)).toBe('')
  })

  describe('🔴 ñ is preserved, deliberately', () => {
    it('keeps ñ rather than folding it to n', () => {
      expect(canonicalKey('Campaña')).toBe('campaña')
      expect(canonicalKey('CAÑA')).toBe('caña')
      expect(canonicalKey('Año')).toBe('año')
    })

    it('keeps distinct Spanish words distinct', () => {
      // The reason the rule exists. Folding ñ→n merges every one of these.
      expect(canonicalKey('campaña')).not.toBe(canonicalKey('campana'))
      expect(canonicalKey('caña')).not.toBe(canonicalKey('cana'))
      expect(canonicalKey('año')).not.toBe(canonicalKey('ano'))
    })

    it('normalises a decomposed ñ to the same key as a precomposed one', () => {
      const precomposed = 'campaña'
      const decomposed = 'campan\u0303a'
      expect(precomposed).not.toBe(decomposed)
      expect(canonicalKey(decomposed)).toBe('campaña')
      expect(canonicalKey(decomposed)).toBe(canonicalKey(precomposed))
    })

    it('folds an accent that sits next to an ñ without touching the ñ', () => {
      expect(canonicalKey('Compañía Minera')).toBe('compañia minera')
    })

    it('leaves no sentinel character behind', () => {
      // The implementation parks ñ on U+0001 while it strips combining marks.
      expect(canonicalKey('ñandú')).not.toContain('\u0001')
      expect(canonicalKey('ñandú')).toBe('ñandu')
    })
  })
})

describe('displayLabel', () => {
  it('collapses whitespace but keeps accents, case and ñ', () => {
    expect(displayLabel('  Compañía   Minera  ')).toBe('Compañía Minera')
  })

  it('is empty for non-string input', () => {
    expect(displayLabel(null)).toBe('')
  })
})

describe('mergeAliases', () => {
  it('never repeats the display label itself', () => {
    expect(mergeAliases([], 'CIDE', ['CIDE', 'cide', 'el CIDE'])).toEqual(['el CIDE'])
  })

  it('keeps existing aliases and appends only new surface forms', () => {
    expect(mergeAliases(['el CIDE'], 'CIDE', ['El Cide', 'Centro CIDE'])).toEqual([
      'el CIDE',
      'Centro CIDE',
    ])
  })

  it('drops blank candidates', () => {
    expect(mergeAliases(null, 'CIDE', ['  ', '', 'el CIDE'])).toEqual(['el CIDE'])
  })

  it('caps the list so re-extraction cannot grow it without bound', () => {
    const many = Array.from({ length: MAX_ALIASES + 10 }, (_, i) => `forma ${i}`)
    expect(mergeAliases([], 'CIDE', many)).toHaveLength(MAX_ALIASES)
  })
})
