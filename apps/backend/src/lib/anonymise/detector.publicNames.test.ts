/**
 * 🔴 OWNER'S RULING Q24 = A (2026-10-28): names of institutions, agencies,
 * programs, projects, events, languages and acronyms are NOT personal data.
 *
 * Measured on dev: the model typed public names as `otro`, and the gate turns
 * every `otro` into "[Dato omitido]", so a staff documento lost a program name
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

  it('keeps the exception: a workplace that points at one person in context', () => {
    expect(notAFinding).toMatch(/salvo que/)
    expect(notAFinding).toMatch(/una persona concreta/)
  })

  it('says a team or collective is not a person', () => {
    expect(notAFinding).toContain('El equipo del Ecosistema')
    expect(notAFinding).toMatch(/equipo o colectivo/)
  })

  it('keeps the institution-next-to-a-person rule under Domicilios, pointing at the exception', () => {
    expect(flat).toContain('"el Cereso", "el hospital de Xochitepec"')
    expect(flat).toContain('Una institución CON NOMBRE, o junto a un pueblo, donde está o vive una persona')
  })

  it('no longer invites `otro` for anything that could identify someone', () => {
    expect(flat).not.toContain('"otro" para cualquier otro dato que permita identificar a alguien')
    expect(flat).toMatch(/"otro" para otro dato que identifique a una persona concreta/)
  })

  it('workplaces are a finding only when they identify one person', () => {
    expect(flat).not.toContain('- Centros de trabajo, escuelas o cargos tan precisos que identifican a una persona.')
    expect(flat).toMatch(/Centros de trabajo, escuelas o cargos que, en ese texto, señalan a una persona concreta/)
  })
})
