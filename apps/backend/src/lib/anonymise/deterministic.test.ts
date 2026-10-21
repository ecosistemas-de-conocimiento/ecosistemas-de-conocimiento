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
// DOMICILIOS
// ---------------------------------------------------------------------------

/**
 * ── 🔴 THE NEGATIVES ARE THE REAL TEST, AND THEY ARE REAL STRINGS ────────────
 *
 * The owner asked for addresses to be anonymised after the gate HELD a live test
 * testimony on a street address that survived every pass.
 *
 * Before writing a single pattern we grepped the 250-document synthetic corpus
 * (`corpus-generativo`). It contains ZERO addresses — no `Calle X 45`, no
 * `C.P. NNNNN`, no `Av.`, not one — and a great many address-shaped WORDS used
 * as ordinary Spanish:
 *
 *     `calle`     20 hits / 16 docs — every one `[se escucha ruido de calle]`
 *     `colonia`   365 hits / 159 docs — ~60% the common noun
 *     `manzana`   19 hits / 19 docs — a city block on a walking route
 *     `camino`    39 hits / 37 docs — metaphor
 *     `dirección` 26 hits / 22 docs — the school principal's office
 *
 * So a keyword rule would have redacted two thirds of that corpus, deleted the
 * thing those testimonies are ABOUT — the neighbourhood — and removed no address,
 * because there are none. `NO_DEBE_TOCAR` below is copied VERBATIM out of the
 * corpus and is the regression that keeps that from being shipped.
 *
 * ⚠ `DEBE_TOCAR` is CONSTRUCTED, and honestly so: there was nothing to copy. The
 * street forms come from the owner's own list; the place names inside them
 * (`Portales`, `Antonio Barona`, `Satélite`, `Ampliación Lázaro Cárdenas`,
 * Cuernavaca) are real strings from the corpus, so the false-positive traps that
 * matter are still exercised inside the positives.
 */
const DEBE_TOCAR: ReadonlyArray<readonly [string, string]> = [
  ['Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300.', 'Vivo en [Domicilio A].'],
  [
    'Nos reunimos en Av. Emiliano Zapata 128, Cuernavaca.',
    'Nos reunimos en [Domicilio A], Cuernavaca.',
  ],
  ['La casa está en Andador 5 de Mayo #12, int. 3.', 'La casa está en [Domicilio A].'],
  [
    'Mi domicilio es Priv. de los Pinos s/n, Col. Antonio Barona.',
    'Mi domicilio es [Domicilio A].',
  ],
  ['Calz. de la Viga 1450-B, C.P. 09810.', '[Domicilio A].'],
  ['Cerrada Josefa Ortiz No. 7, U.H. Vicente Guerrero.', '[Domicilio A].'],
  ['Boulevard Benito Juárez 300, Col. Satélite, CP 53100.', '[Domicilio A].'],
  // Lower-cased, the way a transcriber writes it when nobody dictated the caps.
  ['Vivo en calle morelos no. 45 desde hace años.', 'Vivo en [Domicilio A] desde hace años.'],
]

/** Copied verbatim from `corpus-generativo`. Not one of these is an address. */
const NO_DEBE_TOCAR: readonly string[] = [
  '[se escucha ruido de calle]',
  'Seguimos porque la colonia es nuestra.',
  'La escuela es el corazón de la colonia.',
  'Rol en el ecosistema: delegada de colonia',
  'ella conoce a las señoras de la colonia y sin ella no se abre ni la mitad de las puertas.',
  'Coordino con el delegado Reynaldo Ocampo las visitas por manzana.',
  'Parte de este camino lo he hecho junto a mi hermana Lucía, que también participa en estas actividades',
  'que lo que vemos en campo llegue arriba sin que se le caiga la mitad en el camino',
  'el problema lo vivimos nosotros con dirección y código postal',
  'La dirección no tenía manera de atenderla y yo apenas la ayudé con lo que pude.',
  'entre la familia nos vamos pasando el oficio y la terquedad',
  'entre el riesgo de allá abajo y el descuido de allá arriba',
  'Cuernavaca, a 20 de mayo de 2026.',
  'Villa de Ayala, a 27 de febrero de 2026.',
  'Residencia actual: Cuernavaca, Morelos (colonia Ciudad Chapultepec)',
  'Residencia actual: Ciudad de México (colonia Pedregal de Santo Domingo)',
  'Lugar de origen: San Juan Atzingo, Estado de México',
  'Escuela Primaria “Miguel Hidalgo” de la colonia Ciudad Chapultepec',
  'PILARES "Carlos Monsiváis" de la colonia Portales',
  'Soy comerciante del mercado en la colonia Ampliación Lázaro Cárdenas.',
  'Participé en la jornada de descacharrización de marzo de 2026 en la colonia La Carolina.',
  'Mi pueblo es San Juan Atzingo, Estado de México.',
  'Proyecto: IH-2025-I-445 · Fecha de registro: 14 de enero de 2026',
]

describe('deterministicPass — domicilios', () => {
  it('redacts a street line as ONE label, tails and all', () => {
    for (const [input, expected] of DEBE_TOCAR) {
      expect(run(input).text, input).toBe(expected)
    }
  })

  it('🔴 leaves every address-shaped sentence in the real corpus completely alone', () => {
    // See the block comment above. This is the assertion that stops the next
    // person "improving" the rules into a keyword match.
    for (const line of NO_DEBE_TOCAR) {
      const out = run(line)
      expect(out.text, line).toBe(line)
      expect(out.removed, line).toEqual([])
    }
  })

  it('🔴 shows towns, municipalities, alcaldías and states (owner, 2026-10-21, #12)', () => {
    // A town points at thousands of people, not at one home. The street, the
    // colonia and the C.P. beside it are still caught — see the next assertion.
    for (const line of [
      'Vivo en Xoxocotla, Morelos.',
      'Trabajo en el municipio de Puente de Ixtla.',
      'Vivo en la Alcaldía Iztapalapa, cerca del metro.',
      'fui a la Alcaldía Benito Juárez y luego de eso me fui',
      'Estudio en la Delegación Coyoacán.',
      'Soy de Rancho Nuevo, Chiapas.',
    ]) {
      const out = run(line)
      expect(out.text, line).toBe(line)
      expect(out.removed, line).toEqual([])
    }
    expect(run('Vivo en calle Morelos No. 45, Xoxocotla, Morelos, C.P. 62680.').text).toBe(
      'Vivo en [Domicilio A], Xoxocotla, Morelos, [Domicilio B].',
    )
    expect(run('Vivo en Col. Portales, Alcaldía Benito Juárez.').text).toBe(
      'Vivo en [Domicilio A], Alcaldía Benito Juárez.',
    )
    expect(run('Mi código es C.P. 06700.').text).toBe('Mi código es [Domicilio A].')
  })

  it('🔴 does NOT match a loose word run with a bare number — the sentence trap', () => {
    // `en la calle hay 20 casas` is ordinary Spanish and is the sentence the
    // two-arm design in `DOMICILIO` exists to refuse. It matched while the
    // pattern carried the `i` flag, because `i` makes \p{Lu} match lower-case
    // letters and "a capitalised street name" silently became "any word".
    for (const line of [
      'En la calle hay 20 casas sin agua.',
      'En el camino nos faltaron 3 garrafones.',
      'Por esa avenida pasan 40 camiones al día.',
    ]) {
      expect(run(line).text, line).toBe(line)
    }
  })

  it('redacts a bare postal code, and labels it `codigo-postal`', () => {
    const out = run('El expediente dice C.P. 62577 y nada más.')
    expect(out.text).toBe('El expediente dice [Domicilio A] y nada más.')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.codigoPostal])
  })

  it('redacts abbreviated settlements: Col., Fracc., Mz./Lt.', () => {
    for (const line of [
      'Col. Portales, por el mercado.',
      'Fracc. Los Sauces, casa 22.',
      'Mz. 4 Lt. 12, por allá.',
    ]) {
      const out = run(line)
      expect(out.text, line).toContain('[Domicilio A]')
      expect(labels(out.removed), line).toEqual([DETERMINISTIC_LABELS.asentamiento])
    }
  })

  it('🔴 the same address said twice gets the SAME label', () => {
    // The point of a label rather than a redaction bar. Two `[Dato omitido]`s
    // erase whether the person came back to the same house; two `[Domicilio A]`s
    // keep it. Matching is punctuation- and case-insensitive because a
    // transcriber writes the address a different way every time.
    const out = run('Nací en Calle Morelos No. 45 y volví a calle morelos no. 45 en 2020.')
    expect(out.text).toBe('Nací en [Domicilio A] y volví a [Domicilio A] en 2020.')
    expect(out.allocator.addressCount).toBe(1)
  })

  it('🔴 two different addresses get DIFFERENT labels', () => {
    const out = run('Me mudé de Calle Morelos No. 45 a Av. Zapata 128.')
    expect(out.text).toBe('Me mudé de [Domicilio A] a [Domicilio B].')
    expect(out.allocator.addressCount).toBe(2)
  })

  it('🔴 people and addresses have SEPARATE sequences — both start at A', () => {
    // A shared counter would make the report's `pseudonyms` number — which an
    // admin reads as "how many people are in this testimony" — silently wrong.
    const out = run('Ana López vive en Calle Morelos No. 45.', ['Ana López'])
    expect(out.text).toBe('[Persona A] vive en [Domicilio A].')
    expect(out.allocator.count).toBe(1)
    expect(out.allocator.addressCount).toBe(1)
  })

  it('⚠ runs BEFORE numero-largo, so a postal code is never scored as a long number', () => {
    // Same specific-before-greedy discipline as `email` before `numero-largo`.
    // If the order flipped, `C.P. 06700` would report as `numero-largo` and the
    // `C.P.` marker would stay in the corpus next to a `[Dato omitido]`.
    const out = run('C.P. 06700')
    expect(labels(out.removed)).toEqual([DETERMINISTIC_LABELS.codigoPostal])
    expect(labels(out.removed)).not.toContain(DETERMINISTIC_LABELS.numeroLargo)
  })

  it('⚠ the report names the RULE and never the address', () => {
    const out = run('Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300.')
    const serialized = JSON.stringify(out.removed)
    expect(serialized).not.toContain('Morelos')
    expect(serialized).not.toContain('Portales')
    expect(serialized).not.toContain('03300')
  })
  it('🔴 stops at the clause boundary instead of eating the sentence', () => {
    /**
     * THREE MEASURED OVER-MATCHES, ALL FROM THE SAME GREEDY TAIL.
     *
     * `(?:\s+WORD){0,4}` after `Col.` / `Alcaldía` has no terminator, so with a
     * LOOSE word it ran straight into the next clause. Two consequences, and the
     * second is the worse one: the sentence is destroyed, AND the match differs
     * per occurrence, so the same colonia collects `[Domicilio A]`,
     * `[Domicilio B]`, … — which defeats the entire reason these are labels and
     * not redaction bars.
     *
     * Fixed by making every word after the first STRICT (capitalised), and by
     * dropping `y` from the connector list — it is the word that joins an
     * address to whatever comes next.
     */
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        'Calle Morelos No. 45, Col. Portales y ahí vivía mi tía Rosa',
        '[Domicilio A] y ahí vivía mi tía Rosa',
      ],
      ['Col. Portales y despues de eso ya no supe mas', '[Domicilio A] y despues de eso ya no supe mas'],
    ]
    for (const [input, expected] of cases) {
      expect(run(input).text, input).toBe(expected)
    }
  })

  it('🔴 a connector never matches the PREFIX of a longer word', () => {
    // `de` was an alternative in a group with nothing after it, so it matched
    // the first two letters of `despues` and the redaction came back as
    // `[Domicilio A]spues de eso` — a shredded word, not a redaction. The
    // trailing boundary on the connector list is what stops it.
    expect(run('Col. Portales despues de eso').text).toBe('[Domicilio A] despues de eso')
    expect(run('Col. Portales delante del pozo').text).toBe('[Domicilio A] delante del pozo')
  })

  it('leaves `camino` and spelled-out `número` alone — both are prose', () => {
    // `camino` occurs 39 times in the corpus and is a metaphor every time; it is
    // deliberately not a vía. `número` spelled out is not a marker, because "la
    // casa número 3" is an ordinary sentence and the loose arm's any-word run
    // sat right in front of it.
    for (const line of [
      'camino de regreso a la casa número 3 de la escuela',
      'el camino de Dios 40 años después',
      'que no se le caiga la mitad en el camino',
    ]) {
      expect(run(line).text, line).toBe(line)
    }
  })

  it('⚠ a KNOWN over-match, written down rather than pretended away', () => {
    // `privada` + a capitalised word + a bare number matches, and here the
    // capitalised word is a person and the number is an age. Over-redaction, so
    // it costs meaning and never leaks — the safe direction — and tightening it
    // further would cost `Av. Zapata 128`, which is the shape the rule exists
    // for. Recorded so the next reader knows it was weighed, not missed.
    expect(run('la privada Ana 20 años tenía').text).toBe('la [Domicilio A] años tenía')
  })

  it('⚠ stays LINEAR on a whole transcript — these run on every document', () => {
    /**
     * 🔴 THE ADDRESS PATTERNS NEST A QUANTIFIER INSIDE AN ALTERNATION
     * (`(?:\s+WORD){1,6}` on two arms), which is the shape catastrophic
     * backtracking comes from. This stage runs on the FULL text of every
     * testimony before the model ever sees it, so a pathological input would
     * hang the ingest worker rather than merely be slow.
     *
     * What keeps it linear is the `{1,6}` CEILING — the run cannot grow with the
     * input. Measured here rather than reasoned about, because the reasoning is
     * exactly the kind that is quietly wrong after the next edit.
     *
     * The bound is deliberately loose (2s against a measured ~4ms) so this fails
     * on a real blow-up and not on a loaded CI box.
     */
    const cases = [
      'Calle ' + 'Morelos '.repeat(400),
      'Calle ' + 'Morelos '.repeat(400) + '45',
      'En la calle Morelos Zapata Juarez Hidalgo Allende '.repeat(400),
      'calle ' + 'palabra '.repeat(400) + 'no. 45',
      'Vivo en Calle Morelos No. 45, Col. Portales, C.P. 03300. '.repeat(2000),
      /**
       * 🔴 THE QUADRATIC CASE, AND IT WAS REAL. `\s*,?\s*` puts two `\s*` either
       * side of an optional comma, so a run of n spaces can be split n ways and
       * the engine tries every split when the literal after it fails. Measured
       * before the fix: 16k spaces 0.7s, 32k 2.8s, 64k 10.8s, 100k 26.2s — on the
       * server thread, on text any uploader controls, and PDF extraction produces
       * long whitespace runs BY ACCIDENT. `\s*(?:,\s*)?` is unambiguous: 1.4ms at
       * 100k.
       */
      'Calle Morelos No. 45' + ' '.repeat(100_000) + 'x',
      'Col. Portales' + '\n'.repeat(64_000) + 'x',
    ]
    for (const text of cases) {
      const started = performance.now()
      run(text)
      expect(performance.now() - started, `${text.length} chars`).toBeLessThan(2000)
    }
  })
})
