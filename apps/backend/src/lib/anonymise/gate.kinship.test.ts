/**
 * OWNER'S RULING, 2026-10-21: AN UNNAMED RELATIVE IS A PERSON.
 *
 * "mi mamá", "mi abuelo", "la esposa de mi primo" become `[Persona X]`. A named
 * relative keeps today's behaviour: only the name goes ("mi hermana Lucía" →
 * "mi hermana [Persona A]").
 *
 * 🔴 No word list in code (owner, 2026-10-17). The prompt asks for it; the
 * model decides. These tests fake the model at the fetch boundary, under the
 * REAL `AIClient`, the REAL `aiServiceDetector` and the REAL gate.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiServiceDetector, DETECT_SYSTEM_PROMPT, type SyncGenerator } from './detector'
import { ANONYMISE_VERIFY_ROUNDS_VAR, runAnonymisationGate } from './gate'

type H = { texto: string; tipo: string; identifica?: boolean }

const persona = (texto: string, identifica = true): H => ({ texto, tipo: 'persona', identifica })

/** Call 1 = stage 3, call 2.. = verify. One chunk per call at these sizes. */
function scriptedClient(perCall: H[][]): SyncGenerator {
  let n = 0
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        text: JSON.stringify({ hallazgos: perCall[n++] ?? [] }),
        modelUsed: 'fake',
        provider: 'fake',
        costUsd: 0,
        traceId: 't',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
  const client = new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl })
  return client as unknown as SyncGenerator
}

function gate(text: string, perCall: H[][], verifyRounds?: number) {
  return runAnonymisationGate(
    { contentKind: 'testimonio', text },
    {
      detector: aiServiceDetector({ client: scriptedClient(perCall) }),
      ...(verifyRounds !== undefined ? { verifyRounds } : {}),
    },
  )
}

beforeEach(() => {
  vi.stubEnv(ANONYMISE_VERIFY_ROUNDS_VAR, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the prompt asks for unnamed relatives', () => {
  const flat = DETECT_SYSTEM_PROMPT.replace(/\s+/g, ' ')

  it('asks for a kinship reference without a name as an identifying persona', () => {
    expect(flat).toMatch(
      /parentesco que señala a una persona concreta sin nombrarla es un hallazgo "tipo": "persona" con "identifica": true/,
    )
    expect(flat).toContain('en "mi mamá me llevó" el hallazgo es "mi mamá"')
    // The whole span, possessive included, so "su mamá" is not taken with it.
    expect(flat).toContain('"la esposa de mi primo"')
  })

  it('still asks only for the NAME of a named relative', () => {
    expect(flat).toContain('en "mi hermana Lucía" el hallazgo es "Lucía"')
    expect(flat).toContain('El parentesco se queda fuera: solo el nombre.')
  })

  it('lists a kinship word beside a person placeholder as NOT a finding', () => {
    expect(flat).toMatch(/No es un hallazgo:.*"mi hermana \[Persona A\]".*Domicilios/)
  })
})

describe('stage 3 redacts an unnamed relative', () => {
  it('"mi mamá" → "[Persona A]", every mention, ONE label', async () => {
    const r = await gate('Mi mamá me llevó al río. Después mi mamá lloró.', [
      [persona('mi mamá')],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] me llevó al río. Después [Persona A] lloró.')
    expect(r.report.pseudonyms).toBe(1)
  })

  it('two relatives get two labels, and repeat mentions keep theirs', async () => {
    const r = await gate('Mi abuelo sembraba. Mi tío no. Mi abuelo murió en mayo; mi tío vino.', [
      [persona('Mi abuelo'), persona('Mi tío')],
      [],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe(
      '[Persona A] sembraba. [Persona B] no. [Persona A] murió en mayo; [Persona B] vino.',
    )
    expect(r.report.pseudonyms).toBe(2)
  })

  it('"mi mamá" does not take "su mamá" with it', async () => {
    const r = await gate('Mi mamá y su mamá eran amigas.', [[persona('Mi mamá')], []])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('[Persona A] y su mamá eran amigas.')
  })
})

describe('verify and an unnamed relative stage 3 missed', () => {
  const text = 'Mi tío Chencho y mi mamá fueron a la junta.'

  it('🔴 marked identifying: holds on the default single round', async () => {
    const r = await gate(text, [[persona('Chencho')], [persona('mi mamá', true)]])
    expect(r.status).toBe('hold')
    if (r.status !== 'hold') return
    expect(r.stage).toBe('verify')
    expect(r.redactedText).toBe('Mi tío [Persona A] y mi mamá fueron a la junta.')
    expect(r.survivors).toHaveLength(1)
  })

  it('marked identifying, two rounds: redacted with a new label, ready', async () => {
    const r = await gate(text, [[persona('Chencho')], [persona('mi mamá', true)], []], 2)
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Mi tío [Persona A] y [Persona B] fueron a la junta.')
  })

  // ⚠ ACCEPTED RISK, owner's Q4: a lower-case, multi-word finding verify marks
  // non-identifying passes as a bare title. The prompt asks for `true`.
  it('marked NON-identifying: passes as a bare title (Q4)', async () => {
    const r = await gate(text, [[persona('Chencho')], [persona('mi mamá', false)]])
    expect(r.status).toBe('ready')
  })
})

describe('a named relative is unchanged', () => {
  it('"mi hermana Lucía" → "mi hermana [Persona A]", ready', async () => {
    const r = await gate('Mi hermana Lucía cocinaba. Lucía cantaba.', [
      [persona('Lucía')],
      [persona('Mi hermana [Persona A]', false)],
    ])
    expect(r.status).toBe('ready')
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('Mi hermana [Persona A] cocinaba. [Persona A] cantaba.')
    expect(r.report.pseudonyms).toBe(1)
  })
})
