import { describe, expect, it } from 'vitest'

import { ADDRESS_PLACEHOLDER_PREFIX, OMITTED_PLACEHOLDER, PERSON_PLACEHOLDER_PREFIX } from '@/lib/anonymise/types'

import { isGraphNoiseLabel, isLanguageLabel, isPlaceholderLabel } from './noise'

describe('🔴 isLanguageLabel', () => {
  it('matches every corpus language, folded for case and accents', () => {
    for (const label of [
      'náhuatl', 'Nahuatl', 'NÁHUATL', 'mixteco', 'mazateco', 'zapoteco', 'totonaco',
      'tlahuica', 'tlapaneco', "tlapaneco (me'phaa)", 'tlapaneco (me’phaa)', 'amuzgo',
      'hñähñu', 'hñähñu (otomí)', 'Hñahñu', 'tsotsil', 'mixe', 'español', 'Español',
      'castellano', 'lengua náhuatl', 'idioma español', 'el náhuatl', 'la lengua amuzgo',
    ]) {
      expect(isLanguageLabel(label), label).toBe(true)
    }
  })

  it('leaves a qualified subject alone', () => {
    for (const label of [
      'traducción del zapoteco al español', 'lengua de señas mexicana', 'lenguas indígenas',
      'revitalización del náhuatl', 'enseñanza del español', 'Tlayacapan', 'dengue',
      'mayo', 'mexicano', 'San Juan Mixtepec',
    ]) {
      expect(isLanguageLabel(label), label).toBe(false)
    }
  })
})

describe('🔴 isPlaceholderLabel — the gate’s own label set', () => {
  it('matches what the gate emits, built from its constants', () => {
    expect(isPlaceholderLabel(`${PERSON_PLACEHOLDER_PREFIX}A]`)).toBe(true)
    expect(isPlaceholderLabel(`${ADDRESS_PLACEHOLDER_PREFIX}AH]`)).toBe(true)
    expect(isPlaceholderLabel(OMITTED_PLACEHOLDER)).toBe(true)
  })

  it('matches with and without brackets, case- and accent-folded, letters or digits', () => {
    for (const label of [
      '[Persona A]', 'Persona A', 'persona b', '[PERSONA Z]', '[Domicilio B]', 'Domicilio 1',
      'domicilio 12', '[Dato omitido]', 'Dato omitido', 'DATO OMITIDO', '[Lugar B]', 'Lugar B',
      'casa de [Persona A]', '[Persona A] López',
    ]) {
      expect(isPlaceholderLabel(label), label).toBe(true)
    }
  })

  it('leaves real subjects that only share a word', () => {
    for (const label of [
      'persona sorda', 'personas sordas', 'persona sorda mayor', 'personas mayores',
      'domicilio fiscal', 'lugar de origen', 'datos personales', 'Lugar Seguro',
    ]) {
      expect(isPlaceholderLabel(label), label).toBe(false)
    }
  })
})

describe('isGraphNoiseLabel', () => {
  it('is the union of the two', () => {
    expect(isGraphNoiseLabel('amuzgo')).toBe(true)
    expect(isGraphNoiseLabel('[Domicilio A]')).toBe(true)
    expect(isGraphNoiseLabel('Cuernavaca')).toBe(false)
  })
})
