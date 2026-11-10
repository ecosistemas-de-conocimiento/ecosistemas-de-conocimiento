/**
 * 🔴 A switch whose read throws is OFF (owner decision 2026-11-07: the default
 * anonymises everything). `featuresFor` already swallows a database error; this
 * pins the second line of defence in `effectiveSwitches` itself.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./features', () => ({
  featureEnabled: vi.fn(async () => {
    throw new Error('unexpected')
  }),
}))

import { documentoGateOptions, effectiveSwitches } from './publicFigures'

describe('effectiveSwitches — a throwing read', () => {
  it('reads as off, from the ecosistema', async () => {
    expect(await effectiveSwitches({ findByID: vi.fn() } as never, 1, { contentKind: 'documento' })).toEqual({
      keepDocumentAuthor: { value: false, origin: 'ecosistema' },
      keepCitedAuthors: { value: false, origin: 'ecosistema' },
      keepPublicFigures: { value: false, origin: 'ecosistema' },
    })
  })

  it('keeps no author and no cited name', async () => {
    const find = vi.fn(async () => ({ docs: [{ personName: 'Ana Ruiz' }] }))
    const out = await documentoGateOptions({ findByID: vi.fn(), find } as never, 1, { contentKind: 'testimonio', uploadedBy: 7 })
    expect(out.authors).toEqual([])
    expect(out.keepCitedAuthors).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })
})
