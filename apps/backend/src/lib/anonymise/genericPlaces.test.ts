/**
 * The generic-place allowlist. Both directions, because this sits in a
 * privacy gate: every word it lets through must name nothing, and every real
 * address must still be caught.
 */

import { describe, expect, it } from 'vitest'

import { isGenericPlace } from './genericPlaces'

describe('isGenericPlace — common nouns are not addresses', () => {
  // Seen on dev 2026-10-21 (`/revision`, screenshot 81): all three held a testimony.
  it.each(['la escuela', 'la colonia', 'la barranca', 'La escuela', 'La colonia'])(
    'drops "%s"',
    (finding) => {
      expect(isGenericPlace(finding)).toBe(true)
    },
  )

  it.each(['el centro de salud', 'mi pueblo', 'la milpa', 'el mercado', 'escuela', 'las calles'])(
    'drops "%s"',
    (finding) => {
      expect(isGenericPlace(finding)).toBe(true)
    },
  )
})

describe('isGenericPlace — 🔴 anything that can name a place still counts', () => {
  it.each([
    // a name after the noun
    'la colonia Portales',
    'la escuela Benito Juárez',
    'Centro de Salud de Tlapa',
    // a capitalised noun can be a town's name
    'La Barranca',
    'Barranca',
    'El Cerro',
    'LA COLONIA',
    // street addresses, with and without shape
    'Calle Morelos No. 45',
    'calle Morelos 45',
    'C.P. 06700',
    'Mz. 4 Lt. 12',
    // free-form references the detector prompt asks for
    'enfrente de la tienda de doña Mari',
    'la casa de la reja verde',
    'subiendo por donde está el tanque',
    // longer than one noun
    'la escuela de mi hija',
    // nothing at all, or only a determiner
    '',
    'la',
  ])('keeps "%s"', (finding) => {
    expect(isGenericPlace(finding)).toBe(false)
  })
})
