/**
 * The detector's half of KEEP PUBLIC FIGURES (owner rulings 2026-10-27): the
 * prompt asks for `ambito` + `motivo` only when told to, and the parse is
 * fail-closed — anything but an explicit `publica` with a reason is private.
 * Synthetic text only.
 */

import { describe, expect, it } from 'vitest'

import {
  aiServiceDetector,
  DETECT_PUBLIC_ADDENDUM,
  DETECT_SYSTEM_PROMPT,
  DetectorFailure,
  parseFindings,
  type SyncGenerator,
} from './detector'

const TEXT = 'La diputada Celia Ontiveros habló con Tadeo Villaseñor.'
const parse = (...hallazgos: object[]) => parseFindings(JSON.stringify({ hallazgos }), TEXT)

describe('parseFindings — ambito and motivo', () => {
  it('publica + motivo → public, motivo trimmed', () => {
    const [f] = parse({ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'publica', motivo: '  diputada ' })
    expect(f?.public).toEqual({ motivo: 'diputada' })
  })

  it('"Pública" (case, accent) counts as publica', () => {
    const [f] = parse({ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'Pública', motivo: 'diputada' })
    expect(f?.public).toEqual({ motivo: 'diputada' })
  })

  it.each([
    { ambito: 'privada', motivo: 'vecino' },
    { motivo: 'diputada' },
    { ambito: 'publica' },
    { ambito: 'publica', motivo: '' },
    { ambito: 'publica', motivo: null },
    { ambito: true, motivo: 'diputada' },
    { ambito: 'pública?', motivo: 'quizá' },
  ])('🔴 %o → private (no `public` key)', (extra) => {
    const [f] = parse({ texto: 'Celia Ontiveros', tipo: 'persona', ...extra })
    expect(f).toBeDefined()
    expect(f).not.toHaveProperty('public')
  })

  it('🔴 only a persona can be public', () => {
    const [f] = parse({ texto: 'Celia Ontiveros', tipo: 'otro', ambito: 'publica', motivo: 'x' })
    expect(f).not.toHaveProperty('public')
  })

  it('a long motivo is cut to 200 characters', () => {
    const [f] = parse({ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'publica', motivo: 'x'.repeat(500) })
    expect(f?.public?.motivo).toHaveLength(200)
  })

  it('🔴 the masked-token guard still throws on a "publica" finding', () => {
    expect(() => parse({ texto: '[NOMBRE]', tipo: 'persona', ambito: 'publica', motivo: 'senador' })).toThrow(DetectorFailure)
  })
})

function recorder(answers: string[]): SyncGenerator & { prompts: string[] } {
  const prompts: string[] = []
  let n = 0
  return {
    prompts,
    generate: {
      async sync(req) {
        prompts.push(req.unit.systemPrompt ?? '')
        return { text: answers[n++] ?? '{"hallazgos":[]}' }
      },
    },
  }
}

describe('aiServiceDetector — classifyPublic', () => {
  it('without it the system prompt is exactly the old one', async () => {
    const client = recorder([])
    await aiServiceDetector({ client }).detect({ text: TEXT, contentKind: 'documento' })
    expect(client.prompts).toEqual([DETECT_SYSTEM_PROMPT])
  })

  it('with it the addendum is appended', async () => {
    const client = recorder([])
    await aiServiceDetector({ client }).detect({ text: TEXT, contentKind: 'documento', classifyPublic: true })
    expect(client.prompts).toEqual([`${DETECT_SYSTEM_PROMPT}\n${DETECT_PUBLIC_ADDENDUM}`])
    expect(DETECT_PUBLIC_ADDENDUM).toMatch(/Si dudas, pon "privada"/)
  })

  it('🔴 one chunk saying privada wins over another saying publica', async () => {
    const text = `${TEXT}\n\n${TEXT}`
    const pub = JSON.stringify({ hallazgos: [{ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'publica', motivo: 'diputada' }] })
    const priv = JSON.stringify({ hallazgos: [{ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'privada', motivo: 'x' }] })
    for (const answers of [[pub, priv], [priv, pub]]) {
      const client = recorder(answers)
      const found = await aiServiceDetector({ client, chunkWords: 8, concurrency: 1 }).detect({
        text,
        contentKind: 'documento',
        classifyPublic: true,
      })
      expect(found).toHaveLength(1)
      expect(found[0]).not.toHaveProperty('public')
    }
  })

  it('two chunks both saying publica stay public', async () => {
    const text = `${TEXT}\n\n${TEXT}`
    const pub = JSON.stringify({ hallazgos: [{ texto: 'Celia Ontiveros', tipo: 'persona', ambito: 'publica', motivo: 'diputada' }] })
    const client = recorder([pub, pub])
    const found = await aiServiceDetector({ client, chunkWords: 8, concurrency: 1 }).detect({
      text,
      contentKind: 'documento',
      classifyPublic: true,
    })
    expect(found[0]?.public).toEqual({ motivo: 'diputada' })
  })
})
