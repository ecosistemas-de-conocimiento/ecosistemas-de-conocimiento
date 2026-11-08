/**
 * 🔴 THE DEFAULT ANONYMISES EVERYTHING (owner decision 2026-11-07). With no
 * switch on — an ecosistema nobody touched, a row with no override — a gated
 * documento or testimonio shows neither its uploader's name nor a cited
 * author, through `documentoGateOptions` and the whole gate. Each switch on
 * brings back only its own names. Static detectors only; synthetic names.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../conversationIngest', () => ({ rosterForOrganization: vi.fn(async () => []) }))

import { invalidateFeatures } from '../features'
import { documentoGateOptions } from '../publicFigures'
import { staticDetector } from './detector'
import { runAnonymisationGate } from './gate'
import type { GateContentKind } from './types'

const TEXT = 'Autora: Ana María Ruiz\n\nAna María Ruiz retoma lo que mostró López (2020) con Pedro Gómez.'
/** The model calls the cited author public; the default must hide them anyway. */
const detector = () =>
  staticDetector([
    { text: 'Ana María Ruiz', type: 'persona' },
    { text: 'López', type: 'persona', public: { motivo: 'autor citado' } },
    { text: 'Pedro Gómez', type: 'persona' },
  ])

/** An ecosistema with these features, whose uploader 7 is "Ana María Ruiz". */
const payloadFor = (features: unknown) =>
  ({
    findByID: vi.fn(async () => ({ features })),
    find: vi.fn(async () => ({ docs: [{ personName: 'Ana María Ruiz' }] })),
  }) as never

async function gated(contentKind: GateContentKind, features: unknown, row: Record<string, unknown> = {}): Promise<string> {
  const options = await documentoGateOptions(payloadFor(features), 1, { contentKind, uploadedBy: 7, ...row })
  const result = await runAnonymisationGate(
    { contentKind, text: TEXT, roster: options.roster, authors: options.authors, keepCitedAuthors: options.keepCitedAuthors },
    { detector: detector() },
  )
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.redactedText : ''
}

const absent = (text: string, words: string[]) => {
  for (const w of words) expect(text, `"${w}" left in: ${text}`).not.toMatch(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'u'))
}

beforeEach(() => invalidateFeatures())

describe.each(['documento', 'testimonio'] as const)('%s', (kind) => {
  it('🔴 default anonymises all: the uploader, the cited author and everyone else', async () => {
    absent(await gated(kind, null), ['Ana', 'María', 'Ruiz', 'López', 'Pedro', 'Gómez'])
  })

  it('keepDocumentAuthor on: the uploader whole, nothing else', async () => {
    const out = await gated(kind, { keepDocumentAuthor: true })
    expect(out).toContain('Autora: Ana María Ruiz\n\nAna María Ruiz retoma')
    absent(out, ['López', 'Pedro', 'Gómez'])
  })

  it('keepCitedAuthors on: the citation, nothing else', async () => {
    const out = await gated(kind, { keepCitedAuthors: true })
    expect(out).toContain('López (2020)')
    absent(out, ['Ana', 'María', 'Ruiz', 'Pedro', 'Gómez'])
  })

  it('a document override of false wins over an ecosistema that says true', async () => {
    const out = await gated(kind, { keepDocumentAuthor: true, keepCitedAuthors: true }, { keepDocumentAuthor: false, keepCitedAuthors: false })
    absent(out, ['Ana', 'María', 'Ruiz', 'López', 'Pedro', 'Gómez'])
  })
})

it('🔴 conversacion: both switches on, everything still anonymised', async () => {
  absent(
    await gated('conversacion', { keepDocumentAuthor: true, keepCitedAuthors: true }, { keepDocumentAuthor: true, keepCitedAuthors: true }),
    ['Ana', 'María', 'Ruiz', 'López', 'Pedro', 'Gómez'],
  )
})
