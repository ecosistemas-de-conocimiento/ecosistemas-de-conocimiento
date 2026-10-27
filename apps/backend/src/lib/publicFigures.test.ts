/**
 * Which gate options a document gets: the per-document override wins over the
 * ecosistema's `keepPublicFigures`; only a `documento` gets the roster and the
 * option; a failed read falls back to today's behaviour (option off).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const roster = vi.fn()
vi.mock('./conversationIngest', () => ({ rosterForOrganization: roster }))

import { invalidateFeatures } from './features'
import { documentoGateOptions, publicFiguresLog } from './publicFigures'

const payloadWith = (features: unknown) => ({ findByID: vi.fn(async () => ({ features })) }) as never

beforeEach(() => {
  invalidateFeatures()
  roster.mockReset()
  roster.mockResolvedValue(['Itzel Barragán'])
})

describe('documentoGateOptions', () => {
  it.each([
    // [ecosistema setting, document override, expected]
    [true, null, true],
    [false, null, false],
    [true, false, false],
    [false, true, true],
    [undefined, undefined, false],
  ])('ecosistema %s, document %s → keep %s', async (eco, doc, expected) => {
    const out = await documentoGateOptions(payloadWith(eco === undefined ? null : { keepPublicFigures: eco }), 1, {
      contentKind: 'documento',
      keepPublicFigures: doc,
    })
    expect(out.keepPublicFigures).toBe(expected)
    expect(out.roster).toEqual(['Itzel Barragán'])
  })

  it.each(['testimonio', 'conversacion', undefined])('🔴 %s: never the option, never the roster', async (kind) => {
    const out = await documentoGateOptions(payloadWith({ keepPublicFigures: true }), 1, {
      contentKind: kind,
      keepPublicFigures: true,
    })
    expect(out).toEqual({ keepPublicFigures: false, roster: [] })
    expect(roster).not.toHaveBeenCalled()
  })

  it('🔴 a roster read that fails → today\'s behaviour: option off, no roster', async () => {
    roster.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await documentoGateOptions(payloadWith({ keepPublicFigures: true }), 1, { contentKind: 'documento' })
    expect(out).toEqual({ keepPublicFigures: false, roster: [] })
  })
})

describe('publicFiguresLog', () => {
  it('stamps each kept name with the model and the time', () => {
    const at = new Date('2026-10-27T12:00:00Z')
    expect(publicFiguresLog([{ name: 'Ramiro Saldaña', motivo: 'senador' }], 'm1', at)).toEqual([
      { name: 'Ramiro Saldaña', motivo: 'senador', model: 'm1', at: '2026-10-27T12:00:00.000Z' },
    ])
  })

  it('nothing kept, or option off → null', () => {
    expect(publicFiguresLog(undefined, 'm1')).toBeNull()
    expect(publicFiguresLog([], 'm1')).toBeNull()
  })
})
