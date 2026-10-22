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
  const out = deterministicPass({
    text,
    roster,
    allocate: (n) => allocator.labelFor(n),
    // 🔴 The SAME allocator, exactly as `gate.ts` threads it. A second one would
    // restart at `[Domicilio A]` and turn one house into two.
    allocateAddress: (a) => allocator.addressLabelFor(a),
  })
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

// ---------------------------------------------------------------------------
// DOMICILIOS — owner's ruling 2026-10-21 (Q3, "A: fixed shapes only")
// ---------------------------------------------------------------------------

/**
 * Stage 2 keeps ONE address shape: the postal code, five digits behind a
 * `C.P.` marker. Street lines (`Calle Morelos No. 45`), settlements
 * (`Col. Portales`) and blocks (`Mz. 4 Lt. 12`) are free-form and go to the
 * model (stage 3), whose prompt lists them.
 *
 * `NO_DEBE_TOCAR` is copied VERBATIM from the synthetic corpus
 * (`corpus-generativo`): address-shaped WORDS used as ordinary Spanish.
 */
const NO_DEBE_TOCAR: readonly string[] = [
  '[se escucha ruido de calle]',
  'Seguimos porque la colonia es nuestra.',
  'La escuela es el corazón de la colonia.',
  'Rol en el ecosistema: delegada de colonia',
  'Coordino con el delegado Reynaldo Ocampo las visitas por manzana.',
  'el problema lo vivimos nosotros con dirección y código postal',
  'Cuernavaca, a 20 de mayo de 2026.',
  'Residencia actual: Cuernavaca, Morelos (colonia Ciudad Chapultepec)',
  'Mi pueblo es San Juan Atzingo, Estado de México.',
  'Proyecto: IH-2025-I-445 · Fecha de registro: 14 de enero de 2026',
]

describe('deterministicPass — domicilios: the postal code only', () => {
  it('🔴 leaves free-form street lines and settlements to the model (Q3)', () => {
    for (const line of [
      'Vivo en Calle Morelos No. 45 desde hace años.',
      'Nos reunimos en Av. Emiliano Zapata 128, Cuernavaca.',
      'La casa está en Andador 5 de Mayo #12, int. 3.',
      'Mi domicilio es Priv. de los Pinos s/n, Col. Antonio Barona.',
      'Vivo en U.H. Vicente Guerrero Mz. 4 Lt. 12, cerca del metro.',
      'Fracc. Los Sauces, casa 22.',
      'Vivo en col. santa cruz, cerca de la iglesia.',
    ]) {
      const out = run(line)
      expect(out.text, line).toBe(line)
      expect(out.removed, line).toEqual([])
    }
  })

  it('🔴 the labels for street lines and settlements are gone', () => {
    expect(Object.values(DETERMINISTIC_LABELS)).not.toContain('domicilio')
    expect(Object.values(DETERMINISTIC_LABELS)).not.toContain('asentamiento')
  })

  it('redacts a postal code in every marker spelling, labelled `codigo-postal`', () => {
    for (const cp of ['C.P. 62577', 'c.p. 62577', 'C. P. 62577', 'CP 62577', 'Código Postal: 62577', 'codigo postal 62577']) {
      const out = run(`El expediente dice ${cp} y nada más.`)
      expect(out.text, cp).toBe('El expediente dice [Domicilio A] y nada más.')
      expect(labels(out.removed), cp).toEqual([DETERMINISTIC_LABELS.codigoPostal])
    }
  })

  it('a postal code inside a street line is the only part taken', () => {
    expect(run('Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300.').text).toBe(
      'Vivo en Calle Morelos No. 45, Col. Portales, [Domicilio A].',
    )
  })

  it('X25: the marker must start a word', () => {
    expect(labels(run('Folio ABCP 12345.').removed)).not.toContain(DETERMINISTIC_LABELS.codigoPostal)
  })

  it('needs the marker and exactly five digits', () => {
    for (const line of ['Pagué 62577 pesos.', 'C.P. 6257 o algo así.', 'C.P. 625770']) {
      expect(labels(run(line).removed), line).not.toContain(DETERMINISTIC_LABELS.codigoPostal)
    }
  })

  it('🔴 leaves every address-shaped sentence in the real corpus alone', () => {
    for (const line of NO_DEBE_TOCAR) {
      const out = run(line)
      expect(out.text, line).toBe(line)
      expect(out.removed, line).toEqual([])
    }
  })

  it('🔴 shows towns, municipalities, alcaldías and states (owner, 2026-10-21, #12)', () => {
    for (const line of [
      'Vivo en Xoxocotla, Morelos.',
      'Vivo en la Alcaldía Iztapalapa, cerca del metro.',
      'Soy de Rancho Nuevo, Chiapas.',
    ]) {
      expect(run(line).text, line).toBe(line)
    }
  })

  it('🔴 the same postal code said twice gets the SAME label, two get two', () => {
    const same = run('Nací en C.P. 03300 y volví al c.p. 03300 en 2020.')
    expect(same.text).toBe('Nací en [Domicilio A] y volví al [Domicilio A] en 2020.')
    expect(same.allocator.addressCount).toBe(1)
    const two = run('Me mudé de C.P. 03300 a C.P. 62577.')
    expect(two.text).toBe('Me mudé de [Domicilio A] a [Domicilio B].')
  })

  it('🔴 people and addresses have SEPARATE sequences — both start at A', () => {
    const out = run('Ana López vive en C.P. 03300.', ['Ana López'])
    expect(out.text).toBe('[Persona A] vive en [Domicilio A].')
    expect(out.allocator.count).toBe(1)
    expect(out.allocator.addressCount).toBe(1)
  })

  it('⚠ runs BEFORE telefono and numero-largo, so a postal code is never scored as a number', () => {
    const out = run('C.P. 06700')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.codigoPostal])
  })

  it('⚠ the report names the RULE and never the postal code', () => {
    expect(JSON.stringify(run('Vivo en C.P. 03300.').removed)).not.toContain('03300')
  })

  it('⚠ stays LINEAR on a whole transcript', () => {
    // Loose bound (2s) so this fails on a real blow-up, not on a loaded box.
    for (const text of [
      'C.P.' + ' '.repeat(100_000) + 'x',
      'código postal' + ' '.repeat(100_000) + ':x',
      'Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300. '.repeat(2000),
    ]) {
      const started = performance.now()
      run(text)
      expect(performance.now() - started, `${text.length} chars`).toBeLessThan(2000)
    }
  })
})
