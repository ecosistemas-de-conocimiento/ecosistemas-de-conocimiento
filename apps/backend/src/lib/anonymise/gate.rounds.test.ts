/**
 * VERIFY ROUNDS. The REAL detector through the REAL gate; the only fake is
 * `fetch` under a real `AIClient`: no network, no spend.
 *
 * Every text here is far below one chunk, so detector call `n` is pass `n`:
 * call 1 is stage 3 (content), calls 2..4 are verify rounds 1..3.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'
import type { GateReport } from './types'

type Hallazgo = { texto: string; tipo: string; identifica?: boolean }

function syncOk(text: string): Response {
  return new Response(
    JSON.stringify({ text, modelUsed: 'fake', provider: 'fake', costUsd: 0, traceId: 't' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/**
 * A model scripted per pass. `script[n-1]` answers call `n`; a function sees
 * the text it was sent. Past the end of the script it finds nothing.
 */
function scripted(script: Array<Hallazgo[] | ((text: string) => Hallazgo[]) | 'error'>) {
  const prompts: string[] = []
  const systems: string[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      unit: { input: { userPrompt: string }; systemPrompt?: string }
    }
    const prompt = body.unit.input.userPrompt
    prompts.push(prompt)
    systems.push(body.unit.systemPrompt ?? '')
    const step = script[prompts.length - 1] ?? []
    if (step === 'error') {
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const hallazgos = typeof step === 'function' ? step(prompt) : step
    return syncOk(JSON.stringify({ hallazgos }))
  }) as unknown as typeof fetch
  const client = new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl })
  return {
    detector: aiServiceDetector({ client: client as unknown as SyncGenerator, sleep: async () => {} }),
    prompts,
    systems,
  }
}

const persona = (texto: string): Hallazgo => ({ texto, tipo: 'persona' })
const lugar = (texto: string): Hallazgo => ({ texto, tipo: 'lugar' })

const gate = (text: string, detector: ReturnType<typeof scripted>['detector']) =>
  runAnonymisationGate({ contentKind: 'testimonio', text }, { detector })

const verifyStages = (r: { report: GateReport }) =>
  r.report.stages.filter((s) => s.stage === 'verify')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runAnonymisationGate — verify rounds', () => {
  it('🔴 round 2 catches a leftover, redacts it, round 3 is clean → ready', async () => {
    const text = 'Ana vive en Jiutepec. Su vecino es Ricardo Peña.'
    const { detector, prompts } = scripted([
      [persona('Ana')],
      [lugar('Jiutepec')],
      [persona('Ricardo Peña')],
      [],
    ])
    const result = await gate(text, detector)

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('[Persona A] vive en [Domicilio A]. Su vecino es [Persona B].')
    expect(prompts).toHaveLength(4)

    // 🔴 What each round caught is on the report, as counts only.
    const rounds = verifyStages(result)
    expect(rounds.map((s) => s.round)).toEqual([1, 2, 3])
    expect(rounds[0]?.removed).toEqual([{ label: 'lugar', count: 1 }])
    expect(rounds[1]?.removed).toEqual([{ label: 'persona', count: 1 }])
    expect(rounds[2]?.removed).toEqual([])
    expect(JSON.stringify(result.report)).not.toMatch(/Jiutepec|Ricardo|Ana /)
  })

  it('stops at the first clean round', async () => {
    const { detector, prompts } = scripted([[persona('Ana')], []])
    const result = await gate('Ana llegó temprano.', detector)
    expect(result.status).toBe('ready')
    expect(prompts).toHaveLength(2)
    if (result.status !== 'ready') return
    expect(verifyStages(result)).toHaveLength(1)
  })

  it('🔴 leftovers after round 3 → held, and no fourth verify call is made', async () => {
    const text = 'Ana conoce a Berta, Berta a Carmen, Carmen a Dora. Dora es de Tlapa.'
    const { detector, prompts } = scripted([
      [persona('Ana')],
      [persona('Berta')],
      [persona('Carmen')],
      [persona('Dora')],
      [persona('nunca')],
    ])
    const result = await gate(text, detector)

    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(prompts).toHaveLength(4)
    expect(result.reason).toContain('3')
    expect(result.reason).not.toContain('Dora')
    // Survivors point at what the LAST round still saw, in the text it saw.
    const held = result.redactedText ?? ''
    expect(result.survivors?.map((s) => held.slice(s.start, s.end))).toEqual(['Dora', 'Dora'])
    expect(verifyStages(result)).toHaveLength(3)
  })

  it('the round limit comes from ANONYMISE_VERIFY_ROUNDS', async () => {
    vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '1')
    const { detector, prompts } = scripted([[persona('Ana')], [persona('Berta')]])
    const result = await gate('Ana y Berta.', detector)
    expect(result.status).toBe('hold')
    expect(prompts).toHaveLength(2)
  })

  it('🔴 a detector error in round 2 → held', async () => {
    const { detector } = scripted([[persona('Ana')], [persona('Berta')], 'error'])
    const result = await gate('Ana y Berta.', detector)
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(result.reason).toContain('transporte')
    // The text round 1 produced travels with the refusal for the reviewer.
    expect(result.redactedText).toBe('[Persona A] y [Persona B].')
    expect(verifyStages(result)).toHaveLength(1)
  })
})

describe('runAnonymisationGate — 🔴 placeholders stay consistent across rounds', () => {
  it('a variant spelling caught in a later round gets the SAME label', async () => {
    const text = 'Lucía Méndez llegó. Luego vino Teodulfo. Al final lucia mendez se fue.'
    const { detector } = scripted([
      [persona('Lucía Méndez')],
      [persona('lucia mendez')],
      [persona('Teodulfo')],
      [],
    ])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(
      '[Persona A] llegó. Luego vino [Persona B]. Al final [Persona A] se fue.',
    )
    expect(result.report.pseudonyms).toBe(2)
  })

  it('a surname glued to a placeholder is absorbed into THAT placeholder', async () => {
    const text = 'Don Fernando López nos ayudó. Fernando volvió.'
    const { detector } = scripted([[persona('Fernando')], [persona('[Persona A] López')], []])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // "Don" stays: a generic word beside a placeholder is the model's call.
    expect(result.redactedText).toBe('Don [Persona A] nos ayudó. [Persona A] volvió.')
    expect(result.report.pseudonyms).toBe(1)
  })

  it('🔴 "[Persona A] López" on the LAST round holds', async () => {
    vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '1')
    const { detector } = scripted([[persona('Fernando')], [persona('[Persona A] López')]])
    const result = await gate('Fernando López nos ayudó.', detector)
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    expect(result.redactedText).toBe('[Persona A] López nos ayudó.')
  })

  it('a place glued to a place placeholder joins it', async () => {
    const text = 'Nací en San Juan Mixtepec, Oaxaca.'
    const { detector } = scripted([[lugar('San Juan Mixtepec')], [lugar('[Domicilio A], Oaxaca')], []])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Nací en [Domicilio A].')
  })

  it('🔴 a verify finding that is only a placeholder, or part of one, rewrites nothing', async () => {
    const text = 'Vivo en Tlapa con Ana.'
    const { detector, prompts } = scripted([
      [lugar('Tlapa'), persona('Ana')],
      [lugar('[Domicilio A]'), lugar('Domicilio A'), persona('Persona'), persona('A]')],
    ])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Vivo en [Domicilio A] con [Persona A].')
    expect(prompts).toHaveLength(2)
  })

  it('🔴 a finding that straddles a placeholder redacts only what lies outside it', async () => {
    const text = 'Vivo en Tlapa, Ana lo sabe.'
    const { detector } = scripted([[lugar('Tlapa')], [persona('Domicilio A], Ana')], []])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Vivo en [Domicilio A], [Persona A] lo sabe.')
    expect(result.redactedText).not.toContain('[[')
  })
})

describe('runAnonymisationGate — 🔴 a bare title identifies nobody', () => {
  it('"el doctor dijo" passes when the model marks it as not identifying', async () => {
    const text = 'El doctor dijo que la maestra llegó tarde.'
    const notId = (texto: string): Hallazgo => ({ texto, tipo: 'persona', identifica: false })
    const { detector } = scripted([
      [notId('El doctor')],
      [notId('El doctor'), notId('la maestra')],
    ])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe(text)
  })

  it('the detector prompt tells the model a bare title is not a finding', async () => {
    const { DETECT_SYSTEM_PROMPT } = await import('./detector')
    expect(DETECT_SYSTEM_PROMPT).toContain('el doctor dijo')
    expect(DETECT_SYSTEM_PROMPT).toContain('"identifica"')
  })

  it('⚠ fail-closed: a title the model does NOT mark as harmless is redacted like a name', async () => {
    const { detector } = scripted([[], [persona('Don')], []])
    const result = await gate('Llegó Don y se sentó.', detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).not.toMatch(/\bDon\b/)
  })
})

describe('runAnonymisationGate — 🔴 the model owns span boundaries (no word lists)', () => {
  it('a titled span and the bare name get ONE label, and the title goes with it', async () => {
    const text = 'Don Fernando Vázquez nos prestaba su camioneta. Después Fernando Vázquez se fue.'
    const { detector } = scripted([[persona('Don Fernando Vázquez'), persona('Fernando Vázquez')], []])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('[Persona A] nos prestaba su camioneta. Después [Persona A] se fue.')
    expect(result.report.pseudonyms).toBe(1)
  })

  it('⚠ two people who share only a first name are NOT merged', async () => {
    const { detector } = scripted([[persona('Ana López'), persona('Ana')], []])
    const result = await gate('Ana López habló. Luego Ana se fue.', detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.report.pseudonyms).toBe(2)
  })

  it('🔴 a span in the wrong case or without accents still redacts the text’s own spelling', async () => {
    // Measured 2026-10-17: "la maestra Nicasia Olvera" for "La maestra Nicasia Olvera".
    const text = 'La maestra Nicasia Olvera llegó. Luego habló Teódulo Ruíz.'
    const { detector } = scripted([
      [persona('la maestra Nicasia Olvera'), persona('teodulo ruiz')],
      [],
    ])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('[Persona A] llegó. Luego habló [Persona B].')
  })

  it('a place span with its generic head noun leaves no "colonia [Domicilio A]"', async () => {
    const text = 'Vivíamos en la colonia Las Flores, junto a la tortillería de Doña Lupe.'
    const { detector } = scripted([
      [lugar('colonia Las Flores'), lugar('tortillería de Doña Lupe')],
      [],
    ])
    const result = await gate(text, detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // Labels follow replacement order, longest span first.
    expect(result.redactedText).toBe('Vivíamos en la [Domicilio B], junto a la [Domicilio A].')
  })

  it('a generic word beside a placeholder passes when verify does not report it', async () => {
    const { detector } = scripted([[persona('Fernando')], []])
    const result = await gate('Don Fernando llegó.', detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('Don [Persona A] llegó.')
  })

  it('…and is absorbed into the placeholder when verify reports it anyway', async () => {
    const { detector } = scripted([
      [persona('Fernando'), lugar('Las Flores')],
      [persona('Don [Persona A]'), lugar('colonia [Domicilio A]')],
      [],
    ])
    const result = await gate('Don Fernando vive en la colonia Las Flores.', detector)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.redactedText).toBe('[Persona A] vive en la [Domicilio A].')
  })

  it('detect and verify send the SAME prompt, which says what is not a leftover', async () => {
    // Measured 2026-10-17: a verify-only addendum made the model miss a full name.
    const { DETECT_SYSTEM_PROMPT } = await import('./detector')
    const { detector, systems } = scripted([[persona('Ana')], []])
    await gate('Ana llegó.', detector)
    expect(systems).toEqual([DETECT_SYSTEM_PROMPT, DETECT_SYSTEM_PROMPT])
    expect(DETECT_SYSTEM_PROMPT).toContain('"[Persona A] López"')
    expect(DETECT_SYSTEM_PROMPT).toContain('"colonia [Domicilio L]"')
  })
})
