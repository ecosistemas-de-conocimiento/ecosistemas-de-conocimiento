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

  it('an ungated staff documento passes through untouched, as before', async () => {
    const fake = fakePayload()
    const out = await gate(fake, false)
    expect(out).toEqual({ ok: true, text: NOTES, report: null })
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
