/**
 * Stage 2. Two things are worth testing here and the second one is the reason
 * this file exists:
 *
 *   · each shaped identifier is actually removed;
 *   · 🔴 the ORDER holds. A greedy rule that runs first eats a specific rule's
 *     match, and the report then claims a redaction that left the identifying
 *     half of the string in the corpus.
 */

import { describe, expect, it } from 'vitest'

import { deterministicPass, DETERMINISTIC_LABELS } from './deterministic'
import { createPseudonymAllocator } from './pseudonyms'

function run(text: string, roster?: readonly string[]) {
  const allocator = createPseudonymAllocator()
  const out = deterministicPass({ text, roster, allocate: (n) => allocator.labelFor(n) })
  return { ...out, allocator }
}

function labels(removed: Array<{ label: string; count: number }>): string[] {
  return removed.map((r) => r.label)
}

describe('deterministicPass — shaped identifiers', () => {
  it('redacts an email', () => {
    const out = run('Escríbele a ana.lopez@correo.gob.mx cuando puedas.')
    expect(out.text).toBe('Escríbele a [Dato omitido] cuando puedas.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.email])
  })

  it('redacts Mexican phone numbers in several shapes', () => {
    for (const phone of ['+52 55 1234 5678', '(55) 1234-5678', '5512345678', '55.1234.5678']) {
      const out = run(`Mi teléfono es ${phone}.`)
      expect(out.text, phone).toBe('Mi teléfono es [Dato omitido].')
      expect(labels(out.removed), phone).toContain(DETERMINISTIC_LABELS.telefono)
    }
  })

  it('redacts a CURP', () => {
    const out = run('Su CURP es LOAM800101HDFPNS09 según el acta.')
    expect(out.text).toBe('Su CURP es [Dato omitido] según el acta.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.curp])
  })

  it('redacts an RFC without letting the CURP rule miss it', () => {
    const out = run('Facturó con RFC LOAM800101AB1 el año pasado.')
    expect(out.text).toBe('Facturó con RFC [Dato omitido] el año pasado.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.rfc])
  })

  it('redacts urls and @handles', () => {
    const out = run('Está en https://ejemplo.mx/perfil y en @anitalopez.')
    expect(out.text).toBe('Está en [Dato omitido] y en [Dato omitido].')
    expect(labels(out.removed)).toContain(DETERMINISTIC_LABELS.url)
    expect(labels(out.removed)).toContain(DETERMINISTIC_LABELS.arroba)
  })

  it('redacts a bare long digit run as numero-largo', () => {
    const out = run('Expediente 998877665544 del archivo.')
    expect(out.text).toBe('Expediente [Dato omitido] del archivo.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.numeroLargo])
  })
})

describe('deterministicPass — 🔴 the ordering footgun', () => {
  it('scores an email with digits as `email`, not as `numero-largo`', () => {
    // If the greedy digit rule ran first the address would come out as
    // `ana[Dato omitido]@correo.mx` — domain and local part still in the corpus,
    // and a report that says a redaction happened.
    const out = run('Su correo es ana19987654@correo.mx y nada más.')
    expect(out.text).toBe('Su correo es [Dato omitido] y nada más.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.email])
    expect(out.text).not.toContain('correo.mx')
  })

  it('does not let the url rule claim an email domain', () => {
    const out = run('ana@ejemplo.mx')
    expect(out.text).toBe('[Dato omitido]')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.email])
  })
})

describe('deterministicPass — the roster', () => {
  it('turns a roster name into the allocator label', () => {
    const out = run('Ana López llegó tarde.', ['Ana López'])
    expect(out.text).toBe('[Persona A] llegó tarde.')
    expect(labels(out.removed)).toContain(DETERMINISTIC_LABELS.rosterPerson)
  })

  it('matches the roster name through case and accents', () => {
    const out = run('ANA LOPEZ y ana lópez son la misma.', ['Ana López'])
    expect(out.text).toBe('[Persona A] y [Persona A] son la misma.')
    expect(out.allocator.count).toBe(1)
  })

  it('gives a roster EMAIL the person label, not [Dato omitido]', () => {
    const out = run('Escribió ana@ejemplo.mx.', ['ana@ejemplo.mx'])
    expect(out.text).toBe('Escribió [Persona A].')
  })

  it('does not match a roster name inside a longer word', () => {
    const out = run('La empresa Anaconda no es nadie.', ['Ana'])
    expect(out.text).toBe('La empresa Anaconda no es nadie.')
  })

  it('⚠ is close to useless with no roster — that is the testimony case', () => {
    // No dictionary, so the name survives stage 2 untouched. Stage 3 is the
    // mechanism for a Voz; see the header of `deterministic.ts`.
    const out = run('Mi hermana Lucía me acompañó.')
    expect(out.text).toContain('Lucía')
    expect(out.removed).toEqual([])
  })
})
