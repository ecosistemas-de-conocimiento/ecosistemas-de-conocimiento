/**
 * DELETING ONE DOCUMENT PLANS THE DELETE OF ITS STORED FILE — in the
 * transaction, for after commit. Rodrigo ruled the old behaviour (file and
 * `media` row left behind) a bug on 2026-10-17.
 *
 * Against a fake Payload: the plan `Documents.beforeDelete` makes. What a real
 * delete does with it, commit and rollback included, is pinned in
 * `lib/conversationUploads.pg.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { Payload } from 'payload'

import { planDocumentMediaCleanup, SKIP_DOCUMENT_CORPUS_CLEANUP } from '../lib/conversationUploads'
import { Documents } from './Documents'

const OWNER = 5

function fake(opts: { mediaFile?: number | null; mediaUploader?: number; noDoc?: boolean } = {}) {
  const calls: string[] = []
  const info: unknown[][] = []
  const payload = {
    logger: { info: (...a: unknown[]) => info.push(a), warn: () => {}, error: () => {}, debug: () => {} },
    findByID: async (args: { collection: string; id: number }) => {
      calls.push(`findByID:${args.collection}:${args.id}`)
      if (args.collection === 'documents') {
        if (opts.noDoc) return null
        return { id: args.id, uploadedBy: OWNER, mediaFile: opts.mediaFile === undefined ? 70 : opts.mediaFile }
      }
      if (args.collection === 'media') return { id: args.id, uploadedBy: opts.mediaUploader ?? OWNER }
      return null
    },
  } as unknown as Payload
  return { payload, calls, info }
}

describe('planDocumentMediaCleanup', () => {
  it('plans the uploader’s own file, with no session', async () => {
    const { payload } = fake()

    expect(await planDocumentMediaCleanup(50, { payload })).toEqual({
      sessionId: null,
      documentId: 50,
      // The fake has no transaction.
      xid: null,
      documents: [],
      mediaIds: [70],
    })
  })

  it('🔴 plans nothing for a document a conversation delete is removing, and reads nothing', async () => {
    const { payload, calls } = fake()
    const context = { [SKIP_DOCUMENT_CORPUS_CLEANUP]: { '50': true as const } }
    const req = { payload, context } as never

    expect(await planDocumentMediaCleanup(50, { payload, req })).toBeNull()
    expect(calls).toEqual([])
    // Peeked, not consumed: the document's afterDelete still needs the entry.
    expect(context[SKIP_DOCUMENT_CORPUS_CLEANUP]).toEqual({ '50': true })
  })

  it('another document on the skip-list does not stop this one', async () => {
    const { payload } = fake()
    const req = { payload, context: { [SKIP_DOCUMENT_CORPUS_CLEANUP]: { '51': true } } } as never

    expect((await planDocumentMediaCleanup(50, { payload, req }))?.mediaIds).toEqual([70])
  })

  it('🔴 never plans to delete a file someone else uploaded', async () => {
    const { payload } = fake({ mediaUploader: OWNER + 1 })

    expect(await planDocumentMediaCleanup(50, { payload })).toBeNull()
  })

  it('a note with no file plans nothing', async () => {
    expect(await planDocumentMediaCleanup(50, { payload: fake({ mediaFile: null }).payload })).toBeNull()
  })

  it('a missing document plans nothing (Payload answers 404 itself)', async () => {
    expect(await planDocumentMediaCleanup(50, { payload: fake({ noDoc: true }).payload })).toBeNull()
  })
})

describe('Documents.beforeDelete', () => {
  const hook = (Documents.hooks?.beforeDelete ?? [])[0] as unknown as (args: unknown) => Promise<void>

  it('schedules the plan and logs its ids before the wait', async () => {
    const { payload, info } = fake()
    const req = { payload, context: {} }

    await hook({ id: 50, req, context: req.context })

    expect(info[0]).toEqual([
      { documentId: '50', xid: null, documentIds: [], mediaIds: ['70'] },
      '[documents] scheduled post-commit upload cleanup',
    ])
  })
})
