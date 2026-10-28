/**
 * 🔴 OWNER'S RULING Q24 = A (2026-10-28): names of institutions, agencies,
 * programs, projects, events, languages and acronyms are NOT personal data.
 *
 * Measured on dev: the model typed public names, concepts, work titles and
 * course labels as `otro` or `identificador`, and the gate turns both into
 * "[Dato omitido]", so a staff documento lost a program name
 * 22 times and a sign language 18 times. The fix is the PROMPT only: the gate
 * still redacts whatever the model reports (Q10 A), so these tests read the
 * prompt text. The gate's handling of an `otro` finding is unchanged and stays
 * covered by the existing gate tests.
 */

import { describe, expect, it } from 'vitest'

import { DETECT_SYSTEM_PROMPT } from './detector'

const flat = DETECT_SYSTEM_PROMPT.replace(/\s+/g, ' ')

/** The "No es un hallazgo" section: from its heading to the next blank line. */
const notAFinding = (() => {
  const start = DETECT_SYSTEM_PROMPT.indexOf('No es un hallazgo:')
  const end = DETECT_SYSTEM_PROMPT.indexOf('\n\n', start)
  return DETECT_SYSTEM_PROMPT.slice(start, end).replace(/\s+/g, ' ')
})()

describe('Q24 A: public names are not findings', () => {
  it('says so in the "No es un hallazgo" section, naming each kind', () => {
    for (const kind of ['instituciones', 'dependencias', 'programas', 'proyectos', 'eventos', 'lenguas', 'siglas']) {
      expect(notAFinding).toContain(kind)
    }
  })

  it('gives Spanish examples of the dev cases (made-up variants)', () => {
    for (const example of [
      'PILARES',
      'SECIHTI',
      'Lengua de Señas Mexicana',
      'Centro de Investigación y Docencia Económicas',
      'Ecosistemas de conocimiento y aprendizaje situado',
    ]) {
      expect(notAFinding).toContain(example)
    }
  })

  it.each([
    ['concepts, theories, ordinary words, nationalities', ['Conceptos, teorías', 'gentilicios', '"la ironía"', '"el marxismo"', '"argentino"']],
    ['titles of published works, journals, media and quotes', ['Títulos de obras publicadas', '"Gramática del relato"', 'la revista Umbral', 'citas']],
    ['course and document structure labels', ['estructura de un curso o documento', '"sesión 2"', '"Sesión 3 de 8"', '"Anexo D"']],
    ['public project or grant codes', ['Claves públicas de proyectos', '"Proyecto SECIHTI PX-2024-II-118"']],
    ['media, parties and organisations', ['medios, partidos y organizaciones', '"la UNAM"', '"Radio Nopal"']],
  ])('excludes %s', (_class, needles) => {
    for (const needle of needles) expect(notAFinding).toContain(needle)
  })

  it('🔴 forbids both "otro" and "identificador" for the excluded classes', () => {
    expect(notAFinding).toContain('tampoco como "otro" ni como "identificador"')
    expect(flat).toContain('Nunca uses "otro" ni "identificador" para nada de lo que la sección "No es un hallazgo" excluye.')
  })

  it('keeps "identificador" for one person\'s identifiers', () => {
    expect(notAFinding).toMatch(/"identificador" queda para los identificadores de UNA persona: su CURP, RFC/)
    expect(flat).toContain('"identificador" para folios, CURP, RFC y números de cuenta de una persona')
  })

  it('keeps the exception: a workplace that points at one person in context', () => {
    expect(notAFinding).toMatch(/salvo que/)
    expect(notAFinding).toMatch(/una sola persona concreta/)
  })

  it('says a team or collective is not a person', () => {
    expect(notAFinding).toContain('El equipo del Ecosistema')
    expect(notAFinding).toMatch(/equipo o colectivo/)
  })

  it('keeps the institution-next-to-a-person rule under Domicilios, pointing at the exception', () => {
    expect(flat).toContain('"el Cereso", "el hospital de Xochitepec"')
    expect(flat).toContain('Una institución CON NOMBRE, o junto a un pueblo, donde está, vive, trabaja o estudia una persona')
  })

  it('no longer invites `otro` for anything that could identify someone', () => {
    expect(flat).not.toContain('"otro" para cualquier otro dato que permita identificar a alguien')
    expect(flat).toContain('"otro" para otro dato que identifique a una persona concreta.')
  })

  it('workplaces are a finding only when they identify one person', () => {
    expect(flat).not.toContain('- Centros de trabajo, escuelas o cargos tan precisos que identifican a una persona.')
    expect(flat).toMatch(/Centros de trabajo, escuelas o cargos que, en ese texto, señalan a una persona concreta/)
  })
})

/**
 * 🔴 AUDIT OF THE Q24 PROMPT, 2026-10-28 (privacy first). The exception read
 * "una persona concreta y privada": "privada" is also the public/private
 * person label the same prompt asks for (`ambito`), so "la maestra de la
 * secundaria de San Rafael" could pass as "not private". And the Domicilios
 * line said "donde está o vive", dropping work and school. Both are restored.
 */
describe('Q24 audit: a named workplace or school beside a person is reported', () => {
  const exception = notAFinding.slice(notAFinding.indexOf('Esto vale salvo que'))

  it('🔴 the exception does not hinge on the person being private', () => {
    expect(notAFinding).not.toMatch(/persona concreta y privada/)
    expect(exception).toMatch(/una sola persona concreta, pública o no/)
  })

  it('🔴 the Domicilios line covers where a person works or studies', () => {
    expect(flat).toContain('donde está, vive, trabaja o estudia una persona')
    expect(flat).not.toContain('donde está o vive una persona:')
  })

  it.each([
    'la maestra de la secundaria Benito Juárez de San Rafael',
    'la enfermera del centro de salud de Tetelcingo',
    'el delegado de la alcaldía Xochimilco',
  ])('gives the example "%s"', (example) => {
    expect(flat).toContain(example)
  })

  it('says a cargo makes the institution beside it a finding even when no name is given', () => {
    expect(flat).toMatch(/aunque no se diga su nombre/)
  })

  it('keeps bare institution names out', () => {
    expect(notAFinding).toContain('En "trabajo en un PILARES de la alcaldía" no se reporta nada.')
  })
})
