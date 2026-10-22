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

  // Rodrigo's ruling 2026-10-21: the roster uses stage 3's word breaks
  // (`wordBreaks.ts`). A digit and a lower-to-upper change end a word.
  it('a lower-to-upper change is a word break: "MaríaLópez" is the member', () => {
    const out = run('MaríaLópez vino.', ['María López'])
    expect(out.text).toBe('[Persona A] vino.')
  })

  it('a name run together with no break stays one unknown word', () => {
    const out = run('Marialopez vino.', ['María López'])
    expect(out.text).toBe('Marialopez vino.')
  })

  it('a digit after the name is a word break: "maria88"', () => {
    const out = run('maria88 llegó', ['María'])
    expect(out.text).toBe('[Persona A]88 llegó')
  })

  it('a digit before the name is a word break: "88maria"', () => {
    const out = run('88maria llegó', ['María'])
    expect(out.text).toBe('88[Persona A] llegó')
  })

  it('a later match counts after an earlier glued one is skipped', () => {
    const out = run('anabel y Ana.', ['Ana'])
    expect(out.text).toBe('anabel y [Persona A].')
    expect(out.removed).toEqual([{ label: DETERMINISTIC_LABELS.rosterPerson, count: 1 }])
  })

  it('a glued match does not hide a real one that overlaps it', () => {
    // "naNa" is glued to the next "n"; "Nana" starts on a lower-to-upper break.
    const out = run('naNana vino', ['nana'])
    expect(out.text).toBe('na[Persona A] vino')
  })

  it('…even when the real one starts one character after the glued one', () => {
    // "aAa" at 0 is glued to the last "a"; "Aaa" at 1 starts on a break.
    expect(run('aAaa vino', ['aaa']).text).toBe('a[Persona A] vino')
  })

  it('still leaves "ana" inside "Mañana", "anabel" and "ANABEL"', () => {
    const out = run('Mañana viene anabel, ANABEL no. Ana sí.', ['Ana'])
    expect(out.text).toBe('Mañana viene anabel, ANABEL no. [Persona A] sí.')
  })

  it('keeps one label per member across glued and spaced forms', () => {
    const out = run('MaríaLópez y María López y maria88.', ['María López', 'María'])
    expect(out.text).toBe('[Persona A] y [Persona A] y [Persona B]88.')
  })

  it('skips an entry made only of accent marks, and returns', { timeout: 2000 }, () => {
    const out = run('Ana vino.', ['\u0301\u0301', '\u0301 \u0301'])
    expect(out.text).toBe('Ana vino.')
    expect(out.removed).toEqual([])
  })

  it.each([
    ['tab', 'María\tLópez vino.'],
    ['newline', 'María\nLópez vino.'],
  ])('matches a %s between two roster words', (_, text) => {
    expect(run(text, ['María López']).text).toBe('[Persona A] vino.')
  })

  it.each([
    ['\u1DC4', 'U+1DC4'],
    ['\uFE0F', 'VS16'],
    ['\u20DD', 'U+20DD'],
  ])('takes any trailing accent mark with the name (%s, %s)', (mark) => {
    expect(run(`Ana${mark} vino`, ['Ana']).text).toBe('[Persona A] vino')
  })

  // An address that holds a member's name is ONE address: it becomes one
  // `[Dato omitido]`, never a placeholder spliced into it (delta audit).
  it.each([
    'juanMaria@gmail.com',
    'lucrecia88maria@gmail.com',
    'maria88@gmail.com',
    'juan.maria@gmail.com',
    'juan_maria@gmail.com',
    'juan-maria@gmail.com',
    'www.facebook.com/juanMaria',
    'www.facebook.com/maria88',
    'https://x.com/juan.maria',
    '@juanMaria',
    '@lucrecia88maria',
    '@juan_maria',
  ])('keeps %s whole: one placeholder', (address) => {
    const out = run(`Ve ${address} hoy`, ['María'])
    expect(out.text).toBe('Ve [Dato omitido] hoy')
  })

  it('⚠ is close to useless with no roster — that is the testimony case', () => {
    // No dictionary, so the name survives stage 2 untouched. Stage 3 is the
    // mechanism for a Voz; see the header of `deterministic.ts`.
    const out = run('Mi hermana Lucía me acompañó.')
    expect(out.text).toContain('Lucía')
    expect(out.removed).toEqual([])
  })
})

/** Lower case, accents dropped: what "the name survived" means here. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

describe('deterministicPass — 🔴 a member named inside an address (re-audit)', () => {
  // Every row: the whole address becomes ONE placeholder and no letter of the
  // member's name is left behind. The address rules used to read ASCII only,
  // so an accent cut the address and the name beside it survived.
  it.each([
    ['A1', 'Escribe a maría@gmail.com hoy', ['María'], 'Escribe a [Dato omitido] hoy'],
    ['A2', 'Escribe a maría.lopez@gmail.com hoy', ['María'], 'Escribe a [Dato omitido] hoy'],
    ['A3', 'Escribe a Ana maría@gmail.com hoy', ['Ana María'], 'Escribe a [Dato omitido] hoy'],
    ['A4', 'Escribe a núñez@gmail.com hoy', ['Núñez'], 'Escribe a [Dato omitido] hoy'],
    ['A5', 'Escribe a josé.maría@gmail.com hoy', ['José', 'María'], 'Escribe a [Dato omitido] hoy'],
    ['A6', 'Sígueme @núñez hoy', ['Núñez'], 'Sígueme [Dato omitido] hoy'],
    ['A7', 'Sígueme @iñaki hoy', ['Iñaki'], 'Sígueme [Dato omitido] hoy'],
    ['A8', 'Sígueme @maría hoy', ['María'], 'Sígueme [Dato omitido] hoy'],
    ['A9', 'Sígueme @lucía_gomez hoy', ['Lucía', 'Gómez'], 'Sígueme [Dato omitido] hoy'],
    ['A10', 'Sígueme @muñoz hoy', ['Muñoz'], 'Sígueme [Dato omitido] hoy'],
    ['A11', 'Sígueme @josé hoy', ['José'], 'Sígueme [Dato omitido] hoy'],
    ['A12', 'Escribe a ana.lópez@gmail.com hoy', ['Ana López', 'López', 'Ana'], 'Escribe a [Dato omitido] hoy'],
    ['A13', 'Ve www.facebook.com/maría.núñez hoy', ['María', 'Núñez'], 'Ve [Dato omitido] hoy'],
    ['A20', 'Escribe a x@maría.com hoy', ['María'], 'Escribe a [Dato omitido] hoy'],
    ['A21', 'Ve https://x.com/maria/x?e=a@b.co hoy', ['María'], 'Ve [Dato omitido] hoy'],
    ['A23', 'ESCRIBE A MARÍA@GMAIL.COM HOY', ['María'], 'ESCRIBE A [Dato omitido] HOY'],
    ['A26', 'Sígueme @sofía.r hoy', ['Sofía'], 'Sígueme [Dato omitido] hoy'],
  ])('%s: %s', (_, text, roster, expected) => {
    const out = run(text, roster)
    expect(out.text).toBe(expected)
    for (const name of roster) expect(fold(out.text)).not.toContain(fold(name))
  })

  it('a roster entry that IS the address keeps the person label, accents or not', () => {
    expect(run('Escribe a maria@gmail.com hoy', ['maría@gmail.com']).text).toBe(
      'Escribe a [Persona A] hoy',
    )
    expect(run('Escribe a maría@gmail.com hoy', ['maria@gmail.com']).text).toBe(
      'Escribe a [Persona A] hoy',
    )
  })

  it('a name partly over an address takes the address with it, never a fragment', () => {
    // "Ana María" starts outside the email and ends inside it.
    const out = run('Escribe a Ana maría@gmail.com hoy', ['Ana María'])
    expect(out.text).toBe('Escribe a [Dato omitido] hoy')
    expect(out.text).not.toMatch(/\[[^\]]*\[|\][^[]*\]/)
  })

  it('a malformed address leaves the name to the roster', () => {
    expect(run('Escribe a maria@gmail hoy', ['María']).text).toBe(
      'Escribe a [Persona A]@gmail hoy',
    )
  })

  it('never matches inside a placeholder already in the text', () => {
    expect(run('Ya [Dato omitido] y Dato.', ['Dato']).text).toBe('Ya [Dato omitido] y [Persona A].')
    expect(run('Ya [Dato omitido] y omitido.', ['omitido']).text).toBe(
      'Ya [Dato omitido] y [Persona A].',
    )
  })

  it('a name right after a placeholder is only touching it, not inside it', () => {
    expect(run('[Dato omitido]María vino', ['María']).text).toBe('[Dato omitido][Persona A] vino')
  })

  it('a URL that carries an email from its first character counts as a url', () => {
    const out = run('Ve www.ana@x.com/p hoy')
    expect(out.text).toBe('Ve [Dato omitido] hoy')
    expect(out.removed).toEqual([{ label: DETERMINISTIC_LABELS.url, count: 1 }])
  })

  it('an entry with a run of spaces does not backtrack forever', () => {
    const t0 = performance.now()
    run(`a${' '.repeat(2000)}c`, ['a            b'])
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(run('Vino Ana   López.', ['Ana      López']).text).toBe('Vino [Persona A].')
  })

  it('stays linear: 50k characters with no spaces and 30 entries', () => {
    const roster = Array.from({ length: 30 }, (_, i) => `Nombre${i}`)
    const t0 = performance.now()
    run(`Inicio. ${'x'.repeat(50_000)} fin.`, roster)
    run(`Inicio. ${'a.'.repeat(25_000)} fin.`, roster)
    expect(performance.now() - t0).toBeLessThan(1500)
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

describe('deterministicPass — follow-ups to the audit of the one-pass rewrite', () => {
  it('a local part over 64 characters is still ONE address, no prefix left', () => {
    const address = `mariagonzalez${'x'.repeat(60)}@gmail.com`
    expect(run(`Escribe a ${address} hoy`, ['María']).text).toBe('Escribe a [Dato omitido] hoy')
    expect(run(`Escribe a ${address} hoy`).text).toBe('Escribe a [Dato omitido] hoy')
  })

  it('a domain over 255 characters is still an address', () => {
    const text = `Escribe a ana@${'b'.repeat(300)}.com hoy`
    expect(run(text, ['Ana']).text).toBe('Escribe a [Dato omitido] hoy')
    expect(run(text).text).toBe('Escribe a [Dato omitido] hoy')
    expect(run(`Es ana@${'b.'.repeat(200)}com hoy`).text).toBe('Es [Dato omitido] hoy')
  })

  // 🔴 Growing right must not eat the NEXT email's local part: the search then
  // resumed at its "@" and the second domain was left, or split by a name.
  it.each([
    ['dash', 'Ve ana@x.com-juan@familia-lopez.mx hoy', []],
    ['dash, roster', 'Ve ana@x.com-juan@familia-lopez.mx hoy', ['López']],
    ['digit, roster', 'Ve ana@x.com2juan@lopez.mx hoy', ['López']],
    ['letters', 'Ve ana@x.comjuan@y.com hoy', []],
    ['TLD over 63', `Ve ana@b.${'c'.repeat(70)}@e.ff hoy`, []],
    ['TLD over 63, roster', `Ve ana@b.${'c'.repeat(70)}maria@e.ff hoy`, ['María']],
    ['domain over 255', `Ve a@${'b'.repeat(300)}.com@c.dd hoy`, []],
    ['roster email second', 'Ve ana@x.com-juan@y.com hoy', ['juan@y.com']],
  ])('two emails glued (%s) leave nothing of either', (_, text, roster) => {
    // Overlapping addresses merge: one placeholder for the glued pair.
    expect(run(text, roster).text).toBe('Ve [Dato omitido] hoy')
  })

  // Chains of three or more (inputs from the audit's generator). The whole
  // chain is one address: one placeholder, no "@", no letter of a domain.
  it.each([
    ['ana@x.com-juan@lopez.mx-maria@familia.mx', ['López', 'María', 'Ana', 'Juan']],
    ['a@x.com-b@y.mx-c@familia-lopez.mx', ['López']],
    ['ana@x.comjuan@y.commaria@z.comlopez@w.mx', ['López', 'María']],
    ['ana@x.com2juan@y.mx3maria@lopez.mx', ['María López']],
    [`a@${'b'.repeat(300)}-maria@${'b'.repeat(300)}.com-lopez@${'b'.repeat(70)}.mx`, ['López', 'María']],
    [`a@b.${'c'.repeat(70)}maria@b.${'c'.repeat(70)}lopez@e.ff`, ['López', 'María']],
  ])('a chain of glued emails is one placeholder: %s', (chain, roster) => {
    expect(run(`Ve ${chain} hoy`, roster).text).toBe('Ve [Dato omitido] hoy')
    expect(run(`Ve ${chain} hoy`).text).toBe('Ve [Dato omitido] hoy')
  })

  it('reads a long domain once: the search resumes after it, not inside it', () => {
    // Re-reading the domain costs what scanning text with no "@" costs. A RATIO
    // of two runs on the same box, so load does not decide it. Measured
    // 2026-10-21 (host torre, load 8-22) at 2M marks: read once 0.13-0.2 s,
    // read twice 3.0 s.
    const marks = '́'.repeat(1_000_000)
    const time = (text: string) => {
      const t0 = performance.now()
      const out = run(text).text
      return { ms: performance.now() - t0, out }
    }
    const reference = time(`x${marks}.co`)
    const email = time(`x@${marks}.co`)
    expect(email.out).toBe('[Dato omitido]')
    expect(email.ms).toBeLessThan(reference.ms / 3)
  })

  it('grows left over every local-part character, "_ % +" included', () => {
    for (const sep of ['_', '%', '+']) {
      const text = `Ve maria${sep}${'x'.repeat(64)}@gmail.com hoy`
      expect(run(text, ['María']).text, sep).toBe('Ve [Dato omitido] hoy')
    }
  })

  it('an email inside a URL is one address, even when it IS a roster entry', () => {
    expect(run('Ve https://ana@x.com hoy', ['ana@x.com']).text).toBe('Ve [Dato omitido] hoy')
  })

  it('an email that holds a URL is merged with it before the roster looks', () => {
    // "www.x.com" lies inside the email. Unmerged, the entry took the email as
    // a member and the URL was spliced in after it.
    expect(run('Ve ana@www.x.com hoy', ['ana@www.x.com']).text).toBe('Ve [Persona A] hoy')
  })

  it('a long domain stops at a character no domain holds, and drops a trailing "-"', () => {
    const domain = 'b'.repeat(300)
    expect(run(`Ve ana@${domain}+1 hoy`).text).toBe('Ve [Dato omitido]+1 hoy')
    expect(run(`Ve ana@${domain}-, hoy`).text).toBe('Ve [Dato omitido]-, hoy')
  })

  it('with no TLD, only a domain past 255 characters is taken', () => {
    expect(run(`Ve a@${'b'.repeat(255)} hoy`).text).toBe(`Ve a@${'b'.repeat(255)} hoy`)
    expect(run(`Ve a@${'b'.repeat(256)} hoy`).text).toBe('Ve [Dato omitido] hoy')
  })

  it('a long domain leaves the full stop after it', () => {
    expect(run(`Escribe a ana@${'b'.repeat(300)}.`).text).toBe('Escribe a [Dato omitido].')
  })

  // 🔴 Only labels this pipeline emits may be skipped. Anything else in
  // brackets is ordinary text, so a name inside it is redacted.
  it.each([
    ['Vino [Persona ANA] y Ana', ['Ana'], 'Vino [Persona [Persona A]] y [Persona A]'],
    ['En [Domicilio MARIA] vive María', ['María'], 'En [Domicilio [Persona A]] vive [Persona A]'],
    ['[Persona ANA]@gmail.com', ['Ana'], '[Persona [Persona A]][Dato omitido]'],
  ])('a bracket that only looks like a placeholder is text: %s', (text, roster, expected) => {
    expect(run(text, roster).text).toBe(expected)
  })

  it('a label this document emits, already in the text, is still skipped', () => {
    // Re-running on pipeline output: "Persona A" is the entry, `[Persona A]` its label.
    expect(run('Ya [Persona A] y Persona A.', ['Persona A']).text).toBe(
      'Ya [Persona A] y [Persona A].',
    )
  })

  it('a shorter entry inside a name that joined an address joins it too', () => {
    // "Ana" lies only on the part of "Ana María" OUTSIDE the email.
    expect(run('Escribe a Ana maría@gmail.com hoy', ['Ana María', 'Ana']).text).toBe(
      'Escribe a [Dato omitido] hoy',
    )
  })

  it('an address a longer name already joined is no longer a member label', () => {
    // "Pérez ana" (longer, first) joins the email; the entry that IS the email
    // then finds an address that grew, and joins it as well.
    expect(run('Vino Pérez ana@x.co hoy', ['Pérez ana', 'ana@x.co']).text).toBe(
      'Vino [Dato omitido] hoy',
    )
  })

  it('R9: an entry with no letter or digit matches nothing', () => {
    expect(run('Hola.. Ana', ['..', 'Ana']).text).toBe('Hola.. [Persona A]')
  })

  it('R9: an entry of only accent marks takes no label', () => {
    expect(run('Vino Ana', ['́́́', 'Ana']).text).toBe('Vino [Persona A]')
  })

  it('🔴 stays fast when names partly overlap thousands of addresses', () => {
    // 500 KB. Audit measurement: 92 s on the rewrite, 63 ms before it.
    const text = 'María @maría maria@x.com '.repeat(20_000)
    const t0 = performance.now()
    const out = run(text, ['María'])
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(out.text).toBe('[Persona A] [Dato omitido] [Dato omitido] '.repeat(20_000))
  })

  it.each([
    ['many placeholders', () => run('[Dato omitido] Ana '.repeat(20_000), ['Ana'])],
    ['domains with no TLD', () => run(`${'a'.repeat(64)}@${'b.'.repeat(127)}1 `.repeat(500))],
    ['long domains', () => run(`a@${'b'.repeat(400)} `.repeat(1000))],
    ['long local and domain', () => run(`${'a'.repeat(200)}@${'b'.repeat(300)}.com `.repeat(1000))],
  ])('stays fast on %s', (_, go) => {
    // Loose bound: each case took 30–800 ms alone (measured 2026-10-21, host
    // `torre`, load ~12). A quadratic sweep takes minutes.
    const t0 = performance.now()
    go()
    expect(performance.now() - t0).toBeLessThan(4000)
  })
})
