/**
 * KEEP PUBLIC FIGURES (owner rulings 2026-10-27, "Semiosis práctica" case files).
 *
 * With `keepPublicFigures` on, a `documento` keeps the names of people named in
 * public discourse in a public role — politicians, officials, public
 * commentators, the author of a cited work, a speaker quoted at a public event
 * — and still redacts everyone else. Staff are private unless the model ties
 * them to a cited work or a public event. Unsure → redacted. Testimonios and
 * conversations never keep anyone.
 *
 * Q13 A: a staff documento gets the org roster; every roster name part is
 * redacted, unless the option is on and the model called THAT mention public.
 *
 * ⚠ All names and text are synthetic. Every model answer goes through the REAL
 * `parseFindings`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseFindings } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import type { GateContentKind, PersonDetector } from './types'

type H = { texto: string; tipo: string; ambito?: unknown; motivo?: unknown; identifica?: unknown }

/** Call 1 = stage 3, call 2.. = verify. Records whether classification was asked. */
function scripted(perCall: H[][]): PersonDetector & { asked: boolean[] } {
  let n = 0
  const asked: boolean[] = []
  return {
    name: 'scripted',
    asked,
    async detect({ text, classifyPublic }) {
      asked.push(classifyPublic === true)
      return parseFindings(JSON.stringify({ hallazgos: perCall[n++] ?? [] }), text)
    },
  }
}

const privada = (texto: string): H => ({ texto, tipo: 'persona', ambito: 'privada' })
const publica = (texto: string, motivo: unknown = 'senador'): H => ({ texto, tipo: 'persona', ambito: 'publica', motivo })

function gate(
  text: string,
  perCall: H[][],
  opts: { keep?: boolean; kind?: GateContentKind; roster?: string[]; rounds?: number } = {},
) {
  const detector = scripted(perCall)
  return {
    detector,
    result: runAnonymisationGate(
      {
        contentKind: opts.kind ?? 'documento',
        text,
        roster: opts.roster ?? [],
        ...(opts.keep === undefined ? {} : { keepPublicFigures: opts.keep }),
      },
      { detector, ...(opts.rounds ? { verifyRounds: opts.rounds } : {}) },
    ),
  }
}

/** A far-right case file. Synthetic. */
const CASE = [
  'Expediente 7. Informe de seguimiento.',
  'El senador Ramiro Saldaña declaró en un mitin que "la patria está en peligro".',
  'Un vecino, Tadeo Villaseñor, contó que recibió amenazas. Tadeo pidió reserva.',
].join('\n')

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('option off: behaviour identical to before', () => {
  it('the politician is redacted, nothing is logged, and classification is never asked', async () => {
    const calls = [[privada('Ramiro Saldaña'), privada('Tadeo Villaseñor')], []]
    const off = gate(CASE, calls, { keep: false })
    const absent = gate(CASE, calls)
    const [a, b] = [await off.result, await absent.result]
    expect(a).toEqual(b)
    expect(a.status).toBe('ready')
    if (a.status !== 'ready') return
    expect(a.redactedText).not.toMatch(/Saldaña|Tadeo|Villaseñor/)
    expect(a.keptPublic).toBeUndefined()
    expect(off.detector.asked).toEqual([false, false])
  })

  it('🔴 a model that volunteers "publica" anyway is ignored when the option is off', async () => {
    const { result } = gate(CASE, [[publica('Ramiro Saldaña'), privada('Tadeo Villaseñor')], []], { keep: false })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('Saldaña')
  })
})

describe('option on', () => {
  it('keeps and logs the politician, redacts the private citizen everywhere', async () => {
    const { result, detector } = gate(
      CASE,
      [[publica('El senador Ramiro Saldaña', 'senador en funciones'), privada('Tadeo Villaseñor')], [publica('El senador Ramiro Saldaña')]],
      { keep: true },
    )
    const out = await result
    expect(detector.asked).toEqual([true, true])
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toContain('El senador Ramiro Saldaña declaró')
    expect(out.redactedText).not.toMatch(/Tadeo|Villaseñor/)
    expect(out.keptPublic).toEqual([{ name: 'El senador Ramiro Saldaña', motivo: 'senador en funciones' }])
  })

  it.each([
    ['ambito missing', { texto: 'Ramiro Saldaña', tipo: 'persona', motivo: 'senador' }],
    ['ambito invalid', { texto: 'Ramiro Saldaña', tipo: 'persona', ambito: 'quizá', motivo: 'senador' }],
    ['motivo missing', { texto: 'Ramiro Saldaña', tipo: 'persona', ambito: 'publica' }],
    ['motivo blank', { texto: 'Ramiro Saldaña', tipo: 'persona', ambito: 'publica', motivo: '  ' }],
    ['motivo not a string', { texto: 'Ramiro Saldaña', tipo: 'persona', ambito: 'publica', motivo: 7 }],
    ['ambito unsure', { texto: 'Ramiro Saldaña', tipo: 'persona', ambito: 'no sé', motivo: 'quizá político' }],
  ])('🔴 %s → redacted', async (_label, finding) => {
    const { result } = gate(CASE, [[finding as H, privada('Tadeo Villaseñor')], []], { keep: true })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('Saldaña')
    expect(out.keptPublic ?? []).toEqual([])
  })

  it('🔴 the same name called publica in one finding and privada in another → redacted', async () => {
    const { result } = gate(CASE, [[publica('Ramiro Saldaña'), privada('Ramiro Saldaña'), privada('Tadeo Villaseñor')], []], {
      keep: true,
    })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('Saldaña')
  })

  it('🔴 a public figure who shares a surname with a private person is redacted too (re-audit 2026-10-27)', async () => {
    const text = [
      'La alcaldesa Brenda Iturbe habló en el foro.',
      'Mario Iturbe, un comerciante, la escuchó. Mario se fue temprano.',
    ].join('\n')
    const { result } = gate(text, [[publica('La alcaldesa Brenda Iturbe', 'alcaldesa'), privada('Mario Iturbe')], []], {
      keep: true,
    })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Brenda|Iturbe|Mario/)
    expect(out.keptPublic).toEqual([])
  })

  it('a public figure sharing no part with anyone private stays', async () => {
    const text = 'La alcaldesa Brenda Iturbe habló en el foro. Mario Quezada, un comerciante, la escuchó.'
    const { result } = gate(text, [[publica('La alcaldesa Brenda Iturbe', 'alcaldesa'), privada('Mario Quezada')], [publica('La alcaldesa Brenda Iturbe')]], {
      keep: true,
    })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toContain('La alcaldesa Brenda Iturbe habló')
    expect(out.redactedText).not.toMatch(/Mario|Quezada/)
  })

  it('🔴 a one-word "publica" that is also a private person\'s part → redacted', async () => {
    const text = 'Iturbe votó a favor. Mario Iturbe no estuvo de acuerdo.'
    const { result } = gate(text, [[publica('Iturbe', 'diputado'), privada('Mario Iturbe')], []], { keep: true })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Iturbe|Mario/)
  })
})

describe('verify with the option on', () => {
  it('🔴 verify calling the kept name privada → hold', async () => {
    const { result } = gate(CASE, [[publica('Ramiro Saldaña'), privada('Tadeo Villaseñor')], [privada('Ramiro Saldaña')]], {
      keep: true,
    })
    const out = await result
    expect(out.status).toBe('hold')
    if (out.status !== 'hold') return
    expect(out.stage).toBe('verify')
    expect(out.keptPublic).toEqual([{ name: 'Ramiro Saldaña', motivo: 'senador' }])
  })

  it('🔴 verify finding a different name still standing → hold, even if it says publica', async () => {
    const text = `${CASE}\nTambién habló Octavio Ruelas.`
    const { result } = gate(text, [[publica('Ramiro Saldaña'), privada('Tadeo Villaseñor')], [publica('Ramiro Saldaña'), publica('Octavio Ruelas')]], {
      keep: true,
    })
    expect((await result).status).toBe('hold')
  })

  it('🔴 a bare part of a public name that also stands alone, called privada by verify → hold', async () => {
    const text = 'El senador Ramiro Saldaña habló. Después Ramiro se fue.'
    const { result } = gate(text, [[publica('Ramiro Saldaña')], [publica('Ramiro Saldaña'), privada('Ramiro')]], { keep: true })
    expect((await result).status).toBe('hold')
  })
})

describe('staff and the roster (Q13 A)', () => {
  const ROSTER = ['Itzel Barragán', 'itzel.b@example.org']

  it('🔴 a staff member alone is redacted, bare first name included, option on or off', async () => {
    const text = 'Notas de campo. Itzel Barragán acompañó la entrevista. Itzel tomó notas.'
    for (const keep of [true, false]) {
      const { result } = gate(text, [[], []], { keep, roster: ROSTER })
      const out = await result
      expect(out.status).toBe('ready')
      if (out.status !== 'ready') return
      expect(out.redactedText).not.toMatch(/Itzel|Barragán/)
      expect(out.redactedText).toMatch(/^Notas de campo\. (\[Persona [A-Z]\]) acompañó la entrevista\. \1 tomó notas\.$/)
    }
  })

  it('🔴 the roster bare first name is redacted even when only it appears', async () => {
    const text = 'En la reunión, Itzel propuso revisar el caso.'
    const { result } = gate(text, [[], []], { keep: true, roster: ROSTER })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toMatch(/^En la reunión, \[Persona [A-Z]\] propuso revisar el caso\.$/)
  })

  it('🔴 a staff member the model calls privada is redacted', async () => {
    const text = 'Itzel Barragán coordinó la visita.'
    const { result } = gate(text, [[privada('Itzel Barragán')], []], { keep: true, roster: ROSTER })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toMatch(/^\[Persona [A-Z]\] coordinó la visita\.$/)
  })

  it('a staff member as the author of a cited work is kept and logged; their bare first name is not', async () => {
    const text = [
      'Como muestra Itzel Barragán en «Redes del odio» (2021), el discurso escala.',
      'Itzel revisó este borrador.',
    ].join('\n')
    const { result } = gate(
      text,
      [[publica('Itzel Barragán', 'autora de «Redes del odio» (2021)')], [publica('Itzel Barragán')]],
      { keep: true, roster: ROSTER },
    )
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toContain('Como muestra Itzel Barragán en «Redes del odio»')
    expect(out.redactedText).toMatch(/\n\[Persona [A-Z]\] revisó este borrador\.$/)
    expect(out.keptPublic).toEqual([{ name: 'Itzel Barragán', motivo: 'autora de «Redes del odio» (2021)' }])
  })

  it('a staff member quoted as a speaker at a public event is kept and logged', async () => {
    const text = 'En el foro público de marzo, Itzel Barragán dijo: "hay que documentar cada amenaza".'
    const { result } = gate(text, [[publica('Itzel Barragán', 'ponente en el foro público de marzo')], [publica('Itzel Barragán')]], {
      keep: true,
      roster: ROSTER,
    })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).toBe(text)
    expect(out.keptPublic).toEqual([{ name: 'Itzel Barragán', motivo: 'ponente en el foro público de marzo' }])
  })

  it('🔴 option off: the cited staff author is redacted anyway', async () => {
    const text = 'Como muestra Itzel Barragán en «Redes del odio» (2021), el discurso escala.'
    const { result } = gate(text, [[publica('Itzel Barragán', 'autora')], []], { keep: false, roster: ROSTER })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Itzel|Barragán/)
  })

  it('🔴 the roster email is redacted with the member label, option on', async () => {
    const text = 'Escribir a itzel.b@example.org para dudas.'
    const { result } = gate(text, [[], []], { keep: true, roster: ROSTER })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('itzel')
  })
})

describe('🔴 never for testimonios or conversations', () => {
  it.each(['testimonio', 'conversacion'] as const)('%s with the option on: the politician is redacted', async (kind) => {
    const { result, detector } = gate(CASE, [[publica('Ramiro Saldaña'), privada('Tadeo Villaseñor')], []], { keep: true, kind })
    const out = await result
    expect(detector.asked).toEqual([false, false])
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('Saldaña')
    expect(out.keptPublic).toBeUndefined()
  })
})

describe('🔴 audit 2026-10-27: a public span never hides a private name', () => {
  const ready = async (r: ReturnType<typeof gate>['result']) => {
    const out = await r
    expect(out.status).toBe('ready')
    return out.status === 'ready' ? out : null
  }

  it('A: "Ramiro Saldaña" publica inside "Ramiro Saldaña Pérez" privada → the son is redacted', async () => {
    const text = 'El senador Ramiro Saldaña habló. Su hijo, Ramiro Saldaña Pérez, no quiso declarar.'
    const out = await ready(
      gate(
        text,
        [[publica('senador Ramiro Saldaña'), publica('Ramiro Saldaña'), privada('Ramiro Saldaña Pérez')], [publica('senador Ramiro Saldaña')]],
        { keep: true },
      ).result,
    )
    // Re-audit 2026-10-27: sharing ANY name part with a private person demotes,
    // so the senator is redacted too. Over-redaction, accepted.
    expect(out?.redactedText).not.toMatch(/Ramiro|Saldaña|Pérez/)
    expect(out?.keptPublic).toEqual([])
  })

  it('A variant: the private name differs only in case and accents → still redacted', async () => {
    const text = 'El senador Ramiro Saldaña habló. Su hijo, RAMIRO SALDANA PEREZ, no quiso declarar.'
    const out = await ready(gate(text, [[publica('Ramiro Saldaña'), privada('RAMIRO SALDANA PEREZ')], []], { keep: true }).result)
    expect(out?.redactedText).not.toMatch(/PEREZ|RAMIRO/)
  })

  it('B: a two-person span "X y Y" is never public; the private one is redacted', async () => {
    const text = 'Se reunieron Ramiro Saldaña y Tadeo Villaseñor en la plaza.'
    const out = await ready(
      gate(text, [[publica('Ramiro Saldaña y Tadeo Villaseñor', 'senador y vecino'), privada('Tadeo Villaseñor')], []], { keep: true }).result,
    )
    expect(out?.redactedText).not.toMatch(/Tadeo|Villaseñor/)
    expect(out?.keptPublic ?? []).toEqual([])
  })

  it('B variant: "X y Y" publica with NO private finding → still not kept as a whole', async () => {
    const text = 'Se reunieron Ramiro Saldaña y Tadeo Villaseñor en la plaza.'
    const out = await ready(gate(text, [[publica('Ramiro Saldaña y Tadeo Villaseñor', 'políticos')], []], { keep: true }).result)
    expect(out?.redactedText).not.toMatch(/Tadeo|Villaseñor|Saldaña/)
  })

  it('B variant: a public span that contains a private finding → demoted', async () => {
    const text = 'Habló el senador Ramiro Saldaña, primo de Tadeo, en la plaza.'
    const out = await ready(
      gate(text, [[publica('el senador Ramiro Saldaña, primo de Tadeo', 'senador'), privada('Tadeo')], []], { keep: true }).result,
    )
    expect(out?.redactedText).not.toMatch(/Tadeo/)
  })

  it('C: roster "Itzel Barragán Ruiz" + "Itzel Barragán" publica → the staff member stays redacted', async () => {
    const text = 'Como muestra Itzel Barragán (2021), el discurso escala. Itzel Barragán Ruiz revisó el borrador.'
    const out = await ready(
      gate(text, [[publica('Itzel Barragán', 'autora citada')], []], { keep: true, roster: ['Itzel Barragán Ruiz'] }).result,
    )
    expect(out?.redactedText).not.toMatch(/Itzel|Barragán|Ruiz/)
    expect(out?.keptPublic ?? []).toEqual([])
  })

  it('C variant: a public span CONTAINING a roster name (but not equal) → demoted', async () => {
    const text = 'La investigadora Itzel Barragán habló en el foro.'
    const out = await ready(
      gate(text, [[publica('La investigadora Itzel Barragán', 'ponente')], []], { keep: true, roster: ['Itzel Barragán'] }).result,
    )
    expect(out?.redactedText).not.toMatch(/Itzel|Barragán/)
  })

  it('a public name inside an ADDRESS finding does not shield the address', async () => {
    const text = 'El senador Ramiro Saldaña habló frente a la tortillería de Ramiro Saldaña en la calle Hidalgo 12.'
    const out = await ready(
      gate(text, [[publica('Ramiro Saldaña'), { texto: 'tortillería de Ramiro Saldaña en la calle Hidalgo 12', tipo: 'lugar' }], []], {
        keep: true,
      }).result,
    )
    expect(out?.redactedText).not.toMatch(/Hidalgo|tortillería/)
  })
})

describe('🔴 audit 2026-10-27: same text typed persona publica and something else', () => {
  it.each(['otro', 'lugar', 'identificador'])('also typed %s → redacted', async (tipo) => {
    const { result } = gate(CASE, [[publica('Ramiro Saldaña'), { texto: 'Ramiro Saldaña', tipo }, privada('Tadeo Villaseñor')], []], {
      keep: true,
    })
    const out = await result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toContain('Saldaña')
    expect(out.keptPublic ?? []).toEqual([])
  })
})

describe('🔴 audit 2026-10-27: the shield markers cannot collide with the input', () => {
  it('a typed private-use marker in the text neither crashes nor leaks', async () => {
    const text = 'Marca 7 suelta. El senador Ramiro Saldaña habló con Tadeo Villaseñor.'
    for (const keep of [true, false]) {
      const { result } = gate(text, [[publica('Ramiro Saldaña'), privada('Tadeo Villaseñor')], [publica('Ramiro Saldaña')]], { keep })
      const out = await result
      expect(out.status).toBe('ready')
      if (out.status !== 'ready') return
      expect(out.redactedText).not.toMatch(/[]/)
      expect(out.redactedText).not.toContain('Tadeo')
    }
  })
})

describe('🔴 re-audit 2026-10-27: demotion by shared name part, not by string containment', () => {
  const T = 'El senador Saldaña Pérez votó. Ramiro Saldaña Pérez, su hijo, fue golpeado.'
  const clean = async (r: ReturnType<typeof gate>['result']) => {
    const out = await r
    const text = out.status === 'ready' ? out.redactedText : (out.redactedText ?? '')
    expect(text).not.toMatch(/Ramiro|Saldaña|Pérez/)
    expect(out.keptPublic ?? []).toEqual([])
  }

  it.each([
    ['verify reports the son privada', [privada('Ramiro Saldaña Pérez')]],
    ['verify reports "Ramiro" privada', [privada('Ramiro')]],
    ['verify reports the surname publica', [publica('Saldaña Pérez')]],
  ])('publica "Saldaña Pérez" + privada "Ramiro Saldaña": nothing ships (%s)', async (_l, verify) => {
    await clean(gate(T, [[publica('Saldaña Pérez'), privada('Ramiro Saldaña')], verify], { keep: true, rounds: 2 }).result)
  })

  it('the same with the option off', async () => {
    await clean(gate(T, [[publica('Saldaña Pérez'), privada('Ramiro Saldaña')], []], { keep: false, rounds: 2 }).result)
  })

  it('privada "Saldaña Pérez" + publica "Ramiro Saldaña Pérez": never "Ramiro Saldaña [Persona A]"', async () => {
    const text = 'Los Saldaña Pérez viven cerca. Ramiro Saldaña Pérez, senador, habló.'
    await clean(gate(text, [[privada('Saldaña Pérez'), publica('Ramiro Saldaña Pérez')], []], { keep: true, rounds: 2 }).result)
  })

  it('roster "Itzel Barragán" + publica "Barragán Ruiz" → never "[Persona A] Barragán Ruiz"', async () => {
    const text = 'Itzel Barragán Ruiz coordinó. Barragán Ruiz (2020) lo cita.'
    const out = await gate(text, [[publica('Barragán Ruiz', 'autora citada')], []], { keep: true, roster: ['Itzel Barragán'], rounds: 2 }).result
    const red = out.status === 'ready' ? out.redactedText : (out.redactedText ?? '')
    expect(red).not.toMatch(/Itzel|Barragán|Ruiz/)
  })

  it('a non-persona finding sharing a part demotes too', async () => {
    const text = 'El senador Ramiro Saldaña habló en la tortillería Saldaña de la calle Hidalgo 12.'
    const out = await gate(text, [[publica('Ramiro Saldaña'), { texto: 'tortillería Saldaña de la calle Hidalgo 12', tipo: 'lugar' }], []], {
      keep: true,
    }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Saldaña|Hidalgo/)
  })

  it('the staff exception: a publica equal to a roster name is kept only if no private finding shares a part', async () => {
    const text = 'Como muestra Itzel Barragán (2021), el discurso escala. Tomás Barragán, su primo, opinó.'
    const out = await gate(text, [[publica('Itzel Barragán', 'autora citada'), privada('Tomás Barragán')], []], {
      keep: true,
      roster: ['Itzel Barragán'],
    }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Itzel|Barragán|Tomás/)
  })

  it('…and the exception fails when another ROSTER name shares a part', async () => {
    const text = 'Como muestra Itzel Barragán (2021), el discurso escala.'
    const out = await gate(text, [[publica('Itzel Barragán', 'autora citada')], []], {
      keep: true,
      roster: ['Itzel Barragán', 'Itzel Montaño'],
    }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Itzel|Barragán/)
  })
})

describe('🔴 re-audit 2026-10-27: a span with two name groups is never public', () => {
  it.each([
    'Ramiro Saldaña, Tadeo Villaseñor',
    'Ramiro Saldaña – Tadeo Villaseñor',
    'Ramiro Saldaña con Tadeo Villaseñor',
    'Ramiro Saldaña (Tadeo Villaseñor)',
    'Ramiro Saldaña\nTadeo Villaseñor',
    'Ramiro Saldaña and Tadeo Villaseñor',
    'Ramiro Saldaña + Tadeo Villaseñor',
    'Ramiro Saldaña · Tadeo Villaseñor',
    'Ramiro Saldaña y Tadeo Villaseñor',
  ])('%j → redacted', async (span) => {
    const text = `Hablaron ${span} en la plaza.`
    const out = await gate(text, [[publica(span, 'políticos')], []], { keep: true }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/Ramiro|Saldaña|Tadeo|Villaseñor/)
    expect(out.keptPublic).toEqual([])
  })

  it.each(['el senador Ramiro Saldaña', 'Don Fernando de la Cruz', 'Dr. Anselmo Rivas', 'RAMIRO SALDAÑA'])(
    '%j is ONE name group and can be kept',
    async (span) => {
      const text = `Habló ${span} en la plaza.`
      const out = await gate(text, [[publica(span, 'senador')], [publica(span)]], { keep: true }).result
      expect(out.status).toBe('ready')
      if (out.status !== 'ready') return
      expect(out.redactedText).toBe(text)
    },
  )
})

describe('🔴 re-audit 2026-10-27: a lower-case roster name, option on', () => {
  it('"itzel barragán coordinó." is redacted', async () => {
    const text = 'itzel barragán coordinó. El senador Ramiro Saldaña habló.'
    const out = await gate(text, [[publica('Ramiro Saldaña')], [publica('Ramiro Saldaña')]], { keep: true, roster: ['Itzel Barragán'] }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/itzel|barragán/i)
    expect(out.redactedText).toContain('El senador Ramiro Saldaña habló.')
  })

  it('…and with the option off', async () => {
    const out = await gate('itzel barragán coordinó.', [[], []], { keep: false, roster: ['Itzel Barragán'] }).result
    expect(out.status).toBe('ready')
    if (out.status !== 'ready') return
    expect(out.redactedText).not.toMatch(/itzel|barragán/i)
  })
})
