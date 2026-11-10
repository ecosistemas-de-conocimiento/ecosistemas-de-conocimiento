/**
 * 🔴 The recovery path (audio documentos) carries the row's
 * `keepPublicFigures` override to the gate (audit 2026-10-27). Dropped, an
 * override of `false` would fall back to an ecosistema that says `true`.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
const enqueue = vi.fn(async () => undefined)
vi.mock('@/collections/Documents', () => ({
  enqueueIngestForDoc: enqueue,
  scheduleGraphExtractionForDoc: vi.fn(async () => undefined),
}))

import { driveTranscribedDocument } from './ingestRecovery'

const payload = { update: vi.fn(async () => ({ id: 7 })) }

describe('driveTranscribedDocument — keepPublicFigures', () => {
  it.each([true, false, null])('override %s is carried to the gate', async (override) => {
    enqueue.mockClear()
    await driveTranscribedDocument(payload as never, {
      id: 7,
      organization: 1,
      uploadedBy: 2,
      name: 'notas.m4a',
      kind: 'audio',
      contentKind: 'documento',
      anonymise: true,
      keepPublicFigures: override,
      extractedText: 'Habló el senador Ramiro Saldaña.',
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const args = (enqueue.mock.calls[0] as unknown as [{ fresh: { keepPublicFigures?: unknown } }])[0]
    expect(args.fresh.keepPublicFigures).toBe(override)
  })
})

// 🔴 P-13: an approved gated documento keeps its redacted title on re-ingest.
describe('driveTranscribedDocument — anonymisationReport', () => {
  it('is carried to the ingest, so the redacted title survives', async () => {
    enqueue.mockClear()
    const report = { redactedTitle: 'Notas de [Persona A].m4a' }
    await driveTranscribedDocument(payload as never, {
      id: 7,
      organization: 1,
      uploadedBy: 2,
      name: 'Notas de Ramiro.m4a',
      kind: 'audio',
      contentKind: 'documento',
      anonymise: true,
      anonymisationReport: report,
      extractedText: 'Habló Ramiro.',
    })
    const args = (enqueue.mock.calls[0] as unknown as [{ fresh: { anonymisationReport?: unknown } }])[0]
    expect(args.fresh.anonymisationReport).toEqual(report)
  })
})
