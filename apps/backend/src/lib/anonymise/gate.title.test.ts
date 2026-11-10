/**
 * P-13 / I-07 / C-10 (owner decision 2026-11-10): the title of a gated
 * `documento` goes through the gate, with the body's labels, and the body's
 * output is the same with or without it.
 */

import { describe, expect, it } from 'vitest'

import { runAnonymisationGate } from './gate'
import type { DetectorFinding, GateContentKind, GateInput, PersonDetector } from './types'

/** Reports each listed span present in the text it is given. Counts calls. */
function detector(spans: readonly string[], opts: { throwOn?: (text: string) => boolean } = {}) {
  const seen: string[] = []
  const d: PersonDetector = {
    name: 'static',
    async detect({ text }): Promise<DetectorFinding[]> {
      seen.push(text)
      if (opts.throwOn?.(text)) throw new Error('boom')
      return spans.filter((t) => text.includes(t)).map((t) => ({ text: t, type: 'persona' as const }))
    },
  }
  return { d, seen }
}

const BODY = 'Acta de la entrevista. Juan Pérez contó que la junta se reunió en la escuela.'

async function run(input: Partial<GateInput> & { text: string }, spans: readonly string[], opts = {}) {
  const { d, seen } = detector(spans, opts)
  const result = await runAnonymisationGate(
    { contentKind: 'documento' as GateContentKind, ...input },
    { detector: d, verifyRounds: 1 },
  )
  return { result, seen }
}

describe('🔴 the title of a gated documento is redacted with the body', () => {
  it('"Entrevista a Juan Pérez.pdf" takes the label the body gives Juan Pérez', async () => {
    const { result } = await run(
      { text: `María López abrió la sesión. ${BODY}`, title: 'Entrevista a Juan Pérez.pdf' },
      ['María López', 'Juan Pérez'],
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    const bodyLabel = /\[Persona [A-Z]+\](?= contó)/.exec(result.redactedText)?.[0]
    expect(bodyLabel).toBe('[Persona B]')
    expect(result.redactedTitle).toBe(`Entrevista a ${bodyLabel}.pdf`)
  })

  it('a bare surname in the title takes its owner\'s body label', async () => {
    const { result } = await run({ text: BODY, title: 'Visita con Pérez' }, ['Juan Pérez'])
    expect(result.redactedTitle).toBe('Visita con [Persona A]')
  })

  it('a title with no names is unchanged', async () => {
    const { result } = await run({ text: BODY, title: 'Informe de la junta del agua.pdf' }, ['Juan Pérez'])
    expect(result.redactedTitle).toBe('Informe de la junta del agua.pdf')
  })

  it('a name only the title has takes the next free label', async () => {
    const { result } = await run({ text: BODY, title: 'Notas de Rosa Martínez' }, ['Juan Pérez', 'Rosa Martínez'])
    expect(result.redactedTitle).toBe('Notas de [Persona B]')
  })

  it('a roster member keeps the body\'s label in the title', async () => {
    const { result } = await run(
      { text: 'Itzel Barragán presentó. Juan Pérez votó.', title: 'Minuta Itzel Barragán', roster: ['Itzel Barragán'] },
      ['Juan Pérez'],
    )
    if (result.status !== 'ready') throw new Error(result.status)
    expect(result.redactedText.startsWith('[Persona A] presentó')).toBe(true)
    expect(result.redactedTitle).toBe('Minuta [Persona A]')
  })

  it('🔴 fails closed: a detector that throws on the title gives null, not the name', async () => {
    const { result } = await run({ text: BODY, title: 'Notas de Rosa Martínez' }, ['Juan Pérez'], {
      throwOn: (t: string) => t.startsWith('Notas'),
    })
    expect(result.status).toBe('ready')
    expect(result.redactedTitle).toBeNull()
  })

  it('🔴 the body is byte-identical with or without a title, and pays no extra call without one', async () => {
    const spans = ['María López', 'Juan Pérez', 'Rosa Martínez']
    const text = `María López abrió la sesión. ${BODY}`
    const without = await run({ text }, spans)
    const withTitle = await run({ text, title: 'Rosa Martínez y Juan Pérez.pdf' }, spans)
    expect(withTitle.result).toMatchObject({ status: without.result.status })
    if (without.result.status !== 'ready' || withTitle.result.status !== 'ready') throw new Error('not ready')
    expect(withTitle.result.redactedText).toBe(without.result.redactedText)
    expect(withTitle.result.report).toEqual(without.result.report)
    expect(without.result).not.toHaveProperty('redactedTitle')
    expect(withTitle.seen.length).toBe(without.seen.length + 1)
    expect(withTitle.result.redactedTitle).toBe('[Persona C] y [Persona B].pdf')
  })

  it.each(['testimonio', 'conversacion'] as const)('a %s title is not processed (its title is neutral)', async (kind) => {
    const { result, seen } = await run({ contentKind: kind, text: BODY, title: 'Testimonio de Juan Pérez.mp3' }, ['Juan Pérez'])
    expect(result).not.toHaveProperty('redactedTitle')
    expect(seen.some((t) => t.includes('.mp3'))).toBe(false)
  })

  it('a hold still titles the document (an approval ingests it later)', async () => {
    // Verify finds the name again → hold at verify.
    const d: PersonDetector = {
      name: 'stubborn',
      async detect({ text }) {
        return text.includes('escuela') && !text.includes('Juan') ? [{ text: 'la escuela', type: 'persona' }] : text.includes('Juan Pérez') ? [{ text: 'Juan Pérez', type: 'persona' }] : []
      },
    }
    const result = await runAnonymisationGate(
      { contentKind: 'documento', text: BODY, title: 'Entrevista a Juan Pérez.pdf' },
      { detector: d, verifyRounds: 1 },
    )
    expect(result.status).toBe('hold')
    expect(result.redactedTitle).toBe('Entrevista a [Persona A].pdf')
  })
})
