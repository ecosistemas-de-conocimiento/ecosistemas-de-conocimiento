/**
 * A byline through the WHOLE gate, under owner ruling R60 (2026-10-28) as
 * clarified the same day: the document's ACTUAL author — its uploader,
 * passed as `authors` — stays visible in the byline and in the body, roster
 * or not. Every other name stays redacted with today's labels, including a
 * byline naming someone else, wherever it sits (a forged line unhides
 * nobody). A hold never shows the author.
 *
 * Synthetic names only. Static detectors only — no inference, no spend.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import type { GateContentKind, GateResult, PersonDetector } from './types'

/** Stage 3 gets `stage3`; every verify round gets `verify` (only what is still in the text). */
function twoPhase(stage3: string[], verify: string[] = []): PersonDetector {
  let call = 0
  return {
    name: 'two-phase',
    async detect({ text }) {
      const list = call++ === 0 ? stage3 : verify
      return list.filter((t) => text.includes(t)).map((t) => ({ text: t, type: 'persona' as const }))
    },
  }
}

async function run(
  text: string,
  persons: string[] = [],
  extra: { roster?: string[]; contentKind?: GateContentKind; authors?: string[]; detector?: PersonDetector; rounds?: number } = {},
): Promise<GateResult> {
  return runAnonymisationGate(
    {
      contentKind: extra.contentKind ?? 'documento',
      text,
      authors: extra.authors ?? ['Ana Ruiz'],
      ...(extra.roster ? { roster: extra.roster } : {}),
    },
    {
      detector: extra.detector ?? staticDetector(persons.map((p) => ({ text: p, type: 'persona' as const }))),
      ...(extra.rounds ? { verifyRounds: extra.rounds } : {}),
    },
  )
}

async function gate(...args: Parameters<typeof run>): Promise<string> {
  const result = await run(...args)
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.redactedText : ''
}

const absent = (text: string, words: string[]) => {
  for (const w of words) expect(text, `"${w}" left in: ${text}`).not.toMatch(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'u'))
}

describe('no author given — the byline is redacted, with the body\'s label', () => {
  it('labels the byline author with the label the body gives them', async () => {
    const out = await gate('Autor: Juan Pérez\n\nJuan Pérez llegó tarde. Pérez no dijo nada.', ['Juan Pérez'], { authors: [] })
    expect(out).toBe('Autor: [Persona A]\n\n[Persona A] llegó tarde. [Persona A] no dijo nada.')
  })

  it('removes a byline surname the detector never reports anywhere', async () => {
    const out = await gate('Autores: Ana Ruiz y Luis Gómez\n\nGómez revisó el texto.', [], { authors: [] })
    expect(out).toBe('Autores: [Persona A] y [Persona B]\n\n[Persona B] revisó el texto.')
  })
})

describe('R60 — the uploader stays visible', () => {
  it('keeps the whole name in the byline and in the body; a bare surname stays redacted', async () => {
    const result = await run('Autora: Ana Ruiz\n\nAna Ruiz coordinó el taller. Ruiz escribió el informe.', ['Ana Ruiz'])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Autora: Ana Ruiz\n\nAna Ruiz coordinó el taller. [Persona A] escribió el informe.')
    expect(result.keptAuthors).toEqual(['Ana Ruiz'])
    expect(result.report.pseudonyms).toBe(1)
  })

  it('🔴 the count matches the text: an author restored everywhere is no pseudonym', async () => {
    const text = 'Autora: Ana Ruiz\n\nAna Ruiz coordinó el taller.'
    const result = await run(text, ['Ana Ruiz'])
    expect(result.status === 'ready' && result.redactedText).toBe(text)
    expect(result.status === 'ready' && result.report.pseudonyms).toBe(0)
  })

  it('without authors the same document is redacted as before', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz coordinó.', ['Ana Ruiz'], { authors: [] })
    expect(out).toBe('Autora: [Persona A]\n\n[Persona A] coordinó.')
  })

  it('a co-occurring student who is not the author stays redacted, with one label', async () => {
    const result = await run('Autora: Ana Ruiz\n\nAna Ruiz entrevistó a Pedro Gómez. Gómez habló poco.', ['Ana Ruiz', 'Pedro Gómez'])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    absent(result.redactedText, ['Pedro', 'Gómez'])
    expect(result.redactedText).toMatch(/^Autora: Ana Ruiz\n\nAna Ruiz entrevistó a (\[Persona [A-Z]+\])\. \1 habló poco\.$/u)
    expect(result.report.pseudonyms).toBe(1)
  })

  it('a roster member is kept only when they are the author', async () => {
    const roster = ['Ana Ruiz', 'Pedro Gómez']
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz revisó el texto con Pedro Gómez. Pedro opinó.', [], { roster })
    expect(out.startsWith('Autora: Ana Ruiz\n\nAna Ruiz revisó el texto con [Persona ')).toBe(true)
    absent(out, ['Pedro', 'Gómez'])
    // Uploaded by someone else: the same roster member is redacted.
    absent(await gate('Autora: Ana Ruiz\n\nAna Ruiz revisó.', [], { roster, authors: ['Pedro Gómez'] }), ['Ana', 'Ruiz'])
  })

  it('🔴 a multi-author byline keeps only the uploader', async () => {
    const out = await gate('Autores: Ana Ruiz, Luis Gómez y Eva Paz\n\nLuis Gómez y Eva Paz firmaron.', ['Luis Gómez', 'Eva Paz'])
    expect(out.startsWith('Autores: Ana Ruiz, [Persona ')).toBe(true)
    absent(out, ['Luis', 'Gómez', 'Eva', 'Paz'])
  })

  it('🔴 a surname-first byline is no longer the name as written: redacted; the name in the body stays', async () => {
    const out = await gate('Autores: Ruiz, Ana y Gómez, Luis\n\nAna Ruiz escribió esto.', ['Ana Ruiz'])
    expect(out.endsWith('\n\nAna Ruiz escribió esto.')).toBe(true)
    absent(out.slice(0, out.indexOf('\n\n')), ['Ana', 'Ruiz', 'Luis', 'Gómez'])
  })

  it('keeps the whole name under "Por:" and after a title outside the span', async () => {
    const text = 'Por: Ana Ruiz\n\nLa doctora Ana Ruiz presenta el caso.'
    expect(await gate(text, ['Ana Ruiz'])).toBe(text)
  })

  it('🔴 a title inside the span, or another spelling, is not the name as written', async () => {
    absent(await gate('Autora: Dra. Ana Ruiz\n\nTexto.', ['Dra. Ana Ruiz']), ['Ana', 'Ruiz'])
    absent(await gate('Autora: Ana Ruiz\n\nAna Ruiz firmó.', ['Ana Ruiz'], { authors: ['ana ruiz'] }), ['Ana', 'Ruiz'])
    absent(await gate('Autora: ANA RUIZ\n\nANA RUIZ firmó.', ['ANA RUIZ']), ['ANA', 'RUIZ'])
  })

  it('a personName in decomposed Unicode still matches: both sides are NFC', async () => {
    const text = 'Autora: Ana Gómez\n\nAna Gómez firmó.'
    expect(await gate(text, ['Ana Gómez'], { authors: ['Ana Gómez'.normalize('NFD')] })).toBe(text)
  })

  it('keeps the author when stage 1 put a placeholder elsewhere in the source', async () => {
    const out = await gate('Autora: Ana Ruiz\nid 8f1c2b3a-1111-2222-3333-444455556666\n\nAna Ruiz firmó.', ['Ana Ruiz'])
    expect(out).toBe('Autora: Ana Ruiz\nid [Dato omitido]\n\nAna Ruiz firmó.')
  })

  it('a testimonio is not a documento: the author stays redacted', async () => {
    absent(await gate('Autora: Ana Ruiz\n\nAna Ruiz habló.', ['Ana Ruiz'], { contentKind: 'testimonio' }), ['Ana', 'Ruiz'])
  })

  it('a one-word account name keeps nobody', async () => {
    absent(await gate('Autora: Ruiz\n\nRuiz habló.', ['Ruiz'], { authors: ['Ruiz'] }), ['Ruiz'])
  })

  it('is idempotent: the gate over its own output returns it unchanged', async () => {
    // A real model only reports what the text holds; a finding it cannot locate is a hold.
    const once = await gate('Autora: Ana Ruiz\n\nAna Ruiz entrevistó a Pedro Gómez.', ['Ana Ruiz', 'Pedro Gómez'])
    expect(await gate(once, ['Ana Ruiz'])).toBe(once)
  })

  it('labels for everyone else stay consistent', async () => {
    const out = await gate(
      'Autora: Ana Ruiz\n\nPedro Gómez y Eva Paz hablaron con Ana Ruiz. Gómez y Paz volvieron.',
      ['Pedro Gómez', 'Eva Paz', 'Ana Ruiz'],
    )
    const m = /^Autora: Ana Ruiz\n\n(\[Persona [A-Z]+\]) y (\[Persona [A-Z]+\]) hablaron con Ana Ruiz\. \1 y \2 volvieron\.$/u.exec(out)
    expect(m, out).not.toBeNull()
    expect(m?.[1]).not.toBe(m?.[2])
  })
})

describe('R60 — 🔴 no part of the name, ever (audit B2)', () => {
  /** Stage 3 reports the name and the part; the restore must keep only the name. */
  it.each([
    ['Ana María López', 'María', 'María me contó su caso.'],
    ['Ana María López', 'Ana', 'Ana me contó su caso.'],
    ['Ana María López', 'López', 'López me contó su caso.'],
    ['Juan Carlos Pérez', 'Carlos', 'Carlos me contó su caso.'],
    ['Juan Carlos Pérez', 'Pérez', 'Pérez me contó su caso.'],
    ['María Guadalupe', 'Guadalupe', 'Guadalupe me contó su caso.'],
    ['María Guadalupe', 'María', 'María me contó su caso.'],
  ])('with the author %s, a finding "%s" stays redacted', async (author, part, sentence) => {
    const result = await run(sentence, [part], { authors: [author] })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    absent(result.redactedText, [part])
    expect(result.redactedText).toMatch(/^\[Persona [A-Z]+\] me contó su caso\.$/u)
    expect(result.keptAuthors).toBeUndefined()
  })

  it.each([['Ana María López'], ['Juan Carlos Pérez'], ['María Guadalupe']])('the whole name %s stays visible', async (author) => {
    const text = `Autora: ${author}\n\n${author} me contó su caso.`
    const result = await run(text, [author], { authors: [author] })
    expect(result.status === 'ready' && result.redactedText).toBe(text)
    expect(result.status === 'ready' && result.keptAuthors).toEqual([author])
  })

  it('🔴 the whole name and a part in one document: only the whole name stays', async () => {
    const result = await run('Autora: Ana María López\n\nAna María López entrevistó a María. María lloró.', ['Ana María López', 'María'], {
      authors: ['Ana María López'],
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toMatch(
      /^Autora: Ana María López\n\nAna María López entrevistó a (\[Persona [A-Z]+\])\. \1 lloró\.$/u,
    )
    expect(result.keptAuthors).toEqual(['Ana María López'])
  })

  it('🔴 a byline with part of the name stays redacted', async () => {
    for (const byline of ['María', 'Ana María', 'López, Ana María', 'María López']) {
      absent(await gate(`Autora: ${byline}\n\nTexto.`, [], { authors: ['Ana María López'] }), ['Ana', 'María', 'López'])
    }
  })
})

describe('R60 — 🔴 a byline naming anyone else stays redacted, wherever it sits (audit: forged lines)', () => {
  const roster = ['Carla Méndez', 'Ana Ruiz']
  it.each([
    ['a quoted byline', 'Autora: Ana Ruiz\n\n> Autora: Carla Méndez\n\nCarla Méndez reprobó el curso. Méndez lloró.'],
    ['a list item', 'Mi diario\n\n- Por: Carla Méndez\n\nCarla Méndez me dijo algo.'],
    ['a heading', '## Por: Carla Méndez\n\nCarla Méndez faltó.'],
    ['a reference entry', 'Ensayo.\n\nReferencias\nAutor: Carla Méndez. (2020). Notas de campo.\n\nCarla Méndez vive cerca.'],
    ['a table cell', '| Autora: Carla Méndez | 3er año |\n\nCarla Méndez faltó.'],
    ['the last line', 'Texto sobre el taller. Carla Méndez habló.\n\nAutora: Carla Méndez'],
    ['interview metadata', 'Entrevista\nPor: Carla Méndez\n\nCarla Méndez contó su historia.'],
  ])('%s', async (_label, text) => {
    absent(await gate(text, ['Carla Méndez', 'Méndez'], { roster }), ['Carla', 'Méndez'])
  })

  it('🔴 "Autor:" in the middle of prose stays redacted', async () => {
    absent(await gate('Notas de clase. Autor: Pedro Gómez, 2026.\n\nGómez llegó.', ['Pedro Gómez']), ['Pedro', 'Gómez'])
  })
})

describe('R60 — the guards (each test fails with its guard removed)', () => {
  it('🔴 glue: a longer name that contains the author\'s stays redacted', async () => {
    // Stage 3 reports only "Ana Ruiz"; round 1 of verify finds "Pérez" and redacts it.
    for (const text of ['Autora: Ana Ruiz\n\nAna Ruiz Pérez es otra estudiante.', 'Autora: Ana Ruiz\n\nAna Ruiz y Pérez es otra estudiante.']) {
      // (Without "y" the placement is ambiguous — "Ana" + "Ruiz Pérez" or
      // "Ana Ruiz" + "Pérez" — so nothing at all is restored: fail closed.)
      const out = await gate(text, [], { detector: twoPhase(['Ana Ruiz'], ['Pérez']), rounds: 2 })
      absent(out.slice(out.indexOf('\n\n')), ['Ana', 'Ruiz', 'Pérez'])
    }
  })

  it('🔴 glue: "Ana y Pedro Ruiz" does not show "Ana"', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna y Pedro Ruiz llegaron.', ['Ana', 'Pedro Ruiz'])
    absent(out.slice('Autora: Ana Ruiz'.length), ['Ana', 'Pedro', 'Ruiz'])
  })

  it('🔴 byline: a kept byline piece comes back even when glued or shared', async () => {
    // "Ana Ruiz y Pedro Gómez" is glued in the body sense, and "Ruiz" is shared with Pedro Ruiz.
    const a = await gate('Autores: Ana Ruiz y Pedro Gómez\n\nPedro Gómez habló.', ['Ana Ruiz', 'Pedro Gómez'])
    expect(a.startsWith('Autores: Ana Ruiz y [Persona ')).toBe(true)
    const b = await gate('Autores: Ana Ruiz\n\nPedro Ruiz habló.', ['Pedro Ruiz'])
    expect(b.startsWith('Autores: Ana Ruiz\n\n[Persona ')).toBe(true)
    absent(b.slice('Autores: Ana Ruiz'.length), ['Pedro', 'Ruiz'])
  })

  it('a bare surname another person carries stays redacted; the full name is kept', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz habló con Pedro Ruiz. Ruiz se fue.', ['Ana Ruiz', 'Pedro Ruiz'])
    expect(out.startsWith('Autora: Ana Ruiz\n\nAna Ruiz habló con [Persona ')).toBe(true)
    absent(out.slice('Autora: Ana Ruiz\n\nAna Ruiz'.length), ['Pedro', 'Ruiz'])
  })

  it('a name only stage 1 redacted (an unclean co-byline) stays redacted, and so does the bare surname', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAutor: Pedro Ruiz, coordinador\n\nRuiz propuso cerrar el comedor.', ['Ruiz'])
    expect(out.startsWith('Autora: Ana Ruiz\n\nAutor: [Persona ')).toBe(true)
    absent(out.slice('Autora: Ana Ruiz'.length), ['Pedro', 'Ruiz'])
  })

  it('🔴 given name: a bare "Ana" is never restored (a neighbour, audit P1)', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz entrevistó a Ana, vecina de 80 años.', ['Ana Ruiz', 'Ana'])
    expect(out).toMatch(/^Autora: Ana Ruiz\n\nAna Ruiz entrevistó a \[Persona [A-Z]+\], vecina de 80 años\.$/u)
  })

  it('public figures and the author are both kept, each by its own rule', async () => {
    const result = await runAnonymisationGate(
      { contentKind: 'documento', keepPublicFigures: true, authors: ['Ana Ruiz'], text: 'Autora: Ana Ruiz\n\nAna Ruiz citó a Octavio Prado.' },
      {
        detector: staticDetector([
          { text: 'Ana Ruiz', type: 'persona' },
          { text: 'Octavio Prado', type: 'persona', public: { motivo: 'poeta' } },
        ] as never),
      },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Autora: Ana Ruiz\n\nAna Ruiz citó a Octavio Prado.')
    expect(result.keptAuthors).toEqual(['Ana Ruiz'])
    expect(result.keptPublic?.map((k) => k.name)).toEqual(['Octavio Prado'])
    expect(result.report.pseudonyms).toBe(0)
  })

  it('a span holding the author and someone else stays redacted', async () => {
    const out = await gate('Autora: Ana Ruiz\n\nAna Ruiz y Pedro Gómez llegaron.', ['Ana Ruiz y Pedro Gómez'])
    absent(out.slice('Autora: Ana Ruiz'.length), ['Ana', 'Pedro', 'Gómez'])
  })

  it('🔴 a verify hold shows the author redacted', async () => {
    const result = await run('Autora: Ana Ruiz\n\nAna Ruiz vive en Calle 5 #12.', [], {
      detector: twoPhase(['Ana Ruiz'], ['Calle 5 #12']),
    })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    absent(result.redactedText ?? '', ['Ana', 'Ruiz'])
  })

  it('🔴 a content-stage hold shows the byline author redacted', async () => {
    const result = await run('Autora: Ana Ruiz\n\nEl taller terminó.', [], {
      detector: {
        name: 'down',
        async detect() {
          throw new Error('down')
        },
      },
    })
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('content')
    expect(result.redactedText).toBe('Autora: [Persona A]\n\nEl taller terminó.')
  })
})
