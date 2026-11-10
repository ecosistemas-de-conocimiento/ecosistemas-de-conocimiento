/**
 * I-06 (audit 2026-11-10): `/api/evals/gate` must run the gate under the SAME
 * switches and authors as production. Both build the input with
 * `documentGateInput`; this pins that the eval passes every field through.
 */

import { describe, expect, it, vi } from 'vitest'

const OPTIONS = {
  keepPublicFigures: true,
  roster: ['Beto Díaz'],
  authors: ['Ana Ruiz'],
  keepDocumentAuthor: true,
  keepCitedAuthors: true,
}
const gateSpy = vi.fn(async (_input: Record<string, unknown>) => ({ status: 'ready', redactedText: 'x', report: { model: 'm' } }))
vi.mock('@/lib/publicFigures', () => ({ documentoGateOptions: async () => OPTIONS }))
vi.mock('@/lib/anonymise', () => ({
  runAnonymisationGate: (input: Record<string, unknown>) => gateSpy(input),
  aiServiceDetector: () => ({ name: 'fake' }),
}))

const { productionGate } = await import('./evals')
const { documentGateInput } = await import('@/lib/anonymise/gateInput')

describe('productionGate — 🔴 the eval gate is the production gate (I-06)', () => {
  it.each(['documento', 'testimonio'] as const)('%s: keepCitedAuthors, authors, keepPublicFigures and roster all reach the gate', async (kind) => {
    gateSpy.mockClear()
    const text = 'Ulloa (2020) dice que Ana Ruiz llegó.'
    await productionGate({ payload: {} } as never, { organizationId: 3, contentKind: kind, text })
    const input = gateSpy.mock.calls[0]![0]
    expect(input).toEqual(documentGateInput(kind, text, OPTIONS))
    expect(input).toMatchObject({
      contentKind: kind,
      keepCitedAuthors: true,
      authors: ['Ana Ruiz'],
      keepPublicFigures: true,
      roster: ['Beto Díaz'],
    })
  })
})

describe('documentGateInput', () => {
  it('an unknown kind is gated as a testimonio, and absent switches are off', () => {
    expect(documentGateInput('raro', 't', {})).toEqual({
      contentKind: 'testimonio',
      text: 't',
      roster: [],
      keepPublicFigures: false,
      authors: [],
      keepCitedAuthors: false,
    })
  })
})
