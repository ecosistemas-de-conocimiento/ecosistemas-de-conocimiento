/**
 * Follow-ups from the audit of the name-parts fix (2026-10-27). Each case is
 * one finding of that audit. Synthetic text; every model answer goes through
 * the real `parseFindings`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseFindings } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import { createNamePartRegistry, namePartsOf, NOT_A_PART } from './nameParts'
import type { GateContentKind, PersonDetector } from './types'

type H = { texto: string; tipo: string }
type Call = H[] | ((text: string) => H[])

function scripted(perCall: Call[]): PersonDetector {
  let n = 0
  return {
    name: 'scripted',
    async detect({ text }) {
      const call = perCall[n++] ?? []
      const hallazgos = typeof call === 'function' ? call(text) : call
      return parseFindings(JSON.stringify({ hallazgos }), text)
    },
  }
}

const persona = (texto: string): H => ({ texto, tipo: 'persona' })

function gate(text: string, perCall: Call[], opts: { rounds?: number; roster?: string[]; kind?: GateContentKind } = {}) {
  return runAnonymisationGate(
    { contentKind: opts.kind ?? 'testimonio', text, roster: opts.roster ?? [] },
    { detector: scripted(perCall), ...(opts.rounds ? { verifyRounds: opts.rounds } : {}) },
  )
}

/** Whatever `<placeholder> <word>` verify would see now, reported as one finding. */
const extending = (word: string) => (text: string): H[] =>
  [...text.matchAll(new RegExp(`\\[Persona [A-Z]+\\] ${word}`, 'gu'))].map((m) => persona(m[0]))

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('(1) a bare part the model reports itself still obeys the glue rule', () => {
  it('🔴 "Fausto" and "Fausto Arellano" reported: "Fausto Martínez" never gets Arellano\'s label', async () => {
    const text = 'Firmó Fausto Arellano. Ayer Fausto llegó; dijo que Fausto Martínez no vendrá.'
    const result = await gate(text, [[persona('Fausto Arellano'), persona('Fausto')], extending('Martínez'), []], { rounds: 2 })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    const [, arellano, martinez] = /^Firmó (\[Persona [A-Z]\])\. Ayer \1 llegó; dijo que (\[Persona [A-Z]\]) no vendrá\.$/.exec(
      result.redactedText,
    ) ?? []
    expect(arellano).toBeDefined()
    expect(martinez).toBeDefined()
    expect(martinez).not.toBe(arellano)
  })

  it('🔴 …and stage 3 alone already gives the glued "Fausto" a label that is not Arellano\'s', async () => {
    const text = 'Firmó Fausto Arellano. Ayer Fausto llegó; dijo que Fausto Martínez no vendrá.'
    const result = await gate(text, [[persona('Fausto Arellano'), persona('Fausto')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Firmó [Persona A]. Ayer [Persona A] llegó; dijo que [Persona B] Martínez no vendrá.')
  })
})

describe('(2) a name sharing a part, found in a later round, is someone else', () => {
  it('🔴 "Pérez, [Persona A]" (A = María López) gets its own label, not López\'s', async () => {
    const text = 'María López llegó. María habló. Pérez, María firmó también.'
    const result = await gate(
      text,
      [[persona('María López')], (t) => (t.includes('Pérez, [Persona A]') ? [persona('Pérez, [Persona A]')] : []), []],
      { rounds: 2 },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toMatch(/^\[Persona A\] llegó\. \[Persona A\] habló\. \[Persona [B-Z]\] firmó también\.$/)
  })

  it('"[Persona A] López" for a one-word owner is still more of A', async () => {
    const text = 'Llegó Remedios. Remedios Lugo firmó.'
    const result = await gate(text, [[persona('Remedios')], extending('Lugo'), []], { rounds: 2 })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Llegó [Persona A]. [Persona A] firmó.')
  })

  it('a later second owner makes the shared part ambiguous from then on', () => {
    const names = createNamePartRegistry()
    const labels = new Map([['María López', 'A'], ['María Pérez', 'B']])
    const labelOf = (s: string) => labels.get(s) ?? s
    names.add('María López')
    expect(names.ownerOf('María', labelOf)).toBe('María López')
    names.add('María Pérez')
    expect(names.ownerOf('María', labelOf)).toBeNull()
  })
})

describe('(3) the rules mutation testing left unpinned', () => {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

  it.each([...NOT_A_PART].filter((w) => w.length >= 2))('"%s" is never a name part', (word) => {
    expect(namePartsOf(`${cap(word)} Zacarías Quiroz`)).toEqual(['Zacarías', 'Quiroz'])
  })

  it('an abbreviation not in the list is skipped by its period', () => {
    expect(namePartsOf('Pbro. Juan Soto')).toEqual(['Juan', 'Soto'])
  })

  it('a one-word span is never an owner', () => {
    const names = createNamePartRegistry()
    const labelOf = (s: string) => (s === 'Fausto' ? 'B' : 'A')
    names.add('Fausto Arellano')
    names.add('Fausto')
    expect(names.ownerOf('Fausto', labelOf)).toBe('Fausto Arellano')
  })

  it('a part split by a double space comes out as ONE placeholder', async () => {
    const text = 'Firmó Lucía Méndez. Luego firmó Lucía  Méndez otra vez.'
    const result = await gate(text, [[persona('Lucía Méndez')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Firmó [Persona A]. Luego firmó [Persona A] otra vez.')
  })
})

describe('(4) a name followed by a period still spreads its surname', () => {
  it('namePartsOf drops trailing punctuation', () => {
    expect(namePartsOf('Fausto Arellano.')).toEqual(['Fausto', 'Arellano'])
    expect(namePartsOf('Fausto Arellano),')).toEqual(['Fausto', 'Arellano'])
  })

  it('🔴 "Fausto Arellano." reported with its period: bare "Arellano" is redacted', async () => {
    const text = 'Lo firmó Fausto Arellano. Arellano insistió.'
    const result = await gate(text, [[persona('Fausto Arellano.')], []])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toContain('Arellano')
  })
})

describe('(5) roster names caught in stage 2 register their parts', () => {
  it('🔴 conversation: a member named in full also loses their bare first name', async () => {
    const text = 'Hola, soy Eulalia Cárdenas. Eulalia opina que sí.'
    const result = await gate(text, [[], []], { kind: 'conversacion', roster: ['Eulalia Cárdenas'] })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Hola, soy [Persona A]. [Persona A] opina que sí.')
  })

  it('conversation: a member never named does not spread', async () => {
    const text = 'Eulalia es una palabra en este texto. Nadie más.'
    const result = await gate(text, [[], []], { kind: 'conversacion', roster: ['Eulalia Cárdenas'] })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(text)
  })
})
