import { describe, expect, it, vi } from 'vitest'

import { retireDeletedDocument } from './publishDocument'

/**
 * Deleting a document used to leave its chunks embedded and retrievable: the
 * row disappeared from the UI while the ecosistema's assistant kept quoting it.
 * These tests pin the two properties that close that leak.
 */

function makeDeps(setDocumentValidity = vi.fn().mockResolvedValue(undefined)) {
  const warn = vi.fn()
  return {
    deps: {
      payload: { logger: { warn } } as never,
      client: { admin: { setDocumentValidity } } as never,
    },
    setDocumentValidity,
    warn,
  }
}

const NOW = new Date('2026-08-18T12:00:00.000Z')

describe('retireDeletedDocument', () => {
  it('🔴 retires from BOTH corpora, whatever the row claims its state was', async () => {
    // A row can be deleted mid-transition, when copies legitimately exist in
    // both places. Trusting `publicationStatus` is how you leave the one that
    // mattered — so the state is deliberately a lie here.
    const { deps, setDocumentValidity } = makeDeps()
    await retireDeletedDocument(
      deps,
      { id: 7, organization: 3, uploadedBy: 9, publicationStatus: 'draft' },
      NOW,
    )

    const corpora = setDocumentValidity.mock.calls.map((c) => c[0])
    expect(corpora).toContain('eco-3')
    expect(corpora).toContain('eco-3-draft-9')
    expect(setDocumentValidity).toHaveBeenCalledTimes(2)
  })

  it('closes the validity window at the delete instant, on the document id', async () => {
    const { deps, setDocumentValidity } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: 3, uploadedBy: 9 }, NOW)

    expect(setDocumentValidity).toHaveBeenCalledWith('eco-3', '7', {
      validTo: NOW.toISOString(),
    })
  })

  it('accepts populated relationships, not only bare ids', async () => {
    const { deps, setDocumentValidity } = makeDeps()
    await retireDeletedDocument(
      deps,
      { id: 7, organization: { id: 3 }, uploadedBy: { id: 9 } },
      NOW,
    )
    expect(setDocumentValidity.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['eco-3', 'eco-3-draft-9']),
    )
  })

  it('🔴 one unreachable corpus does not stop it reaching the other', async () => {
    // The shared corpus is the one that might still be serving this document to
    // colleagues. A failure on the draft corpus must not cost us that call.
    const setDocumentValidity = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const { deps, warn } = makeDeps(setDocumentValidity)

    await retireDeletedDocument(deps, { id: 7, organization: 3, uploadedBy: 9 }, NOW)

    expect(setDocumentValidity).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalled()
  })

  it('never throws — the row is already gone and there is nothing to roll back', async () => {
    const setDocumentValidity = vi.fn().mockRejectedValue(new Error('everything is down'))
    const { deps } = makeDeps(setDocumentValidity)
    await expect(
      retireDeletedDocument(deps, { id: 7, organization: 3, uploadedBy: 9 }, NOW),
    ).resolves.toBeUndefined()
  })

  it('with no ecosistema there is no corpus to name — it says so instead of guessing', async () => {
    const { deps, setDocumentValidity, warn } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: null, uploadedBy: 9 }, NOW)
    expect(setDocumentValidity).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('retires the shared corpus even when the uploader is unknown', async () => {
    // A server-side write can leave `uploadedBy` empty. The draft corpus is
    // then unnameable, but the SHARED one is exactly the leak that matters.
    const { deps, setDocumentValidity } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: 3, uploadedBy: null }, NOW)
    expect(setDocumentValidity).toHaveBeenCalledTimes(1)
    expect(setDocumentValidity).toHaveBeenCalledWith('eco-3', '7', expect.anything())
  })
})
