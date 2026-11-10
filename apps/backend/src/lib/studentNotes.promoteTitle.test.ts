/**
 * 🔴 P-13 (owner decision 2026-11-10): a promoted note revision reaches the
 * shared corpus under the REVISION's redacted title, never the note's raw name
 * — on the document and on its chunk metadata.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
vi.mock('./documentColumns', () => import('./documentColumns.testFake'))

import { promoteRevision } from './studentNotes'

const NOTE = {
  id: 40,
  name: 'Notas sobre María López',
  kind: 'markdown',
  contentKind: 'documento',
  anonymise: true,
  organization: 5,
  publicationStatus: 'published',
}

function run(report: unknown) {
  const revision = {
    id: 41,
    revisionOf: 40,
    name: NOTE.name,
    contentKind: 'documento',
    anonymise: true,
    anonymisationStatus: 'ready',
    redactedText: 'Habló [Persona A].',
    anonymisationReport: report,
    graphStatus: 'ready',
    publicationStatus: 'draft',
  }
  const payload = {
    update: vi.fn(async () => ({ id: 41 })),
    findByID: vi.fn(async ({ id }: { id: unknown }) => (String(id) === '41' ? revision : NOTE)),
  }
  const enqueue = vi.fn(async () => {
    throw new Error('stop after the enqueue')
  })
  return { payload, enqueue, done: promoteRevision({ payload: payload as never, revision, client: { ingest: { enqueue } } as never }) }
}

describe('promoteRevision — the title (P-13)', () => {
  it.each([
    [{ redactedTitle: 'Notas sobre [Persona A]' }, 'Notas sobre [Persona A]'],
    [null, 'Documento'],
  ])('🔴 report %o → %s, never the raw name', async (report, title) => {
    const { enqueue, done } = run(report)
    await expect(done).rejects.toThrow('stop after the enqueue')
    const doc = (enqueue.mock.calls[0] as unknown as [{ documents: { title: string; metadata: { title: string } }[] }])[0]
      .documents[0]!
    expect(doc.title).toBe(title)
    expect(doc.metadata.title).toBe(title)
  })
})
