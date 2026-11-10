/**
 * 🔴 P-13 / R4-01 (2026-11-10): the anonymisation page's title of a gated
 * documento follows REST. Whoever may read its name (`mayReadName` =
 * `mayReadGatedOriginal(user, row, 'identity')`: its uploader, a platform
 * admin) sees `name`; everyone else the gate's redacted title, else "Documento".
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
  it('🔴 a caller who may not read the name sees the redacted title', () => {
    const view = viewOf(
      row({ anonymise: true, anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' } }),
      SWITCHES,
      false,
    )
    expect(view.name).toBe('Entrevista a [Persona A].pdf')
  })

  it('🔴 its uploader (or a platform admin) sees the file name, as in Mis documentos and REST', () => {
    const view = viewOf(
      row({ anonymise: true, anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' } }),
      SWITCHES,
      true,
    )
    expect(view.name).toBe('Entrevista a María López.pdf')
  })

  it('🔴 a gated documento with no redacted title yet is "Documento"', () => {
    expect(viewOf(row({ anonymise: true }), SWITCHES, false).name).toBe('Documento')
  })

  it('🔴 anonymise NULL is gated for the title (2026-11-10): redacted, else "Documento"', () => {
    expect(viewOf(row({ anonymise: null }), SWITCHES, false).name).toBe('Documento')
    expect(
      viewOf(row({ anonymise: null, anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' } }), SWITCHES, false).name,
    ).toBe('Entrevista a [Persona A].pdf')
  })

  it('an ungated documento keeps its name', () => {
    expect(viewOf(row({ anonymise: false }), SWITCHES, true).name).toBe('Entrevista a María López.pdf')
  })
})
