/**
 * 🔴 ONLY A DRAFT'S TEXT MAY BE REWRITTEN — the backend half of the rule.
 *
 * A reviewer corrects a machine transcript because Whisper mangles names and
 * numbers. That is only safe while the document is a draft. Once it is
 * published, `extractedText` is no longer the only copy: the same words exist
 * as embedded chunks in the ecosistema's shared corpus, and retrieval reads the
 * chunks. Rewriting the column then desyncs the two — the assistant keeps
 * quoting the old text while the document page shows the new one, and the
 * citation reads as a fabrication.
 *
 * The rule used to live ONLY in the SvelteKit BFF. Nothing stopped a direct
 * `PATCH /api/documents/:id`. It now lives in `bindDocumentToEcosystem`, which
 * is where the collection's other invariants live, and the BFF check stays as
 * defence in depth with a better error message.
 *
 * ⚠ TESTED THE WAY A REAL CALLER REACHES IT. Payload merges the request body
 * over the stored row BEFORE `beforeValidate` runs, so every test here passes a
 * MERGED `data` — the shape the hook actually sees — not the sparse body the
 * client sent. Two of these tests fail against the obvious implementations
 * (`'extractedText' in data`, and reading `data.publicationStatus`).
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { bindDocumentToEcosystem } from './Documents'

const ANA = 1
const ECO = 10

/** No session on either side, so the hook needs nothing from the database. */
const reqAsUser = () =>
  ({ user: { id: ANA, isActive: true } }) as unknown as PayloadRequest

/** A server-side write: `overrideAccess: true` with no user attached. */
const reqAsPipeline = () => ({}) as unknown as PayloadRequest

/** The stored row, as Payload hands it to the hook in `originalDoc`. */
const storedRow = (publicationStatus: string, text: string | null = 'texto original') => ({
  id: 5,
  organization: ECO,
  uploadedBy: ANA,
  contentKind: 'documento',
  kind: 'audio',
  name: 'entrevista.mp3',
  publicationStatus,
  extractedText: text,
})

/**
 * Payload's merge, done honestly: the body over the stored row.
 *
 * 🔴 THIS IS THE WHOLE POINT OF THE FIXTURE. A test that passed only the
 * client's fields would never carry `extractedText` on a rename, and would
 * never carry the stored `publicationStatus` on an edit — so it would pass
 * against an implementation that is wrong in both directions.
 */
const update = (
  original: Record<string, unknown>,
  body: Record<string, unknown>,
  req: PayloadRequest = reqAsUser(),
) =>
  bindDocumentToEcosystem({
    data: { ...original, ...body },
    originalDoc: original,
    operation: 'update',
    req,
    collection: undefined,
    context: {},
  } as never) as Promise<Record<string, unknown>>

async function expectRefusal(promise: Promise<unknown>) {
  let thrown: unknown
  try {
    await promise
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected the hook to refuse this write').toBeDefined()
  const said = `${String((thrown as { message?: unknown })?.message ?? '')} ${JSON.stringify(
    (thrown as { data?: unknown })?.data ?? {},
  )}`
  // Blames the field the caller actually touched, not `publicationStatus`.
  expect(said).toContain('extractedText')
  expect(said).toContain('borrador')
  return thrown
}

describe('🔴 correcting a transcript is a draft-only act', () => {
  it('ALLOWS an edit while the document is a draft', async () => {
    const result = await update(storedRow('draft'), {
      extractedText: 'texto corregido',
      ingestStatus: 'pending',
      ingestId: null,
    })
    expect(result.extractedText).toBe('texto corregido')
  })

  it('🔴 REFUSES an edit once the document is published', async () => {
    // The gap this closes. The BFF returned 409 here; a direct PATCH did not.
    await expectRefusal(update(storedRow('published'), { extractedText: 'texto corregido' }))
  })

  // Both in-flight states have a copy of the text moving between corpora. An
  // edit mid-transition is embedded by whichever leg has not run yet, so the
  // row and the chunks disagree even though nothing was "published".
  it.each(['publishing', 'unpublishing'])(
    '🔴 REFUSES an edit while the document is %s',
    async (status) => {
      await expectRefusal(update(storedRow(status), { extractedText: 'texto corregido' }))
    },
  )

  it('🔴 REFUSES clearing the text on a published document', async () => {
    // Deleting the words is an edit like any other, and `null` must not read as
    // "the caller did not mention this field".
    await expectRefusal(update(storedRow('published'), { extractedText: null }))
  })

  /**
   * 🔴 THE SELF-DEFEATING GATE. A caller who sets `publicationStatus: 'draft'`
   * in the SAME body as the edit walks straight through any check that reads
   * the incoming status instead of the stored one.
   */
  it('🔴 REFUSES when the same request also claims the document is a draft', async () => {
    await expectRefusal(
      update(storedRow('published'), {
        publicationStatus: 'draft',
        extractedText: 'texto corregido',
      }),
    )
  })

  /**
   * ⚠ THE AWKWARD INPUT. A real HTTP caller can put anything JSON allows in
   * this field. A number is not a string, so it can never compare equal to the
   * stored text — "unreadable" must read as "changed", not as "untouched".
   */
  it('🔴 REFUSES a non-string body value on a published document', async () => {
    await expectRefusal(update(storedRow('published'), { extractedText: 42 }))
    await expectRefusal(update(storedRow('published'), { extractedText: { texto: 'hola' } }))
    await expectRefusal(update(storedRow('published'), { extractedText: ['a', 'b'] }))
  })

  /**
   * 🔴 FAILS CLOSED WITH NO STORED STATUS. We cannot tell whether this row is
   * shared, and "we do not know" resolves to "no" for a write gate — the
   * opposite direction from the web badge, which fails toward the private READ.
   */
  it('🔴 REFUSES when the stored publication status cannot be read', async () => {
    const original = { ...storedRow('published'), publicationStatus: undefined }
    await expectRefusal(update(original, { extractedText: 'texto corregido' }))
  })
})

describe('what the rule must NOT break', () => {
  /**
   * 🔴 THE REGRESSION THIS RULE COULD EASILY CAUSE. Payload merges the body
   * over the stored row, so `extractedText` is present on EVERY authenticated
   * PATCH — including a plain rename that never mentioned it. An
   * `'extractedText' in data` check would refuse every rename of every
   * published document in the system.
   */
  it('ALLOWS renaming a published document, which carries the merged text along', async () => {
    const result = await update(storedRow('published'), { name: 'entrevista final.mp3' })
    expect(result.name).toBe('entrevista final.mp3')
    expect(result.extractedText).toBe('texto original')
  })

  it('ALLOWS a published edit that resubmits the identical text', async () => {
    // A no-op write is not an edit. Refusing it would break idempotent retries.
    const result = await update(storedRow('published'), { extractedText: 'texto original' })
    expect(result.extractedText).toBe('texto original')
  })

  it('ALLOWS a write that never names the column at all', async () => {
    const original = storedRow('published')
    const result = (await bindDocumentToEcosystem({
      data: { ingestStatus: 'ready' },
      originalDoc: original,
      operation: 'update',
      req: reqAsUser(),
      collection: undefined,
      context: {},
    } as never)) as Record<string, unknown>
    expect(result.ingestStatus).toBe('ready')
  })

  /**
   * 🔴 EVERY SERVER-SIDE WRITER GOES THROUGH HERE. `runExtractAndIngest`, the
   * `transcribe.completed` callback and the publish state machine all write
   * with `overrideAccess: true` and no user, and some of their rows really are
   * published — a replayed transcription callback lands on one. A rule that
   * blocks the pipeline is worse than the gap it closes.
   */
  it('LEAVES the ingest pipeline alone — a server-side write has no user', async () => {
    const result = await update(
      storedRow('published'),
      { extractedText: 'transcripción nueva', ingestStatus: 'transcribed' },
      reqAsPipeline(),
    )
    expect(result.extractedText).toBe('transcripción nueva')
  })

  it('does not apply on create — a new row is a draft by construction', async () => {
    const result = (await bindDocumentToEcosystem({
      data: { name: 'nota.md', extractedText: 'texto', organization: ECO },
      operation: 'create',
      req: reqAsPipeline(),
      collection: undefined,
      context: {},
    } as never)) as Record<string, unknown>
    expect(result.extractedText).toBe('texto')
  })
})
