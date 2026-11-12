/**
 * The ola 11 date forms do not take the number out of a NUMBERED REFERENCE
 * ("art. 3-IV-2020", "capítulo 3-V-12", "grupo 3-sep-12") nor out of an amount
 * after a bare month and day ("en mayo 15 2000 personas"). The same forms
 * still read as dates everywhere else (controls below).
 */
import { describe, expect, it } from 'vitest'

import { structuralPass } from './structural'

describe('a numbered reference or an amount is not a date', () => {
  it.each([
    'Según el art. 3-IV-2020 del reglamento.',
    'Según el artículo 3-IV-2020 del reglamento.',
    'Ver el capítulo 3-V-12.',
    'Ver el cap. 3-V-12.',
    'El grupo 3-sep-12 entregó tarde.',
    'La sección 3-mayo-1990 del archivo.',
    'La fracción 2-III-20 del acuerdo.',
    'El grupo 3 sept 12 entregó tarde.',
    'Llegaron en mayo 15 2000 personas.',
    'En mayo 15 2000 alumnos marcharon.',
  ])('%s', (text) => {
    expect(structuralPass(text).text).toBe(text)
  })
})

describe('controls: the same forms are still dates', () => {
  it.each([
    ['Nació el 3-V-1990.', 'Nació el V-1990.'],
    ['Nació el 3-V-1990, no 3-VI-1990.', 'Nació el V-1990, no VI-1990.'],
    ['El grupo nació el 3-sep-12.', 'El grupo nació el sep-12.'],
    ['Nació el 3 sept 1990.', 'Nació el sept 1990.'],
    ['Nació en mayo 15, 2000 personas lo vieron.', 'Nació en mayo 2000 personas lo vieron.'],
    ['Nació en mayo 15 2000 en Oaxaca.', 'Nació en mayo 2000 en Oaxaca.'],
    ['Nació en mayo 15 2000.', 'Nació en mayo 2000.'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
  })
})
