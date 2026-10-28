import { describe, expect, it } from 'vitest'

import { MIN_NOTE_CHARS, parseNoteEdit, planNoteProcessing } from './studentNotes'

const TEXT = 'x'.repeat(MIN_NOTE_CHARS)
const note = (over: Record<string, unknown> = {}) => ({
  kind: 'markdown',
  mediaFile: null,
  contentKind: 'documento',
  publicationStatus: 'draft',
  ingestStatus: 'n/a',
  anonymisationStatus: 'n/a',
  extractedText: null,
  ...over,
})

describe('planNoteProcessing', () => {
  it('a fresh note: pending, gated, its text', () => {
    const plan = planNoteProcessing(note(), TEXT)
    expect(plan).toMatchObject({ data: { ingestStatus: 'pending', anonymise: true, extractedText: TEXT, redactedText: null } })
  })

  it.each([
    ['an upload', { mediaFile: 5 }, 'not-a-note'],
    ['a testimonio', { contentKind: 'testimonio' }, 'not-documento'],
    ['🔴 a published note', { publicationStatus: 'published' }, 'not-draft'],
    ['🔴 a rejected note', { anonymisationStatus: 'rejected', ingestStatus: 'failed' }, 'rejected'],
    ['a run in flight', { ingestStatus: 'embedding' }, 'in-flight'],
    ['🔴 a held note, same text', { anonymisationStatus: 'held', ingestStatus: 'failed', extractedText: TEXT }, 'unchanged'],
  ])('%s: skipped', (_label, over, reason) => {
    expect(planNoteProcessing(note(over), TEXT)).toEqual({ skip: reason })
  })

  it('too short: skipped', () => {
    expect(planNoteProcessing(note(), 'corta')).toEqual({ skip: 'too-short' })
  })

  it('🔴 changed text on an approved note clears the approval', () => {
    const plan = planNoteProcessing(note({ anonymisationStatus: 'approved', ingestStatus: 'ready', extractedText: 'old' }), TEXT)
    expect(plan).toMatchObject({ data: { anonymisationStatus: 'n/a', redactedText: null, heldText: null } })
  })
})

describe('parseNoteEdit', () => {
  const MAX = 100
  it('takes name, body and pin only', () => {
    expect(parseNoteEdit({ name: 'Nota', bodyMarkdown: 'hola', isPinned: false }, MAX)).toEqual({
      ok: true,
      data: { name: 'Nota', bodyMarkdown: 'hola', isPinned: false },
    })
  })
  it.each([
    [{ publicationStatus: 'published' }],
    [{ bodyMarkdown: 'x', anonymise: false }],
    [{ ingestStatus: 'ready' }],
    [{ name: '' }],
    [{ bodyMarkdown: 'x'.repeat(MAX + 1) }],
    [{ isPinned: 'yes' }],
    [{}],
  ])('🔴 refuses %j', (body) => {
    expect(parseNoteEdit(body as Record<string, unknown>, MAX).ok).toBe(false)
  })
})
