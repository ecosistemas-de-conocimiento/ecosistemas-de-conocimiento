/**
 * 🔴 Owner rulings 2026-10-26: a `documento` filed for anonymisation publishes
 * ONLY its redacted text, its redacted title (P-13) and the `documento` label, and a
 * held one is never published. Fake Payload, fake ai-service.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { NotPublishableError, beginPublish, unpublish, type CorpusMover, type PublishableDocument } from './publishDocument'

const RAW = 'Acta de la visita. Asistió María López, del comité del agua.'
const REDACTED = 'Acta de la visita. Asistió [Persona A], del comité del agua.'

const GATED: PublishableDocument = {
  id: 31,
  name: 'Acta visita comité',
  kind: 'pdf',
  contentKind: 'documento',
  anonymise: true,
  extractedText: RAW,
  redactedText: REDACTED,
  anonymisationStatus: 'ready',
  organization: 7,
  uploadedBy: 42,
}

function fakes() {
  const update = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}))
  const enqueue = vi.fn(async (_req: Parameters<CorpusMover['ingest']['enqueue']>[0]) => ({ ingestId: 'ing-1' }))
  const client: CorpusMover = {
    ingest: { enqueue },
    admin: { setDocumentValidity: vi.fn(async () => ({})) },
  }
  return { payload: { update, logger: { warn: vi.fn() } } as unknown as Payload, update, client, enqueue }
}

describe('beginPublish — gated documento', () => {
  // 🔴 P-13 (owner decision 2026-11-10): its title is the gate's redacted
  // title (`anonymisationReport.redactedTitle`), else "Documento" — never `name`.
  it.each([
    [{ redactedTitle: 'Acta visita [Persona A]' }, 'Acta visita [Persona A]'],
    [undefined, 'Documento'],
  ])('🔴 ready → the REDACTED text, its redacted title (report %o), labelled documento', async (report, title) => {
    const f = fakes()
    await beginPublish({ ...GATED, anonymisationReport: report }, { payload: f.payload, client: f.client })
    const doc = f.enqueue.mock.calls[0]![0].documents[0]!
    expect(doc.text).toBe(REDACTED)
    expect(doc.text).not.toContain('María López')
    expect(doc.title).toBe(title)
    expect(doc.metadata?.title).toBe(title)
    expect(doc.metadata?.kind).toBe('documento')
  })

  it.each([
    [{ redactedTitle: 'Acta visita [Persona A]' }, 'Acta visita [Persona A]'],
    [{ redactedTitle: null }, 'Documento'],
  ])('🔴 unpublish re-embeds into drafts under the redacted title too (report %o)', async (report, title) => {
    const f = fakes()
    await unpublish({ ...GATED, name: 'Acta María López.pdf', publicationStatus: 'published', anonymisationReport: report }, { payload: f.payload, client: f.client })
    const req = f.enqueue.mock.calls[0]![0]
    expect(JSON.stringify(req)).not.toContain('María López')
    expect(req.documents[0]!.title).toBe(title)
    expect(req.documents[0]!.metadata?.title).toBe(title)
  })

  it.each(['held', 'rejected', 'pending', 'n/a'])('🔴 %s → refused, nothing enqueued, row untouched', async (status) => {
    const f = fakes()
    await expect(
      beginPublish({ ...GATED, anonymisationStatus: status, redactedText: null }, { payload: f.payload, client: f.client }),
    ).rejects.toBeInstanceOf(NotPublishableError)
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
  })

  it('🔴 the move to publishing is the guarded, gate-checked write', async () => {
    const f = fakes()
    await beginPublish(GATED, { payload: f.payload, client: f.client })
    const first = f.update.mock.calls[0]![0] as { where?: { and?: unknown[] } }
    expect(JSON.stringify(first.where)).toContain('"anonymisationStatus":{"in":["ready","approved"]}')
  })

  it('an ungated staff documento publishes its original, as before', async () => {
    const f = fakes()
    await beginPublish(
      { ...GATED, anonymise: false, anonymisationStatus: 'n/a', redactedText: null },
      { payload: f.payload, client: f.client },
    )
    expect(f.enqueue.mock.calls[0]![0].documents[0]!.text).toBe(RAW)
  })

  it('an ungated documento keeps its own name on publish and unpublish, whatever its report says', async () => {
    const plain = {
      ...GATED,
      anonymise: false,
      anonymisationStatus: 'n/a',
      redactedText: null,
      anonymisationReport: { redactedTitle: 'Acta visita [Persona A]' },
    }
    for (const move of [beginPublish, unpublish]) {
      const f = fakes()
      await move({ ...plain, publicationStatus: 'published' }, { payload: f.payload, client: f.client })
      const doc = f.enqueue.mock.calls[0]![0].documents[0]!
      expect(doc.title).toBe('Acta visita comité')
      expect(doc.metadata?.title).toBe('Acta visita comité')
    }
  })
})
