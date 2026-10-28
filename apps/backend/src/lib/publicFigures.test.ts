/**
 * Which gate options a document gets: the per-document override wins over the
 * ecosistema's `keepPublicFigures`; only a `documento` gets the roster and the
 * option; a failed read falls back to today's behaviour (option off).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const roster = vi.fn()
vi.mock('./conversationIngest', () => ({ rosterForOrganization: roster }))

import { invalidateFeatures } from './features'
import { authorsLog, documentoGateOptions, publicFiguresLog } from './publicFigures'

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
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: [] })
    expect(roster).not.toHaveBeenCalled()
  })

  it('🔴 a roster read that fails → today\'s behaviour: option off, no roster', async () => {
    roster.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await documentoGateOptions(payloadWith({ keepPublicFigures: true }), 1, { contentKind: 'documento' })
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: [] })
  })
})

describe('documentoGateOptions — R60 authors (the uploader)', () => {
  const payloadFor = (user: unknown, memberships: unknown[] | Error) =>
    ({
      findByID: vi.fn(async ({ collection }: { collection: string }) =>
        collection === 'users' ? user : { features: { keepPublicFigures: false } },
      ),
      find: vi.fn(async () => {
        if (memberships instanceof Error) throw memberships
        return { docs: memberships }
      }),
    }) as never

  it('takes the uploader\'s display name and their roster entry here', async () => {
    const payload = payloadFor({ displayName: 'Ana Ruiz' }, [{ personName: 'Ana María Ruiz' }])
    const out = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(out.authors).toEqual(['Ana Ruiz', 'Ana María Ruiz'])
    const find = (payload as unknown as { find: ReturnType<typeof vi.fn> }).find
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      collection: 'memberships',
      where: { and: [{ user: { equals: 7 } }, { organization: { equals: 1 } }] },
    })
  })

  it('reads a populated uploadedBy too', async () => {
    const out = await documentoGateOptions(payloadFor({ displayName: 'Ana Ruiz' }, []), 1, {
      contentKind: 'documento',
      uploadedBy: { id: 7 },
    })
    expect(out.authors).toEqual(['Ana Ruiz'])
  })

  it('🔴 an unreadable uploader keeps no author, and nothing else changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await documentoGateOptions(payloadFor({ displayName: 'Ana Ruiz' }, new Error('db down')), 1, {
      contentKind: 'documento',
      uploadedBy: 7,
    })
    expect(out.authors).toEqual([])
    expect(out.roster).toEqual(['Itzel Barragán'])
  })

  it('no uploader, no author', async () => {
    const out = await documentoGateOptions(payloadFor(null, []), 1, { contentKind: 'documento' })
    expect(out.authors).toEqual([])
  })
})

describe('authorsLog', () => {
  it('stamps each kept author with the model and the time; null when none', () => {
    const at = new Date('2026-10-28T12:00:00Z')
    expect(authorsLog(['Ana Ruiz'], 'm1', at)).toEqual([{ name: 'Ana Ruiz', model: 'm1', at: '2026-10-28T12:00:00.000Z' }])
    expect(authorsLog([], 'm1')).toBeNull()
    expect(authorsLog(undefined, 'm1')).toBeNull()
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
