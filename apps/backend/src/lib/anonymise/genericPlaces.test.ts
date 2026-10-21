/**
 * The generic-place allowlist. Both directions, because this sits in a
 * privacy gate: every word it lets through must name nothing, and every real
 * address must still be caught.
 */

import { describe, expect, it } from 'vitest'

import { isGenericPlace } from './genericPlaces'
import type { DetectorFinding } from './types'

const lugar = (text: string) => ({ text, type: 'lugar' as const })

describe('isGenericPlace — common nouns are not addresses', () => {
  // Seen on dev 2026-10-21 (`/revision`, screenshot 81).
  it.each(['la escuela', 'la colonia', 'La escuela', 'La colonia'])('drops "%s"', (text) => {
    expect(isGenericPlace(lugar(text))).toBe(true)
  })

  it.each(['el centro de salud', 'mi pueblo', 'la milpa', 'el mercado', 'escuela', 'las calles'])(
    'drops "%s"',
    (text) => {
      expect(isGenericPlace(lugar(text))).toBe(true)
    },
  )
})

describe('isGenericPlace — 🔴 anything that can name a place or a person still counts', () => {
  it.each([
    // words that are also names of colonias, localities or surnames (audit 2026-10-21)
    'vivo en la presa',
    'la presa',
    'la barranca',
    'la loma',
    'el cerro',
    'el ejido',
    'la unidad',
    'los barrios',
    'la telesecundaria',
    'la prepa',
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
  ])('keeps lugar "%s"', (text) => {
    expect(isGenericPlace(lugar(text))).toBe(false)
  })

  it.each<DetectorFinding['type']>(['persona', 'otro', 'contacto', 'identificador'])(
    'never drops a %s finding, even one spelled like a place noun',
    (type) => {
      // "los barrios" as a surname ("la familia de los Barrios" said in lower case).
      expect(isGenericPlace({ text: 'los barrios', type })).toBe(false)
      expect(isGenericPlace({ text: 'la escuela', type })).toBe(false)
    },
  )
})
