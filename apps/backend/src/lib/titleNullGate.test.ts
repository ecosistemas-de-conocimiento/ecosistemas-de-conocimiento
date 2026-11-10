/**
 * 🔴 A `documento` with `anonymise` NULL is GATED FOR ITS TITLE (coordinator
 * ruling 2026-11-10, conservative, like `mayReadGatedOriginal`): its redacted
 * title, else "Documento", never `name`. Only `false` shows the name. The BODY
 * rule (`anonymiseRequested`) is unchanged: NULL is still ungated text.
 *
 * Every backend surface that titles a documento: `titleFor`/`documentTitleFor`,
 * the graph (`mapDocumentRow`, shared by `queries.ts` and `combined.ts`), the
 * lengua re-ingest, and the body rule left as it was.
 */
import { describe, expect, it } from 'vitest'

import { anonymiseRequested, chunkMetadata, documentTitleFor, titleFor, titleIsGated } from './contentKind'
import { mapDocumentRow } from './graph/queries'
import { backfillLengua, type BackfillCandidate, type LenguaIngester } from './backfillLengua'

const NAME = 'Entrevista a Juan Pérez.pdf'
const REDACTED = 'Entrevista a [Persona A].pdf'

describe('titleIsGated', () => {
  it.each([
    [null, true],
    [true, true],
    ['true', true],
    [false, false],
    [undefined, false],
  ])('%o → %s', (v, gated) => expect(titleIsGated(v)).toBe(gated))

  it('⚠ the body rule is not changed: NULL stays ungated text', () => {
    expect(anonymiseRequested(null)).toBe(false)
  })
})

describe('🔴 anonymise NULL → neutral or redacted title on every surface', () => {
  it('titleFor and documentTitleFor', () => {
    expect(titleFor('documento', NAME, { anonymise: null })).toBe('Documento')
    expect(titleFor('documento', NAME, { anonymise: null, anonymisationReport: { redactedTitle: REDACTED } })).toBe(REDACTED)
    expect(documentTitleFor({ contentKind: 'documento', name: NAME, anonymise: null })).toBe('Documento')
    expect(documentTitleFor({ contentKind: 'documento', name: NAME, anonymise: false })).toBe(NAME)
    expect(chunkMetadata({ docId: '1', organizationId: 1, contentKind: 'documento', publication: 'published', title: NAME, gate: { anonymise: null } }).title).toBe('Documento')
  })

  it('the graph (queries.ts and combined.ts share mapDocumentRow)', () => {
    const row = { id: 1, name: NAME, content_kind: 'documento', anonymise: null }
    expect(mapDocumentRow({ ...row, redacted_title: null }, false).title).toBe('Documento')
    expect(mapDocumentRow({ ...row, redacted_title: REDACTED }, false).title).toBe(REDACTED)
    expect(mapDocumentRow({ ...row, anonymise: false, redacted_title: null }, false).title).toBe(NAME)
  })

  it('the lengua re-ingest', async () => {
    const calls: Array<Parameters<LenguaIngester['ingest']['enqueue']>[0]> = []
    const clientFor = (): LenguaIngester => ({
      ingest: { enqueue: async (req) => (calls.push(req), { ingestId: 'x' }) },
    })
    const doc: BackfillCandidate = {
      id: 7, name: NAME, kind: 'pdf', contentKind: 'documento', extractedText: 'Texto.', lengua: 'mixe', organization: 1, anonymise: null,
    }
    await backfillLengua({ find: async () => ({ docs: [doc] }) } as never, clientFor, { apply: true, delayMs: 0 })
    expect(calls[0]!.documents[0]!.title).toBe('Documento')
    expect((calls[0]!.documents[0]!.metadata as { title?: unknown }).title).toBe('Documento')
  })
})
