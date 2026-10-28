/**
 * KEEP PUBLIC FIGURES, RESTORED AFTER THE FACT (third audit, 2026-10-27).
 *
 * 🔴 THE INVARIANT. With the option on, the gate runs exactly as with it off;
 * a hold is the same hold; on a ready result the output is the option-off
 * output except at restored placeholders, and every restored span is a
 * `publica` finding's exact original text. Pinned here by the auditors'
 * probes (ported one by one) and by a property test over generated texts.
 *
 * Synthetic names only. Every model answer goes through the real
 * `parseFindings`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseFindings } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import { alignPlaceholders, gluedToNeighbour, nameShape } from './publicFigureRestore'
import type { GateResult, PersonDetector } from './types'
import { PLACEHOLDER_PATTERN } from './types'

type H = { texto: string; tipo: string; ambito?: unknown; motivo?: unknown }

function scripted(perCall: H[][]): PersonDetector {
  let n = 0
  return {
    name: 's',
    async detect({ text }) {
      return parseFindings(JSON.stringify({ hallazgos: perCall[n++] ?? [] }), text)
    },
  }
}

const pv = (texto: string): H => ({ texto, tipo: 'persona', ambito: 'privada' })
const pb = (texto: string, motivo = 'senador'): H => ({ texto, tipo: 'persona', ambito: 'publica', motivo })

const run = (text: string, calls: H[][], opts: { roster?: string[]; keep?: boolean; rounds?: number } = {}) =>
  runAnonymisationGate(
    { contentKind: 'documento', text, roster: opts.roster ?? [], keepPublicFigures: opts.keep ?? true },
    { detector: scripted(calls), verifyRounds: opts.rounds ?? 2 },
  )

/** Option on and off, same model answers. */
async function onOff(text: string, calls: H[][], opts: { roster?: string[]; rounds?: number } = {}) {
  const on = await run(text, calls, { ...opts, keep: true })
  const off = await run(text, calls, { ...opts, keep: false })
  return { on, off }
}

const textOf = (r: GateResult) => (r.status === 'ready' ? r.redactedText : (r.redactedText ?? null))
const keptOf = (r: GateResult) => (r.keptPublic ?? []).map((k) => k.name)

/** Nothing restored: ON is exactly OFF. */
async function same(text: string, calls: H[][], opts: { roster?: string[]; rounds?: number } = {}) {
  const { on, off } = await onOff(text, calls, opts)
  expect(on.status).toBe(off.status)
  expect(textOf(on)).toBe(textOf(off))
  expect(keptOf(on)).toEqual([])
  return on
}

/** The invariant, for any pair. */
function assertInvariant(on: GateResult, off: GateResult, publics: readonly string[]): void {
  expect(on.status).toBe(off.status)
  if (off.status === 'hold' || on.status === 'hold') {
    expect(on).toEqual(off)
    return
  }
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alts = publics.map(escape)
  let pattern = ''
  let last = 0
  for (const m of off.redactedText.matchAll(PLACEHOLDER_PATTERN)) {
    pattern += escape(off.redactedText.slice(last, m.index))
    pattern += `(?:${[escape(m[0]), ...alts].join('|')})`
    last = m.index + m[0].length
  }
  pattern += escape(off.redactedText.slice(last))
  expect(new RegExp(`^${pattern}$`, 'u').test(on.redactedText)).toBe(true)
  for (const name of keptOf(on)) expect(publics).toContain(name)
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('restores what it should', () => {
  it('a politician alone is restored and logged; the private citizen stays redacted', async () => {
    const text = 'El senador Ramiro Saldaña habló. Tadeo Villaseñor lo escuchó.'
    const { on, off } = await onOff(text, [[pb('Ramiro Saldaña'), pv('Tadeo Villaseñor')], [pb('Ramiro Saldaña')]])
    expect(on.status).toBe('ready')
    expect(textOf(on)).toMatch(/^El senador Ramiro Saldaña habló\. \[Persona [A-Z]\] lo escuchó\.$/)
    expect(on.keptPublic).toEqual([{ name: 'Ramiro Saldaña', motivo: 'senador' }])
    assertInvariant(on, off, ['Ramiro Saldaña'])
  })

  it('G: "Dr. Saldaña" publica beside an unnamed private doctor is restored', async () => {
    const { on } = await onOff('El Dr. Saldaña habló. El doctor de la clínica llamó.', [[pb('Dr. Saldaña'), pv('El doctor de la clínica')], []])
    expect(textOf(on)).toContain('El Dr. Saldaña habló.')
  })

  it('🔴 a hold is the option-off hold: nothing restored', async () => {
    const text = 'El senador Ramiro Saldaña habló con un vecino.'
    const { on, off } = await onOff(text, [[pb('Ramiro Saldaña')], [{ texto: 'vecino', tipo: 'otro' }]], { rounds: 1 })
    expect(on.status).toBe('hold')
    expect(on).toEqual(off)
  })
})

describe('🔴 third audit probes: nothing restored', () => {
  describe.each([
    ['newline', 'El senador Ramiro Saldaña habló. Su hijo Ramiro\nSaldaña Pérez fue golpeado.'],
    ['double space', 'El senador Ramiro Saldaña habló. Su hijo Ramiro  Saldaña Pérez fue golpeado.'],
    ['hyphen', 'El senador Ramiro Saldaña habló. Su hijo Ramiro Saldaña-Pérez fue golpeado.'],
  ])('A (%s): a private finding the filter dropped still demotes', (_l, T) => {
    it('verify []', () => same(T, [[pb('Ramiro Saldaña'), pv('Ramiro Saldaña Pérez')], []]))
    it('verify reports the son again', () =>
      same(T, [[pb('Ramiro Saldaña'), pv('Ramiro Saldaña Pérez')], [pv('Ramiro Saldaña Pérez')], [pv('Ramiro Saldaña Pérez')]]))
  })

  it('A: a private span with trailing words (dropped) still demotes', () =>
    same('El senador Ramiro Saldaña habló. Su hijo Ramiro Saldaña Pérez fue golpeado.', [
      [pb('Ramiro Saldaña'), pv('Ramiro Saldaña Pérez fue golpeado (menor)')],
      [],
    ]))

  describe('B: a private name reported only in verify', () => {
    const TB = 'El senador Saldaña Pérez votó. Ramiro Saldaña Pérez, su hijo, fue golpeado.'
    it.each([
      ['final []', []],
      ['final publica again', [pb('Saldaña Pérez')]],
      ['final surname privada', [pv('Saldaña Pérez')]],
    ] as const)('verify "Ramiro" privada, %s', async (_l, fin) => {
      const { on, off } = await onOff(TB, [[pb('Saldaña Pérez')], [pv('Ramiro')], [...fin]])
      expect(textOf(on)).not.toMatch(/Saldaña Pérez, su hijo/)
      assertInvariant(on, off, ['Saldaña Pérez'])
    })
    it.each([
      ['final []', []],
      ['final publica again', [pb('Saldaña Pérez')]],
      ['final surname privada', [pv('Saldaña Pérez')]],
    ] as const)('verify the son in full privada, %s', async (_l, fin) => {
      await same(TB, [[pb('Saldaña Pérez')], [pv('Ramiro Saldaña Pérez')], [...fin]])
    })
    it('three rounds', async () => {
      const { on, off } = await onOff(TB, [[pb('Saldaña Pérez')], [pv('Ramiro')], [], []], { rounds: 3 })
      expect(textOf(on)).not.toMatch(/Saldaña Pérez, su hijo/)
      assertInvariant(on, off, ['Saldaña Pérez'])
    })
  })

  it.each([
    'RAMIRO SALDAÑA Y TADEO VILLASEÑOR',
    'Ramiro Saldaña Y Tadeo Villaseñor',
    'Ramiro Saldaña E Isabel Ruiz',
    'Ramiro Saldaña Con Tadeo Villaseñor',
    'Ramiro Saldaña And Tadeo Villaseñor',
    'Ramiro Saldaña\tTadeo Villaseñor',
    'Ramiro Saldaña Tadeo Villaseñor',
    'Ramiro Saldaña De Tadeo Villaseñor',
    'Ramiro Saldaña Ni Tadeo Villaseñor',
    'Ramiro Saldaña, Tadeo Villaseñor',
  ])('C: multi-person span %j is never restored', async (s) => {
    const t = `Se reunieron ${s}. Fin.`
    await same(t, [[pb(s)], []])
    await same(t, [[pb(s)], [pb(s)]])
  })

  it('D: a variant of the name (diminutive + hyphenated caps) demotes', () =>
    same('El senador Ramiro Saldaña habló. Su hijo Ramirito SALDANA-Perez fue golpeado.', [[pb('Ramiro Saldaña'), pv('Ramirito SALDANA-Perez')], []]))

  it('D: a bare diminutive leaves "Saldaña" under the same label → nothing restored', () =>
    same('El senador Ramiro Saldaña habló. Ramirito Saldaña, su hijo, fue golpeado.', [[pb('Ramiro Saldaña'), pv('Ramirito')], []]))

  it('E: a roster name sharing a particle-joined surname demotes', () =>
    same('Sor Juana Inés de la Cruz escribió. Fernando de la Cruz coordinó.', [[pb('Sor Juana Inés de la Cruz')], []], { roster: ['Fernando de la Cruz'] }))

  it('E: a public span equal to a roster name, beside a private part → redacted', () =>
    same('Fernando de la Cruz escribió. La señora Cruz llamó.', [[pb('Fernando de la Cruz'), pv('señora Cruz')], []], { roster: ['Fernando de la Cruz'] }))

  it.each([
    ['Itzel Barragán coordinó el taller.'],
    ['itzel barragán coordinó el taller.'],
  ])('E: a lower-case roster entry still redacts %j', async (text) => {
    const on = await same(text, [[], []], { roster: ['itzel barragán'] })
    expect(textOf(on)).not.toMatch(/itzel|barragán/i)
  })

  it('E: a lower-case roster entry spreads its parts: "Itzel" alone is redacted', async () => {
    const on = await same('Itzel Barragán coordinó. Itzel tomó notas.', [[], []], { roster: ['itzel barragán'] })
    expect(textOf(on)).not.toMatch(/Itzel/)
  })

  it('F: a lower-case public span is never restored', () => same('el senador ramiro saldaña habló.', [[pb('ramiro saldaña')], []]))

  it('G: title + surname shares a part with a private person → redacted', () =>
    same('El senador Saldaña habló. Ramiro Saldaña, su hijo, fue golpeado.', [[pb('senador Saldaña'), pv('Ramiro Saldaña')], []]))

  it.each([[[0, 1, 2]], [[2, 1, 0]], [[1, 2, 0]], [[2, 0, 1]]])('H: a demotion chain in order %j', async (perm) => {
    const F = [pv('señora Pérez'), pb('Saldaña Pérez'), pb('Ramiro Saldaña')]
    await same('Ramiro Saldaña habló. Saldaña Pérez votó. La señora Pérez llamó.', [perm.map((i) => F[i] as H), []])
  })

  it('mutprobe N11: a shared first surname demotes', () =>
    same('El senador Gil Paz votó. Ramiro Gil Paz, su hijo, fue golpeado.', [[pb('Gil Paz'), pv('Ramiro Gil')], []]))

  it('mutprobe N2: lower-case text', () =>
    same('el senador ramiro saldaña votó. ramiro saldaña pérez, su hijo, fue golpeado.', [[pb('ramiro saldaña')], []]))

  it('(6) an unreported relative inside the public name → nothing restored', () =>
    same('El senador Ramiro Saldaña habló. Ramiro Saldaña Pérez, su hijo, fue golpeado.', [[pb('Ramiro Saldaña')], [], []]))

  it('(6) when verify moves the son to a label of his own, the senator alone is restored', async () => {
    const T = 'El senador Ramiro Saldaña habló. Ramiro Saldaña Pérez, su hijo, fue golpeado.'
    const { on, off } = await onOff(T, [[pb('Ramiro Saldaña')], [{ texto: '[Persona A] Pérez', tipo: 'persona' }], []])
    expect(textOf(on)).toMatch(/^El senador Ramiro Saldaña habló\. \[Persona [B-Z]\], su hijo/)
    assertInvariant(on, off, ['Ramiro Saldaña'])
  })
})

describe('the restore pieces', () => {
  it.each([
    ['el senador Ramiro Saldaña', 1, 2],
    ['Don Fernando de la Cruz', 1, 2],
    ['Dr. Anselmo Rivas', 1, 2],
    ['RAMIRO SALDAÑA', 1, 2],
    ['RAMIRO SALDAÑA Y TADEO VILLASEÑOR', 2, 4],
    ['Ramiro Saldaña Con Tadeo', 2, 3],
    ['Ramiro Saldaña\tTadeo', 2, 3],
    ['Ramiro Saldaña Tadeo Villaseñor', 1, 4],
    ['ramiro saldaña', 0, 0],
  ])('nameShape(%j) → %d groups, %d name words', (span, groups, nameWords) => {
    expect(nameShape(span)).toEqual({ groups, nameWords })
  })

  it('alignPlaceholders: a unique placement', () => {
    expect(alignPlaceholders('Ana y Luis llegaron', '[Persona A] y [Persona B] llegaron')).toEqual([
      { label: '[Persona A]', start: 0, end: 3 },
      { label: '[Persona B]', start: 6, end: 10 },
    ])
  })

  it('🔴 alignPlaceholders: an ambiguous placement → null', () => {
    // "y" could close either name: " y y " in the source.
    expect(alignPlaceholders('Ana y y Luis', '[Persona A] y [Persona B]')).toBeNull()
  })

  it('🔴 alignPlaceholders: placeholder-shaped text in the source → null', () => {
    expect(alignPlaceholders('[Persona A] y Ana', '[Persona A] y [Persona B]')).toBeNull()
  })

  it('alignPlaceholders: no placeholder → [] only when output is the source', () => {
    expect(alignPlaceholders('hola', 'hola')).toEqual([])
    expect(alignPlaceholders('hola', 'adiós')).toBeNull()
  })

  it.each([
    ['Ramiro Saldaña Pérez llegó', 0, 14, true],
    ['Ramiro Saldaña-Pérez llegó', 0, 14, true],
    ['Ramiro Saldaña\nPérez llegó', 0, 14, true],
    ['Ramiro Saldaña de la Garza llegó', 0, 14, true],
    ['Tomás Ramiro Saldaña llegó', 6, 20, true],
    ['Ayer. Ramiro Saldaña llegó', 6, 20, false],
    ['Ramiro Saldaña llegó', 0, 14, false],
    ['Ramiro Saldaña y Tadeo', 0, 14, false],
    ['declaró Ramiro Saldaña.', 8, 22, false],
  ] as const)('gluedToNeighbour(%j) → %s', (text, s, e, expected) => {
    expect(gluedToNeighbour(text, s, e)).toBe(expected)
  })
})

describe('🔴 property: option ON = option OFF except at restored public spans', () => {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T
  const FIRST = ['Ramiro', 'Tadeo', 'Itzel', 'María', 'Ana', 'José', 'Gil', 'Lucía']
  const LAST = ['Saldaña', 'Villaseñor', 'Barragán', 'López', 'Pérez', 'Ruiz', 'Paz']
  const TITLE = ['', 'el senador ', 'la diputada ', 'Don ', 'la señora ']
  const VERB = ['habló', 'votó', 'llegó', 'firmó']
  const SEP = [' ', '  ', '-', '\n', ', ', ' y ']

  it('holds over 400 generated cases', async () => {
    for (let i = 0; i < 400; i++) {
      const people = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
        rnd() < 0.4 ? `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}` : `${pick(FIRST)} ${pick(LAST)}`,
      )
      const sentences: string[] = []
      for (let k = 0; k < 2 + Math.floor(rnd() * 5); k++) {
        const p = pick(people)
        const parts = p.split(' ')
        const r = rnd()
        const mention =
          r < 0.4 ? p : r < 0.55 ? parts[0] : r < 0.7 ? parts.slice(1).join(' ') : r < 0.8 ? parts.join(pick(SEP)) : `${p} y ${pick(people)}`
        sentences.push(`${pick(TITLE)}${mention} ${pick(VERB)}.`)
      }
      const text = sentences.join(' ')
      const flag = (): Partial<H> => (rnd() < 0.5 ? { ambito: 'publica', motivo: 'cargo' } : rnd() < 0.5 ? { ambito: 'privada' } : {})
      const stage3: H[] = []
      for (const p of people) {
        if (rnd() < 0.85) stage3.push({ texto: p, tipo: 'persona', ...flag() })
        if (rnd() < 0.3) stage3.push({ texto: p.split(' ')[0] as string, tipo: 'persona', ...flag() })
        if (rnd() < 0.2) stage3.push({ texto: p.split(' ').slice(1).join(' '), tipo: 'persona', ...flag() })
      }
      const verify: H[] = rnd() < 0.6 ? [] : people.filter(() => rnd() < 0.4).map((p) => ({ texto: p, tipo: 'persona', ...flag() }))
      const roster = rnd() < 0.3 ? [pick(people)] : []
      const rounds = rnd() < 0.5 ? 1 : 2
      const calls = [stage3, verify, verify]
      const { on, off } = await onOff(text, calls, { roster, rounds })
      const publics = stage3.filter((h) => h.ambito === 'publica').map((h) => h.texto)
      try {
        assertInvariant(on, off, publics)
      } catch (err) {
        throw new Error(`case ${i}: ${JSON.stringify({ text, stage3, verify, roster, rounds })}\n${String(err)}`)
      }
    }
  }, 120_000)
})
