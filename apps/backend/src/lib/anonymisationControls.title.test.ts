/**
 * 🔴 P-13 (owner decision 2026-11-10): the anonymisation page's title of a
 * gated documento is the gate's redacted title, never the raw `name` — not
 * even for a caller who may read the name (`mayReadName`).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/collections/Documents', () => ({ enqueueIngestForDoc: vi.fn(), mayReadGatedOriginal: () => true }))
vi.mock('./graph/documentGraph', () => ({ rebuildDocumentGraph: vi.fn(), purgeDocumentGraph: vi.fn() }))
vi.mock('./aiClient', () => ({ getAdminAIClient: () => ({}) }))

import { viewOf } from './anonymisationControls'

const off = { value: false, source: 'default' }
const SWITCHES = { keepDocumentAuthor: off, keepCitedAuthors: off, keepPublicFigures: off } as never

const row = (extra: Record<string, unknown>) => ({
  id: 10,
  name: 'Entrevista a María López.pdf',
  contentKind: 'documento',
  anonymisationStatus: 'ready',
  redactedText: 'Asistió [Persona A]',
  ...extra,
})

describe('viewOf — the title (P-13)', () => {
  it.each([true, false])('🔴 a gated documento shows its redacted title (mayReadName %s)', (mayReadName) => {
    const view = viewOf(
      row({ anonymise: true, anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' } }),
      SWITCHES,
      mayReadName,
    )
    expect(view.name).toBe('Entrevista a [Persona A].pdf')
  })

  it('🔴 a gated documento with no redacted title yet is "Documento"', () => {
    expect(viewOf(row({ anonymise: true }), SWITCHES, true).name).toBe('Documento')
  })

  it('an ungated documento keeps its name', () => {
    expect(viewOf(row({ anonymise: false }), SWITCHES, true).name).toBe('Entrevista a María López.pdf')
  })
})
