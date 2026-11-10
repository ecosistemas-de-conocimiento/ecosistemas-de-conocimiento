/**
 * P-13 / I-07 / C-10 (owner decision 2026-11-10): `anonymiseDocumentText`
 * redacts a gated documento's `name` with the body, stores it in the report
 * and hands the caller the title to ingest under. Fake Payload, no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./documentColumns', () => import('./documentColumns.testFake'))
vi.mock('./testimonioTitle', () => ({ scheduleTestimonioTitle: vi.fn() }))

import { staticDetector } from './anonymise'
import { anonymiseDocumentText } from './anonymiseDocument'
import { documentTitleFor } from './contentKind'

const NAME = 'Entrevista a Juan Pérez.pdf'
const TEXT = 'Acta. Juan Pérez contó que la junta se reunió en la escuela.'

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

const gate = (fake: ReturnType<typeof fakePayload>, over: Record<string, unknown> = {}) =>
  anonymiseDocumentText({
    payload: fake.payload as never,
    docId: 5,
    organizationId: 1,
    contentKind: 'documento',
    anonymise: true,
    name: NAME,
    text: TEXT,
    detector: staticDetector((t) => (t.includes('Juan Pérez') ? [{ text: 'Juan Pérez', type: 'persona' as const }] : [])),
    ...over,
  })

describe('🔴 a gated documento\'s title goes through the gate', () => {
  it('stores the redacted title in the report and returns it; the body says the same label', async () => {
    const fake = fakePayload()
    const out = await gate(fake)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.text).toContain('[Persona A] contó')
    expect(out.title).toBe('Entrevista a [Persona A].pdf')
    const report = fake.last('anonymisationReport') as Record<string, unknown>
    expect(report.redactedTitle).toBe('Entrevista a [Persona A].pdf')
    // The stored row now titles itself the same way everywhere.
    expect(documentTitleFor({ contentKind: 'documento', name: NAME, anonymise: true, anonymisationReport: report })).toBe(
      'Entrevista a [Persona A].pdf',
    )
    expect(JSON.stringify(fake.writes)).not.toContain('Juan')
  })

  it('🔴 no name passed → the neutral title, never a raw one', async () => {
    const out = await gate(fakePayload(), { name: undefined })
    expect(out.ok && out.title).toBe('Documento')
  })

  it('🔴 an approved row ingests under the title its gate run stored; none stored → neutral', async () => {
    const stored = { stages: [], pseudonyms: 1, redactedTitle: 'Entrevista a [Persona A].pdf' }
    const approved = await gate(fakePayload(), { approvedText: 'Texto aprobado.', anonymisationReport: stored })
    expect(approved.ok && approved.title).toBe('Entrevista a [Persona A].pdf')
    const bare = await gate(fakePayload(), { approvedText: 'Texto aprobado.' })
    expect(bare.ok && bare.title).toBe('Documento')
  })

  it('an ungated documento keeps its own name', async () => {
    const fake = fakePayload()
    const out = await gate(fake, { anonymise: false })
    expect(out).toEqual({ ok: true, text: TEXT, report: null, title: NAME })
  })

  it('a testimonio\'s name is never sent to the gate and its title stays neutral', async () => {
    const seen: string[] = []
    const out = await gate(fakePayload(), {
      contentKind: 'testimonio',
      name: 'Testimonio de Juan Pérez.mp3',
      detector: {
        name: 'spy',
        async detect({ text }: { text: string }) {
          seen.push(text)
          return text.includes('Juan Pérez') ? [{ text: 'Juan Pérez', type: 'persona' }] : []
        },
      },
    })
    expect(out.ok && out.title).toBe('Testimonio')
    expect(seen.some((t) => t.includes('.mp3'))).toBe(false)
  })
})
