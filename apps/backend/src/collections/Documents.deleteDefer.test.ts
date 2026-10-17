/**
 * A document deleted by a conversation delete must not reach ai-service from
 * its own `afterDelete`: that runs inside the session delete's transaction,
 * and an ai-service delete cannot be rolled back. `lib/conversationUploads.ts`
 * puts the document's id on a one-shot skip-list and does the ai-service half
 * after commit instead.
 */

import { describe, expect, it, vi } from 'vitest'

const deleteDocument = vi.fn(async () => ({ deleted: true }))
const getAdminAIClient = vi.fn(() => ({ admin: { deleteDocument, setDocumentValidity: vi.fn() } }))
vi.mock('@/lib/aiClient', () => ({ getAdminAIClient }))

import { SKIP_DOCUMENT_CORPUS_CLEANUP } from '../lib/conversationUploads'
import { Documents } from './Documents'

const hook = (Documents.hooks?.afterDelete ?? [])[0] as unknown as (args: unknown) => Promise<unknown>
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const doc = (id: number) => ({ id, organization: 42, uploadedBy: 5 })

describe('Documents.afterDelete and the skip-list', () => {
  it('skips ai-service only for the listed id, once', async () => {
    const context = { [SKIP_DOCUMENT_CORPUS_CLEANUP]: { '50': true } }
    const req = { payload: { logger }, context }

    await hook({ doc: doc(50), req, context })
    expect(deleteDocument).not.toHaveBeenCalled()

    // 🔴 Same request, another document: not skipped.
    await hook({ doc: doc(51), req, context })
    expect(deleteDocument).toHaveBeenCalledTimes(2)

    // Same id again: the entry was consumed, so it is cleaned this time.
    await hook({ doc: doc(50), req, context })
    expect(deleteDocument).toHaveBeenCalledTimes(4)
  })
})
