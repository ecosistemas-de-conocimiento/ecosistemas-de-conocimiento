/**
 * Byline audits 1–3 (2026-10-28), against the ADDITIVE byline passes.
 *
 * Two earlier fixes replaced the byline rules with an "is this author an
 * institution?" classifier, and both were blocked: names the old rules
 * redacted leaked again. The rule now is ADDITIVE ONLY — the old rules run
 * unchanged and the new passes only redact and register MORE. So this file
 * holds three kinds of case:
 *
 *   · LEAK FIXES — red on the old rules, green now (";" / "|" authors, mid-line
 *     lists, "Ma." / "Pbro.", one-word authors, unread key forms);
 *   · KEPT — every case the audits used to block the classifier: still
 *     redacted, as the old rules redact them;
 *   · ACCEPTED OVER-REDACTION — pinned, so changing it is a decision.
 *
 * Synthetic names only. staticDetector only — no inference, no spend.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import { trimEdgeEnd, trimEdges } from './nameParts'
import { splitAuthors, structuralPass } from './structural'

/** A `person` spy: records each name and hands out A, B, C… */
function spy() {
  const seen: string[] = []
  const person = (name: string) => {
    seen.push(name)
    return `[Persona ${String.fromCharCode(64 + seen.length)}]`
  }
  return { seen, person }
}

async function gate(text: string): Promise<string> {
  const result = await runAnonymisationGate({ contentKind: 'documento', text }, { detector: staticDetector([]) })
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.redactedText : ''
}

const noneOf = (text: string, words: string[]) => {
  for (const w of words) expect(text, `"${w}" left in: ${text}`).not.toMatch(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'u'))
}

describe('leak fix — every author after ";" and "|" (audit 1, finding 1)', () => {
  it.each(['; ', ' | '])('redacts the second author after "%s"', (sep) => {
    expect(structuralPass(`Autores: Ana Ruiz${sep}Luis Gómez`).text).toBe(
      `Autores: [Dato omitido]${sep}[Dato omitido]`,
    )
  })

  it('registers each author, in order, after the ones the old rules registered', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Ana Ruiz; Luis Gómez; Eva Paz', { person })
    expect(out.text).toBe('Autores: [Persona A]; [Persona B]; [Persona C]')
    expect(seen).toEqual(['Ana Ruiz', 'Luis Gómez', 'Eva Paz'])
  })

  it('takes a surname-first list', async () => {
    const out = await gate('Autores: Ruiz García, Ana María; Gómez Paz, Luis Eva\n\nGómez habló. Eva también.')
    noneOf(out, ['Ruiz', 'García', 'Ana', 'María', 'Gómez', 'Paz', 'Luis', 'Eva'])
  })

  it('a later bare surname goes too', async () => {
    noneOf(await gate('Autores: Ana Ruiz | Luis Gómez\n\nGómez revisó.'), ['Gómez'])
  })

  it('⚠ stops at another field', () => {
    expect(structuralPass('Autores: Ana Ruiz; Luis Gómez | Lugar: Puebla').text).toBe(
      'Autores: [Dato omitido]; [Dato omitido] | Lugar: Puebla',
    )
    expect(structuralPass('Autora: Ana Ruiz; Fecha: marzo').text).toBe('Autora: [Dato omitido]; Fecha: marzo')
  })

  it('⚠ leaves prose after ";" alone, and still takes a name after it', () => {
    expect(structuralPass('Autor: Ana Ruiz; el texto fue revisado').text).toBe(
      'Autor: [Dato omitido]; el texto fue revisado',
    )
    expect(structuralPass('Autores: Ana Ruiz; ver anexo 3; Eva Paz').text).toBe(
      'Autores: [Dato omitido]; ver anexo 3; [Dato omitido]',
    )
  })

  it('redacts a short lower-case name after ";" without registering it', () => {
    const { seen, person } = spy()
    expect(structuralPass('Autores: Ana Ruiz; luis gómez', { person }).text).toBe(
      'Autores: [Persona A]; [Dato omitido]',
    )
    expect(seen).toEqual(['Ana Ruiz'])
  })
})

describe('leak fix — a mid-line byline keeps no author (audit 1, finding 3)', () => {
  it('redacts every author in a comma list', () => {
    expect(structuralPass('Notas de clase. Autores: Ana Ruiz, Luis Gómez y Eva Paz, en Puebla.').text).toBe(
      'Notas de clase. Autores: [Dato omitido], [Dato omitido] y [Dato omitido], en Puebla.',
    )
  })

  it('stops where the sentence goes on', () => {
    expect(structuralPass('La autora: Ana Ruiz, Luis Gómez y Eva Paz llegaron.').text).toBe(
      'La autora: [Dato omitido], [Dato omitido] y [Dato omitido] llegaron.',
    )
  })

  it('redacts every author after ";" mid-line, and keeps the next sentence', () => {
    expect(structuralPass('Notas de clase. Autores: Ana Ruiz; Luis Gómez. El texto.').text).toBe(
      'Notas de clase. Autores: [Dato omitido]; [Dato omitido]. El texto.',
    )
  })

  it('⚠ keeps the year', () => {
    expect(structuralPass('Notas. Autor: Juan Pérez, 2026.').text).toBe('Notas. Autor: [Dato omitido], 2026.')
  })

  it('takes a name that starts with a particle', async () => {
    const out = await gate('Notas. Autor: del Lara, Lía Paz.\n\nLo dijo Lara. Lo dijo Paz.')
    noneOf(out, ['Lara', 'Lía', 'Paz'])
  })

  it.each([
    'Autor(es): Juan Pérez y Ana Ruiz',
    'Autor/a: Juan Pérez y Ana Ruiz',
    'Autora/Autores: Juan Pérez, Ana Ruiz',
    'Notas. Autora/Autores: Juan Pérez, Ana Ruiz.',
    'Notas. Autor(es): Juan Pérez, Ana Ruiz.',
  ])('reads the key "%s"', async (line) => {
    noneOf(await gate(`${line}\n\nPérez y Ruiz.`), ['Juan', 'Pérez', 'Ana', 'Ruiz'])
  })

  it('⚠ leaves prose with no byline key alone', () => {
    const prose = 'Llegaron Ana Ruiz, Luis Gómez y Eva Paz a la reunión.'
    expect(structuralPass(prose).text).toBe(prose)
    const lower = 'Lo dice el autor: según Ana, Luis y Eva, la obra es colectiva.'
    expect(structuralPass(lower).text).toBe(lower)
  })
})

describe('leak fix — "Ma." and "Pbro." (audit 1, finding 4)', () => {
  it.each(['Autora: Ma. Elena Ruiz', 'Autor: Pbro. Juan Gómez', 'Notas. Autor: Dr. Juan Gómez.'])(
    'leaves no name in "%s"',
    (line) => noneOf(structuralPass(line).text, ['Elena', 'Ruiz', 'Juan', 'Gómez']),
  )

  it('mid-line too, keeping the year', () => {
    const out = structuralPass('Notas. Autora: Ma. Elena Ruiz, 2026.').text
    noneOf(out, ['Elena', 'Ruiz'])
    expect(out).toMatch(/, 2026\.$/u)
  })

  it('after an id key too', () => {
    expect(structuralPass('El usuario: Ma. Elena Ruiz entró.').text).toBe('El [Dato omitido]. [Dato omitido] entró.')
  })

  it('spreads the name, not the title', async () => {
    const out = await gate('Autora: Ma. Elena Ruiz\n\nElena habló. Ruiz también.')
    noneOf(out, ['Elena', 'Ruiz'])
  })

  it('"vda. de" is part of the name', async () => {
    noneOf(await gate('Autora: Ana Ruiz vda. de Gómez\n\nGómez habló.'), ['Gómez'])
  })
})

describe('leak fix — a one-word author spreads (audit 2, items 3 and 4)', () => {
  it.each([
    ['Autores: Colectivo Norte y Ruiz\n\nRuiz habló.', ['Ruiz']],
    ['Autores: CIDE y Gómez\n\nGómez habló.', ['Gómez']],
    ['Autores: Equipo Norte y Ana\n\nAna habló.', ['Ana']],
    ['Autores: Instituto Mora, Ruiz\n\nRuiz habló.', ['Ruiz']],
    ['Autores: El Colegio de México, Ruiz\n\nRuiz habló.', ['Ruiz']],
    ['Autores: Ana Ruiz y Gómez\n\nGómez habló.', ['Gómez']],
    ['Autor: Ana Ruiz, Luis\n\nLuis habló.', ['Luis']],
    ['Autor: RUIZ\n\nRuiz habló.', ['Ruiz']],
    ['Autores: Ruiz, Ana, Gómez, Luis\n\nRuiz y Gómez. Ana y Luis.', ['Ruiz', 'Gómez', 'Ana', 'Luis']],
  ] as const)('%j', async (text, words) => {
    noneOf(await gate(text), [...words])
  })
})

/**
 * Every case the audits used to block the classifier. The old rules redact each
 * name below; so must every later version.
 */
describe('kept — what the old rules already redacted (audits 2 and 3)', () => {
  it.each([
    // audit 2, (1) two three-word people are two people
    ['Autores: Ana Ruiz García y Luis Gómez Paz\n\nRuiz y Gómez revisaron. Paz firmó.', ['Ruiz', 'Gómez', 'Paz']],
    // (2) a title is not a name word
    ['Autor: Dr. Juan Carlos López García\n\nLópez habló.', ['López']],
    ['Autora: Lic. María José Ruiz Paz\n\nRuiz habló.', ['Ruiz']],
    // (3) an institution and a person in one list
    ['Autores: Colectivo Tierra Viva y Ana Ruiz\n\nRuiz coordinó.', ['Ruiz']],
    ['Autores: Universidad Veracruzana y Luis Gómez\n\nGómez habló.', ['Gómez']],
    // (4) "Surname, Given", the surname a head word
    ['Autor: Ciudad Ruiz, Ana\n\nRuiz coordinó.', ['Ruiz']],
    // (5) five words and more are a person too
    ['Autor: José María de la Cruz Pérez Gómez\n\nPérez habló. Gómez también.', ['Pérez', 'Gómez']],
    ['Autora: María Fernanda Lía López García\n\nGarcía habló. Lía también.', ['García', 'Lía']],
    ['Autora: Ana María Guadalupe Ruiz Paz\n\nLo dijo Ruiz. Lo dijo Guadalupe.', ['Ruiz', 'Guadalupe']],
    ['Autores: José María de la Cruz Pérez Gómez y Ana Ruiz\n\nLo dijo Pérez.', ['Pérez']],
    ['Notas. Autor: José María de la Cruz Pérez Gómez.\n\nLo dijo Pérez.', ['Pérez']],
    ['Autores: Ruiz Paz, Ana María Guadalupe; Gómez, Luis\n\nLo dijo Ruiz.', ['Ruiz']],
    // particles
    ["Autora: Ana d'Ávila\n\nLo firmó Ávila.", ['Ávila']],
    ['Autora: Ana van der Berg\n\nLo firmó Berg.', ['Berg']],
    // parentheses and brackets
    ['Autor: Juan Pérez (Lucho) Gómez\n\nLo dijo Gómez.', ['Gómez']],
    ['Autor: Juan Pérez [entrevistador] Gómez\n\nLo dijo Gómez.', ['Gómez']],
    ['Autor: Juan Pérez (coord.) Gómez\n\nGómez habló.', ['Gómez']],
    ['Autor: Juan Pérez alias Gómez\n\nGómez habló.', ['Gómez']],
    // a leading "de la"
    ['Autor: de la Vega, Ana Lía\n\nLo dijo Vega.', ['Vega']],
    // a head word that is a surname's neighbour
    ['Autor: Red Gómez\n\nLo dijo Gómez.', ['Gómez']],
    ['Autor: Grupo Ruiz\n\nLo dijo Ruiz.', ['Ruiz']],
    ['Autor: Centro Ruiz\n\nRuiz habló.', ['Ruiz']],
    // a place after the author
    ['Autor: Juan Pérez, Ciudad de México\n\nPérez vive en México.', ['Pérez']],
    ['Autores: Juan Pérez de la Universidad Veracruzana\n\nPérez habló.', ['Pérez']],
  ] as const)('%j', async (text, words) => {
    noneOf(await gate(text), [...words])
  })
})

describe('leak fix — particles and parentheses in a mid-line name (audit 3)', () => {
  it.each([
    ["Notas. Autora: Ana d'Ávila.\n\nLo firmó Ávila.", ['Ávila']],
    ['Notas. Autora: Ana van der Berg.\n\nLo firmó Berg.', ['Berg']],
    ['Notas. Autor: Juan Pérez (Lucho) Gómez.\n\nLo dijo Gómez.', ['Gómez']],
  ] as const)('%j', async (text, words) => {
    noneOf(await gate(text), [...words])
  })
})

describe('kept — "Estado" in a byline (audit 2 mutation M2)', () => {
  it('a surname after "Estado" spreads', async () => {
    noneOf(await gate('Autor: Estado Gómez, Lía\n\nGómez habló.'), ['Gómez'])
  })

  it('"Estado" as a surname spreads', async () => {
    noneOf(await gate('Autor: Lía Estado\n\nEstado firmó. Lía habló.'), ['Estado', 'Lía'])
  })

  it('"Estado de México" after the author keeps the author redacted', async () => {
    noneOf(await gate('Autor: Juan Pérez, Estado de México\n\nPérez vive en México.'), ['Pérez'])
  })
})

/**
 * ⚠ ACCEPTED OVER-REDACTION (owner, 2026-10-28). An institution in a byline is
 * registered like a person, so its words spread. Exempting institutions is
 * what leaked names twice; a later "México" read as a person is the price.
 */
describe('accepted over-redaction — an institution author spreads', () => {
  it('"México" after "Autor: Universidad Nacional Autónoma de México"', async () => {
    expect(await gate('Autor: Universidad Nacional Autónoma de México\n\nEn México.')).toBe(
      'Autor: [Persona A]\n\nEn [Persona A].',
    )
  })

  // New with the one-word owners: the old rules registered "Oaxaca" but never spread it.
  it('a place after the author', async () => {
    expect(await gate('Autor: Juan Pérez, Oaxaca\n\nEn Oaxaca llovió.')).toBe(
      'Autor: [Persona A], [Persona B]\n\nEn [Persona B] llovió.',
    )
  })
})

/** Pins details the mutation run found untested (mutants M10, M17–M19, M21, M23, M24). */
describe('details of the additive passes', () => {
  it('registers the title with the name after it', () => {
    const { seen, person } = spy()
    structuralPass('Autora: Ma. Elena Ruiz', { person })
    expect(seen).toEqual(['Ma', 'Ma. Elena Ruiz'])
  })

  it('registers glued words with the name before them', () => {
    const { seen, person } = spy()
    structuralPass('Notas. Autor: Juan Pérez (Lucho) Gómez.', { person })
    expect(seen).toEqual(['Juan Pérez', 'Juan Pérez (Lucho) Gómez'])
  })

  it('"alias" and "vda." glue a mid-line name', async () => {
    noneOf(await gate('Notas. Autor: Juan Pérez alias Gómez.\n\nGómez habló.'), ['Gómez'])
    noneOf(await gate('Notas. Autora: Ana Ruiz vda. de Gómez.\n\nGómez habló.'), ['Gómez'])
  })

  it('counts a name after an id key title as an id, not an author', () => {
    const out = structuralPass('El usuario: Ma. Elena Ruiz entró.')
    expect(out.removed).toEqual([{ label: 'identificador-interno', count: 2 }])
  })

  it('"Autora/Autores:" at a field start is a field: a lower-case name after a comma goes', () => {
    expect(structuralPass('Autora/Autores: Juan Pérez, ana ruiz').text).toBe(
      'Autora/Autores: [Dato omitido], [Dato omitido]',
    )
  })

  it('a field under an unread key is redacted whole, as the old rules do under "Autor:"', () => {
    expect(structuralPass('Autor(es): el equipo').text).toBe('Autor(es): [Dato omitido]')
  })

  it('⚠ a segment with a digit after "|" is not an author', () => {
    expect(structuralPass('Autor: Ana Ruiz | Entrevista 3 | Lugar: Oaxaca').text).toBe(
      'Autor: [Dato omitido] | Entrevista 3 | Lugar: Oaxaca',
    )
  })
})

/** Audit 4 (2026-10-28). */
describe('audit 4', () => {
  it('mutant M22: a lower-case name after ";" mid-line goes', () => {
    expect(structuralPass('Notas. Autores: Ana Ruiz; luis gómez.').text).toBe(
      'Notas. Autores: [Dato omitido]; [Dato omitido].',
    )
  })

  it('mutant M22: mid-line, prose after ";" is skipped, not the end of the list', () => {
    expect(structuralPass('Notas. Autores: Ana Ruiz; ver anexo; Luis Gómez.').text).toBe(
      'Notas. Autores: [Dato omitido]; ver anexo; [Dato omitido].',
    )
  })

  it('mutant M32: an author value stops where an id redaction starts', () => {
    const { seen, person } = spy()
    const out = structuralPass('Autores: Ana Ruiz; Luis Paz usuario: 42', { person })
    expect(out.text).toBe('Autores: [Persona A]; [Persona B] [Dato omitido]')
    expect(seen).toEqual(['Ana Ruiz', 'Luis Paz'])
  })

  it.each([
    'Autores: Ana Ruiz; Luis Gómez (2021)',
    'Autor: Ana Ruiz | Luis Gómez (2021) | Lugar: Oaxaca',
    'Notas. Autores: Ana Ruiz, Luis Gómez (2021).',
    'Notas. Autores: Ana Ruiz; Luis Gómez (2021). El texto.',
    'Autor(es): Ana Ruiz, Luis Gómez (2021)',
  ])('🔴 a year in parentheses does not keep the author: %j', async (line) => {
    noneOf(await gate(`${line}\n\nGómez habló.`), ['Luis', 'Gómez'])
  })

  // fuzz5 (audit 4) leaks the old rules had too, fixed here.
  it.each([
    ['Notas de campo. Autor: Paz Ruiz, Ximena Carlos | Gómez (2021)', ['Gómez']],
    ['Fecha: 2021 | Autora/Autores: Ana (Lupita) Ruiz Olvera | María Juan Vega; Sosa, Diego | Lugar: Oaxaca', ['Ruiz', 'Olvera', 'Vega', 'Sosa']],
    ['Autora/Autores: Equipo 3; Berg, Ximena.', ['Berg', 'Ximena']],
    ['Notas de campo. Autor/a: lic. sofía rojas; Dr. Sofía (Chepe) Lara | van der Paz Olvera, José. El texto.', ['Lara', 'Paz', 'Olvera']],
    ['Notas de campo. Autora/Autores: ruiz / Mtra. Ximena José (Lupita) Rojas Ruiz y Diego María Rojas. Lugar: Oaxaca', ['Rojas', 'Ruiz']],
    ['Notas de campo. **Autores:** sra. elena diego pérez | Ruiz, Juan; treviño (2021)', ['Ruiz', 'Juan']],
    ["Notas de campo. Autor(es): Mtra. Eva d'Gómez / juan de berg | Ma. Eva d'Olvera vda. de Paz", ['Olvera', 'Paz']],
  ] as const)('🔴 fuzz5: %j', async (line, words) => {
    noneOf(await gate(`${line}\n\n${words.map((w) => `Lo dijo ${w}.`).join(' ')}`), [...words])
  })

  it('⚠ a lower-case sentence after a mid-line key stays', () => {
    const prose = 'Como dice la autora: la escuela es comunidad, y el autor: según él, todo cambió.'
    expect(structuralPass(prose).text).toBe(prose)
  })

  /** One line, no newlines (a PDF extraction), a byline every ~1 KB. */
  const oneLineDoc = (n: number) => {
    const para = 'El trabajo comunitario reunió a docentes y madres de familia en la escuela durante varios meses. '.repeat(9)
    return Array.from({ length: n }, (_, i) => `${para}Autor: Ana Ruiz${i % 2 ? ' y Luis Gómez' : ''}; `).join('')
  }

  it('🔴 time grows linearly with a one-line document (2 MB)', () => {
    // A RATIO of two runs on the same box, so load does not decide it: 8x the
    // text must cost well under 64x (quadratic). Measured 2026-10-28:
    // 2 MB took 4.3 s against 24 ms with the old rules.
    // Best of three each: one cold run of 2 MB pays for JIT and GC, not the code.
    // Measured 2026-10-28 (local, tsx): 0.25 MB 4.7 ms, 2 MB 38.5 ms.
    const time = (text: string) => {
      let best = Infinity
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now()
        structuralPass(text, { person: () => '[Persona A]' })
        best = Math.min(best, performance.now() - t0)
      }
      return best
    }
    const small = oneLineDoc(280)
    const big = oneLineDoc(2240)
    expect(big.length).toBeGreaterThan(2_000_000)
    const ratio = time(big) / Math.max(time(small), 1)
    expect(ratio).toBeLessThan(24)
  }, 30_000)
})

/** Audit 5 (2026-10-28). */
describe('audit 5', () => {
  it('🔴 a long run of spaces stays linear (200k spaces)', () => {
    // A RATIO of two runs on the same box. Measured 2026-10-28:
    // 60k spaces took 23.9 s (old rules: 11.4 s, its own author split).
    const time = (n: number) => {
      const text = `Autor: Ana Ruiz | Lugar${' '.repeat(n)}Oaxaca`
      let best = Infinity
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now()
        structuralPass(text, { person: () => '[Persona A]' })
        best = Math.min(best, performance.now() - t0)
      }
      return best
    }
    const small = time(25_000)
    const big = time(200_000)
    expect(big / Math.max(small, 1)).toBeLessThan(24)
  }, 60_000)

  it('the linear author split returns exactly what String.split returns', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const atoms = [' ', '  ', '\t', '\n', ' ', ',', ';', '/', '&', 'y', 'e', 'and', 'Ana', 'x', '.', '|']
    const split = /(\s*[,;/&]\s*|\s+(?:y|e|and)\s+)/u
    for (let k = 0; k < 20_000; k++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => atoms[Math.floor(rnd() * atoms.length)]).join('')
      expect(splitAuthors(s), JSON.stringify(s)).toEqual(s.split(split))
    }
  })

  it('the linear edge trims return exactly what their regexes return', () => {
    let seed = 11
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const atoms = [' ', '\t', '\n', '.', ',', '¿', '—', '"', 'a', 'Ana', 'é', '😀', '·', '(', ')']
    for (let k = 0; k < 20_000; k++) {
      const s = Array.from({ length: Math.floor(rnd() * 9) }, () => atoms[Math.floor(rnd() * atoms.length)]).join('')
      expect(trimEdgeEnd(s), JSON.stringify(s)).toBe(s.replace(/[\s\p{P}]+$/u, ''))
      expect(trimEdges(s), JSON.stringify(s)).toBe(s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ''))
    }
  })

  it('🔴 the gate stays linear on a byline name with a long run of spaces', async () => {
    // Measured 2026-10-28: "Autor: Ana" + 60k spaces + "Oaxaca" took 11.3 s in the
    // gate on the old rules (author split, name-part trim, fragment trim), 3.1 s here
    // before the linear trims.
    const time = async (n: number) => {
      const text = `Autor: Ana${' '.repeat(n)}Oaxaca\n\nTexto.`
      const t0 = performance.now()
      await gate(text)
      return performance.now() - t0
    }
    await time(5_000) // warm-up
    const small = await time(25_000)
    const big = await time(200_000)
    expect(big / Math.max(small, 1)).toBeLessThan(24)
  }, 60_000)

  // Leaks found by surviving mutants (audit 5): each test fails with its mutant.
  it.each([
    ['N8', 'Autora/Autores: CIDE e ma. ana ávila mora', ['ana', 'ávila', 'mora']],
    ['N11b', '\tAutor (a): Ma. José Ochoa Vega / lic. Juan Ruiz. ; Authors = Óscar Ávila', ['Juan', 'Ruiz']],
    ['N15', 'Notas. Autor/a: dr. óscar ávila y vda. de Juan Sosa (2021)', ['Juan', 'Sosa']],
    [
      'N22',
      `Autor/a: Lic. ${String.fromCharCode(0xfdd0)}0${String.fromCharCode(0xfdd1)} Lía Sosa,Ma. María Ochoa y Lic. \t José Ávila`,
      ['José', 'Ávila'],
    ],
  ] as const)('mutant %s: %j', (_m, line, words) => {
    noneOf(structuralPass(line, { person: () => '[Persona A]' }).text, [...words])
  })
})

/**
 * Audit 4, item 5: a stray U+FDD0 / U+FDD1 used to switch the additive passes
 * off. They are replaced (U+FFFD) first, so the passes always run.
 */
describe('noncharacters in the input', () => {
  const O = String.fromCharCode(0xfdd0)
  const C = String.fromCharCode(0xfdd1)
  const NONCHAR = new RegExp(`[${O}${C}]`, 'u')
  const bodies: Array<[string, string[]]> = [
    ['Autores: Ana Ruiz; Luis Gómez\n\nRuiz y Gómez hablaron.', ['Luis', 'Gómez']],
    ['Notas. Autores: Ana Ruiz, Luis Gómez y Eva Paz.\n\nPaz habló.', ['Luis', 'Gómez', 'Eva', 'Paz']],
    ['Autora: Ma. Elena Ruiz\n\nRuiz habló.', ['Elena', 'Ruiz']],
    ['Autor(es): Juan Pérez\n\nPérez habló.', ['Juan', 'Pérez']],
    ['usuario: Ma. Elena Ruiz\n\nRuiz.', ['Elena']],
  ]
  const marks = [`${O}0${C}`, `${O}1${C}`, `${O}99${C}`, O, C, O.repeat(3), `x${O}0`, `0${C}`]
  // At the start the mark takes its own line: a digit glued to a key ("0Autores:")
  // stops the key in the old rules as well (KEY_START), with or without noncharacters.
  const cases = bodies.flatMap(([b, words]) =>
    marks.flatMap((m) => [`${m}\n${b}`, `${b} ${m}`, b.replace('\n\n', ` ${m}\n\n`)].map((t) => [t, words] as const)),
  )

  it.each(cases)('%j', async (text, words) => {
    const out = await gate(text)
    expect(out).not.toMatch(NONCHAR)
    noneOf(out, [...words])
  })

  it('a forged sentinel is never resolved to a label', () => {
    const out = structuralPass(`Nota ${O}0${C}.\nAutor: Ana Ruiz`, { person: () => '[Persona A]' })
    expect(out.text).toBe(`Nota ${String.fromCharCode(0xfffd)}0${String.fromCharCode(0xfffd)}.\nAutor: [Persona A]`)
  })
})

describe('the sentinels the additive passes use', () => {
  it('no sentinel survives in the output', () => {
    const out = structuralPass('Notas. Autores: Ana Ruiz, Luis Gómez; Eva Paz | usuario: 42\nuser 7a')
    expect(out.text).not.toMatch(/[\ufdd0\ufdd1]/u)
  })
})

describe('field labels are not authors (over-redaction fix)', () => {
  it.each([
    ['Autor: Ana Ruiz | Lugar', 'Autor: [Dato omitido] | Lugar'],
    ['Autores: Ana Ruiz y Luis Gómez | Lugar y fecha', 'Autores: [Dato omitido] y [Dato omitido] | Lugar y fecha'],
    ['Autor: Ana Ruiz | Lugar de la entrevista | Luis Gómez', 'Autor: [Dato omitido] | Lugar de la entrevista | [Dato omitido]'],
    ['Autor: Ana Ruiz; Fecha', 'Autor: [Dato omitido]; Fecha'],
  ])('%s', (text, expected) => {
    expect(structuralPass(text).text).toBe(expected)
  })

  it('🔴 a piece with any other word is still redacted', () => {
    for (const text of ['Autor: Ana Ruiz | Lugar Oaxaca', 'Autor: Ana Ruiz | Lugar de Luis Gómez', 'Autor: Ana Ruiz | Fecha Paz']) {
      expect(structuralPass(text).text).toBe('Autor: [Dato omitido] | [Dato omitido]')
    }
  })

  it('a later "Lugar" in the body survives, even when the old rules labelled it in the byline', async () => {
    expect(await gate('Autor: Ana Ruiz | Lugar\nEl Lugar importa.')).toBe('Autor: [Persona A] | Lugar\nEl Lugar importa.')
    expect(await gate('Autores: Ana Ruiz, Lugar\nEl Lugar importa.')).toBe('Autores: [Persona A], [Persona B]\nEl Lugar importa.')
  })
})
