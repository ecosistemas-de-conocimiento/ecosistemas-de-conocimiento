/**
 * D1 (navegador 2026-11-10, doc 1439 on dev): a documento with two invented
 * names, in an ecosystem of ~27 members, came out "Nombres reemplazados: 29"
 * and `[Persona AB]`, `[Persona AC]`. The roster must label only the members
 * that are actually in the text.
 */

import { describe, expect, it } from 'vitest'

import { runAnonymisationGate } from './gate'
import type { DetectorFinding, GateContentKind, PersonDetector } from './types'

const FIRST = ['Abigail', 'Bernardo', 'Celia', 'Damián', 'Elvira', 'Fabián', 'Gilda', 'Héctor', 'Irene', 'Joaquín',
  'Karla', 'Leonel', 'Mireya', 'Néstor', 'Ofelia', 'Porfirio', 'Quintina', 'Ramiro', 'Susana', 'Tadeo', 'Úrsula',
  'Valente', 'Wendy', 'Ximena', 'Yolanda', 'Zacarías', 'Amparo']
const LAST = ['Arriaga', 'Barrón', 'Cuéllar', 'Duarte', 'Escobedo', 'Fajardo', 'Galindo', 'Huerta', 'Ibarrola', 'Jasso',
  'Kuri', 'Ledesma', 'Mancera', 'Nájera', 'Ochoa', 'Peralta', 'Quiroz', 'Robles', 'Saucedo', 'Tovar', 'Uribe',
  'Villegas', 'Werner', 'Xicoténcatl', 'Yáñez', 'Zepeda', 'Alcaraz']
const ROSTER = FIRST.map((f, i) => `${f} ${LAST[i]}`)

function staticDetector(stage3: string[]): PersonDetector {
  let call = 0
  return {
    name: 'static',
    async detect({ text }): Promise<DetectorFinding[]> {
      const list = call++ === 0 ? stage3 : []
      return list.filter((t) => text.includes(t)).map((t) => ({ text: t, type: 'persona' as const }))
    },
  }
}

async function run(text: string, stage3: string[], contentKind: GateContentKind = 'documento') {
  const result = await runAnonymisationGate(
    { contentKind, text, roster: ROSTER },
    { detector: staticDetector(stage3), verifyRounds: 1 },
  )
  expect(result.status).toBe('ready')
  return result
}

const TEXT = '# Nota nav-7\n\nRosalba Quintanar Ibarra habló con Ernesto Valdivia Lugo sobre los letreros del mercado.'
const PEOPLE = ['Rosalba Quintanar Ibarra', 'Ernesto Valdivia Lugo']

describe.each(['documento', 'testimonio', 'conversacion'] as const)('%s: the roster labels only who is in the text', (kind) => {
  it('two invented names, no member in the text: 2 pseudonyms, [Persona A] and [Persona B]', async () => {
    const r = await run(TEXT, PEOPLE, kind)
    if (r.status !== 'ready') return
    expect(r.redactedText).toBe('# Nota nav-7\n\n[Persona A] habló con [Persona B] sobre los letreros del mercado.')
    expect(r.report.pseudonyms).toBe(2)
  })

  it('a member who IS in the text is still redacted, and counted once', async () => {
    const text = `${TEXT} Después llegó Celia Cuéllar, y Celia se quedó.`
    const r = await run(text, PEOPLE, kind)
    if (r.status !== 'ready') return
    expect(r.redactedText).not.toMatch(/Celia|Cuéllar/)
    expect(r.report.pseudonyms).toBe(3)
    expect(new Set(r.redactedText.match(/\[Persona [A-Z]+\]/g))).toEqual(new Set(['[Persona A]', '[Persona B]', '[Persona C]']))
  })
})

it('documento: a member\'s bare first name (Q13 A) is still redacted even when the full name is absent', async () => {
  const r = await run('Celia llegó tarde. Rosalba Quintanar Ibarra la esperaba.', ['Rosalba Quintanar Ibarra'])
  if (r.status !== 'ready') return
  expect(r.redactedText).not.toMatch(/Celia/)
  expect(r.report.pseudonyms).toBe(2)
  expect(r.redactedText).toMatch(/^\[Persona [AB]\] llegó tarde\. \[Persona [AB]\] la esperaba\.$/)
})

it('documento: a bare first name two absent members share takes ONE label, not three', async () => {
  const result = await runAnonymisationGate(
    { contentKind: 'documento', text: 'María llegó tarde. Rosalba Quintanar Ibarra la esperaba.', roster: [...ROSTER, 'María López', 'María Pérez'] },
    { detector: staticDetector(['Rosalba Quintanar Ibarra']), verifyRounds: 1 },
  )
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') return
  expect(result.redactedText).not.toMatch(/María/)
  expect(result.report.pseudonyms).toBe(2)
})

it('a stage-1 byline label is not re-matched by the roster', async () => {
  const result = await runAnonymisationGate(
    { contentKind: 'documento', text: 'Autor: Celia Cuéllar\n\nCelia Cuéllar escribió esto.', roster: ROSTER },
    { detector: staticDetector([]), verifyRounds: 1 },
  )
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') return
  expect(result.redactedText).not.toMatch(/Celia|Cuéllar/)
  expect(result.report.pseudonyms).toBe(1)
})
