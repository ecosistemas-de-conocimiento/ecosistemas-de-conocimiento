/**
 * P-10 (audit 2026-11-10): "Publicar cambios" gates the new text in a revision
 * row, and that row must carry the NOTE's own three switches. Only
 * `keepDocumentAuthor` was pinned (`studentNotes.pg.test.ts`); losing the
 * `keepPublicFigures` line would let a note that hides public figures inherit
 * the ecosistema's "on" and show them. Fake Payload, no database.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import { MIN_NOTE_CHARS, publishStudentNoteChanges } from './studentNotes'

const BODY = 'Una nota nueva. '.repeat(Math.ceil(MIN_NOTE_CHARS / 10))

function fakePayload() {
  const created: Array<Record<string, unknown>> = []
  const payload = {
    find: vi.fn(async () => ({ docs: [] })),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data)
      return { id: 2 }
    }),
  } as unknown as Payload
  return { payload, created }
}

const note = (over: Record<string, unknown>) => ({
  id: 1,
  organization: 7,
  uploadedBy: 3,
  name: 'Nota',
  kind: 'markdown',
  mediaFile: null,
  contentKind: 'documento',
  publicationStatus: 'published',
  bodyMarkdown: BODY,
  processedBody: 'el texto anterior',
  ...over,
})

describe('publishStudentNoteChanges — 🔴 the revision runs under the note\'s own switches', () => {
  it.each([
    [{ keepPublicFigures: false, keepCitedAuthors: true, keepDocumentAuthor: false }],
    [{ keepPublicFigures: true, keepCitedAuthors: false, keepDocumentAuthor: true }],
  ])('copies keepPublicFigures, keepCitedAuthors and keepDocumentAuthor: %o', async (switches) => {
    const { payload, created } = fakePayload()
    const out = await publishStudentNoteChanges({
      payload,
      row: note(switches),
      clientFor: () => ({}) as never,
      extract: async (b) => b,
    })
    expect(out).toMatchObject({ status: 202, processing: true })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ revisionOf: 1, ...switches })
  })

  it('an inherited switch (no override) stays inherited: null, not false', async () => {
    const { payload, created } = fakePayload()
    await publishStudentNoteChanges({ payload, row: note({}), clientFor: () => ({}) as never, extract: async (b) => b })
    expect(created[0]).toMatchObject({ keepPublicFigures: null, keepCitedAuthors: null, keepDocumentAuthor: null })
  })
})
