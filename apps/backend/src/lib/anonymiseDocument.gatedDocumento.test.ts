/**
 * Owner rulings 2026-10-26: a `documento` filed with `anonymise` set — every
 * participant PDF/DOCX, and staff meeting notes ticked "Anonimizar" — passes
 * the gate like a testimonio. It stays a `documento`; only its text is gated.
 * An ungated staff `documento` behaves exactly as before.
 *
 * Fake Payload, static detector: no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./documentColumns', () => import('./documentColumns.testFake'))

const scheduleTitle = vi.fn()
vi.mock('./testimonioTitle', () => ({ scheduleTestimonioTitle: scheduleTitle }))

import { staticDetector } from './anonymise'
import {
  anonymiseDocumentText,
  anonymiseRequested,
  corpusTextFor,
  mustPassAnonymisationGate,
} from './anonymiseDocument'
import { anonymiseParticipantUpload, autoPublishBlocker } from './autoPublish'

const NAME = 'María López'
const NOTES = `Acta de la visita. Asistió ${NAME}, del comité del agua.`

function fakePayload() {
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    payload: {
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data)
        return {}
      },
    },
    last(key: string): unknown {
      for (let i = writes.length - 1; i >= 0; i -= 1) {
        if (Object.prototype.hasOwnProperty.call(writes[i]!, key)) return writes[i]![key]
      }
      return undefined
    },
  }
}

const gate = (fake: ReturnType<typeof fakePayload>, anonymise: unknown, detector = staticDetector([{ text: NAME, type: 'persona' }])) =>
  anonymiseDocumentText({
    payload: fake.payload as never,
    docId: 5,
    organizationId: 1,
    contentKind: 'documento',
    anonymise,
    text: NOTES,
    detector,
  })

describe('mustPassAnonymisationGate — a documento filed for anonymisation', () => {
  it.each([
    [true, true],
    ['true', true],
    [1, true],
    [false, false],
    [null, false],
    [undefined, false],
  ])('documento + anonymise=%s → gated %s', (flag, expected) => {
    expect(mustPassAnonymisationGate('documento', flag)).toBe(expected)
    expect(anonymiseRequested(flag)).toBe(expected)
  })

  it('the flag never UN-gates another kind', () => {
    expect(mustPassAnonymisationGate('testimonio', false)).toBe(true)
    expect(mustPassAnonymisationGate(undefined, false)).toBe(true)
  })
})

describe('anonymiseDocumentText — gated documento', () => {
  it('🔴 runs the gate and returns the REDACTED text when it clears', async () => {
    const fake = fakePayload()
    const out = await gate(fake, true)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).not.toContain(NAME)
    expect(fake.last('anonymisationStatus')).toBe('ready')
    expect(String(fake.last('redactedText'))).not.toContain(NAME)
  })

  it('🔴 a hold writes `held`, no redactedText, and no testimonio title', async () => {
    const fake = fakePayload()
    const missesThenFinds = staticDetector((text) =>
      text.includes('[Persona ') ? [{ text: 'López', type: 'persona' as const }] : [{ text: 'María', type: 'persona' as const }],
    )
    const out = await gate(fake, true, missesThenFinds)
    expect(out.ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('held')
    expect(fake.last('redactedText')).toBeNull()
    // Keeps its own title: title generation is for testimonios only.
    expect(scheduleTitle).not.toHaveBeenCalled()
  })

  it.each([
    ['documento', 'documento'],
    ['testimonio', 'testimonio'],
    ['conversacion', 'conversacion'],
    ['algo-raro', 'testimonio'],
  ])('the detector is told the content kind: %s → %s', async (kind, told) => {
    const seen: string[] = []
    const detector = {
      name: 'spy',
      async detect(args: { text: string; contentKind: string }) {
        seen.push(args.contentKind)
        return []
      },
    }
    await anonymiseDocumentText({
      payload: fakePayload().payload as never,
      docId: 5,
      organizationId: 1,
      contentKind: kind,
      anonymise: true,
      text: NOTES,
      detector: detector as never,
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([told]))
  })

  it('an ungated staff documento passes through untouched, as before', async () => {
    const fake = fakePayload()
    const out = await gate(fake, false)
    expect(out).toEqual({ ok: true, text: NOTES, report: null, title: 'Documento sin título' })
    expect(fake.last('anonymisationStatus')).toBe('n/a')
  })
})

describe('corpusTextFor — gated documento', () => {
  const row = (over: Record<string, unknown>) => ({
    contentKind: 'documento',
    anonymise: true,
    extractedText: NOTES,
    redactedText: 'Acta de la visita. Asistió [Persona A], del comité del agua.',
    anonymisationStatus: 'ready',
    ...over,
  })

  it('🔴 never the original: ready/approved → redacted; anything else → refused', () => {
    expect(corpusTextFor(row({}))).toEqual({ ok: true, text: row({}).redactedText })
    expect(corpusTextFor(row({ anonymisationStatus: 'approved' })).ok).toBe(true)
    for (const s of ['held', 'rejected', 'pending', 'n/a', null]) {
      expect(corpusTextFor(row({ anonymisationStatus: s })).ok, String(s)).toBe(false)
    }
  })

  it('ungated documento still uses extractedText', () => {
    expect(corpusTextFor(row({ anonymise: false, anonymisationStatus: 'n/a' }))).toEqual({ ok: true, text: NOTES })
  })
})

describe('auto-publish — a participant PDF', () => {
  const draft = (over: Record<string, unknown>) => ({
    contentKind: 'documento',
    anonymise: true,
    kind: 'pdf',
    publicationStatus: 'draft',
    ingestStatus: 'ready',
    anonymisationStatus: 'ready',
    redactedText: 'texto con [Persona A]',
    extractedText: NOTES,
    ...over,
  })

  it('🔴 held → stays a draft (Revisión); ready → published', () => {
    expect(autoPublishBlocker(draft({ anonymisationStatus: 'held', redactedText: null }))).toBe('gate-not-cleared')
    expect(autoPublishBlocker(draft({ anonymisationStatus: 'n/a', redactedText: null }))).toBe('gate-not-cleared')
    expect(autoPublishBlocker(draft({}))).toBeNull()
  })

  it.each([
    ['member', false, true],
    ['investigador', false, false],
    ['admin', false, false],
    ['member', true, false],
    [null, false, false],
  ] as const)('role %s, platform admin %s → anonymise %s', (role, platformAdmin, expected) => {
    expect(anonymiseParticipantUpload({ role, platformAdmin })).toBe(expected)
  })
})

describe('anonymiseDocumentText — keep public figures (owner rulings 2026-10-27)', () => {
  const CASE = 'El senador Ramiro Saldaña habló. Tadeo Villaseñor, vecino, lo escuchó.'
  const detector = () =>
    staticDetector([
      { text: 'Ramiro Saldaña', type: 'persona', public: { motivo: 'senador' } },
      { text: 'Tadeo Villaseñor', type: 'persona' },
    ])
  const run = (fake: ReturnType<typeof fakePayload>, contentKind: string, keepPublicFigures?: boolean) =>
    anonymiseDocumentText({
      payload: fake.payload as never,
      docId: 9,
      organizationId: 1,
      contentKind,
      anonymise: true,
      text: CASE,
      detector: detector(),
      ...(keepPublicFigures === undefined ? {} : { keepPublicFigures }),
    })

  it('documento, option on: the politician is kept and logged with model and time', async () => {
    const fake = fakePayload()
    const out = await run(fake, 'documento', true)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('Ramiro Saldaña')
    expect(out.text).not.toContain('Villaseñor')
    const log = fake.last('publicFiguresKept') as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ name: 'Ramiro Saldaña', motivo: 'senador', model: 'static' })
    expect(typeof log[0]?.at).toBe('string')
  })

  it('documento, option off: redacted, log cleared', async () => {
    const fake = fakePayload()
    const out = await run(fake, 'documento', false)
    expect(out.ok && out.text).not.toContain('Saldaña')
    expect(fake.last('publicFiguresKept')).toBeNull()
  })

  it('🔴 testimonio with the option on: redacted, nothing logged', async () => {
    const fake = fakePayload()
    const out = await run(fake, 'testimonio', true)
    expect(out.ok && out.text).not.toContain('Saldaña')
    expect(fake.last('publicFiguresKept')).toBeNull()
  })
})

describe('anonymiseDocumentText — authorsKept (R60)', () => {
  const AUTHOR = 'Ana María López'
  const TEXT = `Autora: ${AUTHOR}\n\n${AUTHOR} entrevistó a Pedro Gómez.`
  const ok = () => staticDetector([{ text: AUTHOR, type: 'persona' }, { text: 'Pedro Gómez', type: 'persona' }])
  const run = (fake: ReturnType<typeof fakePayload>, detector: Parameters<typeof anonymiseDocumentText>[0]['detector'], text: unknown = TEXT, contentKind = 'documento') =>
    anonymiseDocumentText({
      payload: fake.payload as never,
      docId: 7,
      organizationId: 1,
      contentKind,
      anonymise: true,
      text: text as string,
      detector,
      authors: [AUTHOR],
    })

  it('ready: logs the whole name, the model and the time', async () => {
    const fake = fakePayload()
    const out = await run(fake, ok())
    expect(out.ok && out.text).toContain(AUTHOR)
    const log = fake.last('authorsKept') as Array<Record<string, unknown>>
    expect(log).toEqual([{ name: AUTHOR, model: 'static', at: expect.any(String) }])
  })

  it('ready with nothing kept: the log is cleared', async () => {
    const fake = fakePayload()
    expect((await run(fake, staticDetector([{ text: 'Pedro Gómez', type: 'persona' }]), 'Pedro Gómez habló.')).ok).toBe(true)
    expect(fake.last('authorsKept')).toBeNull()
  })

  it('a testimonio keeps the author too when the switch passed names (owner decision 2026-11-07)', async () => {
    const fake = fakePayload()
    const out = await run(fake, ok(), TEXT, 'testimonio')
    expect(out.ok && out.text).toContain(AUTHOR)
    expect(fake.last('authorsKept')).toEqual([{ name: AUTHOR, model: 'static', at: expect.any(String) }])
  })

  it('🔴 a conversation keeps nobody and logs nobody', async () => {
    const fake = fakePayload()
    const out = await run(fake, ok(), TEXT, 'conversacion')
    expect(out.ok && out.text).not.toContain('López')
    expect(fake.last('authorsKept')).toBeNull()
  })

  /** Verify still finds a name: a real, reviewable hold. */
  const survives = () => {
    let call = 0
    return {
      name: 'survivor',
      async detect({ text }: { text: string }) {
        const found = call++ === 0 ? [AUTHOR] : text.includes('entrevistó') ? ['entrevistó'] : []
        return found.map((t) => ({ text: t, type: 'persona' as const }))
      },
    }
  }

  it('🔴 a hold clears the log: an earlier run may have written it', async () => {
    const fake = fakePayload()
    const out = await run(fake, survives())
    expect(out.ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('held')
    expect(fake.last('authorsKept')).toBeNull()
    expect(fake.last('citedAuthorsKept')).toBeNull()
  })

  it('🔴 a model that never answered clears the log too', async () => {
    const fake = fakePayload()
    const down = {
      name: 'down',
      async detect() {
        throw Object.assign(new Error('down'), { infrastructure: true })
      },
    }
    expect((await run(fake, down)).ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('n/a')
    expect(fake.last('authorsKept')).toBeNull()
    expect(fake.last('citedAuthorsKept')).toBeNull()
  })

  it('🔴 a crash in the gate clears the log too', async () => {
    const fake = fakePayload()
    const crashing = {
      get name(): string {
        throw new Error('crash')
      },
      async detect() {
        return []
      },
    }
    expect((await run(fake, crashing)).ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('held')
    expect(fake.last('authorsKept')).toBeNull()
    expect(fake.last('citedAuthorsKept')).toBeNull()
  })
})

describe('anonymiseDocumentText — citedAuthorsKept and the settings snapshot', () => {
  const TEXT = 'Como mostró López (2020), Pedro Gómez habló.'
  const detector = () =>
    staticDetector([
      { text: 'López', type: 'persona', public: { motivo: 'autor citado' } },
      { text: 'Pedro Gómez', type: 'persona' },
    ])
  const run = (fake: ReturnType<typeof fakePayload>, keepCitedAuthors: boolean) =>
    anonymiseDocumentText({
      payload: fake.payload as never,
      docId: 7,
      organizationId: 1,
      contentKind: 'documento',
      anonymise: true,
      text: TEXT,
      detector: detector(),
      keepCitedAuthors,
      settings: { keepDocumentAuthor: false, keepCitedAuthors },
    })

  it('ready with the switch: logs the cited name and the settings it ran under', async () => {
    const fake = fakePayload()
    const out = await run(fake, true)
    expect(out.ok && out.text).toContain('López (2020)')
    expect(fake.last('citedAuthorsKept')).toEqual([{ name: 'López', model: 'static', at: expect.any(String) }])
    expect((fake.last('anonymisationReport') as { settings?: unknown }).settings).toEqual({
      keepDocumentAuthor: false,
      keepCitedAuthors: true,
      keepPublicFigures: false,
    })
  })

  it('🔴 without the switch: nothing kept, the log is cleared', async () => {
    const fake = fakePayload()
    const out = await run(fake, false)
    expect(out.ok && out.text).not.toContain('López')
    expect(fake.last('citedAuthorsKept')).toBeNull()
  })
})
