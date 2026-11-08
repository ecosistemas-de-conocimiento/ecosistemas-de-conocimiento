/**
 * Which gate options a document gets: the per-document override wins over the
 * ecosistema's `keepPublicFigures`; only a `documento` gets the roster and the
 * option; a failed read falls back to today's behaviour (option off).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const roster = vi.fn()
vi.mock('./conversationIngest', () => ({ rosterForOrganization: roster }))

import { staticDetector } from './anonymise/detector'
import { runAnonymisationGate } from './anonymise/gate'
import { invalidateFeatures } from './features'
import { authorsLog, documentoGateOptions, effectiveSwitches, publicFiguresLog } from './publicFigures'

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
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: [], keepDocumentAuthor: false, keepCitedAuthors: false })
    expect(roster).not.toHaveBeenCalled()
  })

  it('🔴 a roster read that fails → today\'s behaviour: option off, no roster', async () => {
    roster.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await documentoGateOptions(payloadWith({ keepPublicFigures: true }), 1, { contentKind: 'documento' })
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: [], keepDocumentAuthor: false, keepCitedAuthors: false })
  })
})

describe('documentoGateOptions — the uploader, with keepDocumentAuthor on for the ecosistema', () => {
  /** An account whose own `displayName` is `displayName`, with these memberships. */
  const payloadFor = (displayName: string, memberships: unknown[] | Error) =>
    ({
      findByID: vi.fn(async ({ collection }: { collection: string }) =>
        collection === 'users' ? { displayName } : { features: { keepPublicFigures: false, keepDocumentAuthor: true } },
      ),
      find: vi.fn(async () => {
        if (memberships instanceof Error) throw memberships
        return { docs: memberships }
      }),
    }) as never

  const gated = async (text: string, authors: readonly string[]) => {
    const result = await runAnonymisationGate({ contentKind: 'documento', text, authors }, { detector: staticDetector([]) })
    expect(result.status).toBe('ready')
    return result.status === 'ready' ? result.redactedText : ''
  }

  it('takes the active membership\'s personName here, scoped to this ecosistema', async () => {
    const payload = payloadFor('Otro Nombre', [{ personName: 'Ana María Ruiz' }])
    const out = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(out.authors).toEqual(['Ana María Ruiz'])
    const find = (payload as unknown as { find: ReturnType<typeof vi.fn> }).find
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      collection: 'memberships',
      where: { and: [{ user: { equals: 7 } }, { organization: { equals: 1 } }, { isActive: { equals: true } }] },
    })
  })

  it('reads a populated uploadedBy too', async () => {
    const out = await documentoGateOptions(payloadFor('x', [{ personName: 'Ana Ruiz' }]), 1, {
      contentKind: 'documento',
      uploadedBy: { id: 7 },
    })
    expect(out.authors).toEqual(['Ana Ruiz'])
  })

  it('positive: an uploader whose personName is Ana Ruiz keeps "Autora: Ana Ruiz"', async () => {
    const { authors } = await documentoGateOptions(payloadFor('Ana Ruiz', [{ personName: 'Ana Ruiz' }]), 1, {
      contentKind: 'documento',
      uploadedBy: 7,
    })
    expect(await gated('Autora: Ana Ruiz\n\nAna Ruiz firmó.', authors)).toBe('Autora: Ana Ruiz\n\nAna Ruiz firmó.')
  })

  it('🔴 impersonation: displayName = "Carla Méndez" with no personName keeps nobody', async () => {
    const payload = payloadFor('Carla Méndez', [{ personName: '  ' }])
    const { authors } = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(authors).toEqual([])
    const out = await gated('Autora: Carla Méndez\n\nCarla Méndez reprobó.', authors)
    expect(out).not.toContain('Carla')
    expect(out).not.toContain('Méndez')
  })

  it('🔴 impersonation: displayName = "Carla Méndez" with another personName keeps only that one', async () => {
    const payload = payloadFor('Carla Méndez', [{ personName: 'Ana Ruiz' }])
    const { authors } = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(authors).toEqual(['Ana Ruiz'])
    const out = await gated('Autora: Carla Méndez\n\nCarla Méndez reprobó.', authors)
    expect(out).not.toContain('Carla')
    expect(out).not.toContain('Méndez')
    const reads = (payload as unknown as { findByID: ReturnType<typeof vi.fn> }).findByID.mock.calls
    expect(reads.some(([arg]) => (arg as { collection: string }).collection === 'users')).toBe(false)
  })

  it('🔴 no active membership keeps nobody', async () => {
    const out = await documentoGateOptions(payloadFor('Ana Ruiz', []), 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(out.authors).toEqual([])
  })

  it('🔴 an unreadable uploader keeps no author, and nothing else changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await documentoGateOptions(payloadFor('Ana Ruiz', new Error('db down')), 1, {
      contentKind: 'documento',
      uploadedBy: 7,
    })
    expect(out.authors).toEqual([])
    expect(out.roster).toEqual(['Itzel Barragán'])
  })

  it('no uploader, no author', async () => {
    const out = await documentoGateOptions(payloadFor('Ana Ruiz', [{ personName: 'Ana Ruiz' }]), 1, { contentKind: 'documento' })
    expect(out.authors).toEqual([])
  })
})

describe('documentoGateOptions — the two switches (owner decision 2026-11-07)', () => {
  const payloadFor = (features: unknown, memberships: unknown[] = [{ personName: 'Ana Ruiz' }]) => {
    const find = vi.fn(async () => ({ docs: memberships }))
    return { payload: { findByID: vi.fn(async () => ({ features })), find } as never, find }
  }

  it('🔴 default: no author, no cited names, and the uploader is never read', async () => {
    const { payload, find } = payloadFor(null)
    const out = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7 })
    expect(out.authors).toEqual([])
    expect(out.keepCitedAuthors).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })

  it.each([
    // [ecosistema, document, expected]
    [true, null, true],
    [false, null, false],
    [true, false, false],
    [false, true, true],
    [undefined, undefined, false],
  ])('keepDocumentAuthor: ecosistema %s, document %s → %s', async (eco, doc, expected) => {
    const { payload } = payloadFor(eco === undefined ? null : { keepDocumentAuthor: eco })
    const out = await documentoGateOptions(payload, 1, { contentKind: 'documento', uploadedBy: 7, keepDocumentAuthor: doc })
    expect(out.authors).toEqual(expected ? ['Ana Ruiz'] : [])
  })

  it.each([
    [true, null, true],
    [false, null, false],
    [true, false, false],
    [false, true, true],
  ])('keepCitedAuthors: ecosistema %s, document %s → %s', async (eco, doc, expected) => {
    const { payload } = payloadFor({ keepCitedAuthors: eco })
    const out = await documentoGateOptions(payload, 1, { contentKind: 'documento', keepCitedAuthors: doc })
    expect(out.keepCitedAuthors).toBe(expected)
  })

  it('a testimonio gets both switches, never the roster or public figures', async () => {
    const { payload } = payloadFor({ keepDocumentAuthor: true, keepCitedAuthors: true, keepPublicFigures: true })
    const out = await documentoGateOptions(payload, 1, { contentKind: 'testimonio', uploadedBy: 7, keepPublicFigures: true })
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: ['Ana Ruiz'], keepDocumentAuthor: true, keepCitedAuthors: true })
    expect(roster).not.toHaveBeenCalled()
  })

  it('🔴 a conversation gets neither, whatever the row says', async () => {
    const { payload, find } = payloadFor({ keepDocumentAuthor: true, keepCitedAuthors: true })
    const out = await documentoGateOptions(payload, 1, {
      contentKind: 'conversacion',
      uploadedBy: 7,
      keepDocumentAuthor: true,
      keepCitedAuthors: true,
    })
    expect(out).toEqual({ keepPublicFigures: false, roster: [], authors: [], keepDocumentAuthor: false, keepCitedAuthors: false })
    expect(find).not.toHaveBeenCalled()
  })

  it('🔴 an unreadable setting is off (fails closed)', async () => {
    const payload = { findByID: vi.fn(async () => { throw new Error('db down') }), find: vi.fn(async () => ({ docs: [{ personName: 'Ana Ruiz' }] })) } as never
    const out = await documentoGateOptions(payload, 1, { contentKind: 'testimonio', uploadedBy: 7 })
    expect(out.authors).toEqual([])
    expect(out.keepCitedAuthors).toBe(false)
  })

  it('effectiveSwitches says where each value came from', async () => {
    const { payload } = payloadFor({ keepDocumentAuthor: true })
    expect(await effectiveSwitches(payload, 1, { keepCitedAuthors: false })).toEqual({
      keepDocumentAuthor: { value: true, origin: 'ecosistema' },
      keepCitedAuthors: { value: false, origin: 'documento' },
    })
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
