/**
 * DOCUMENT UPLOAD → EXTRACT → INGEST, against the real ai-service.
 *
 * The pipeline this walks (`collections/Documents.ts`):
 *
 *   POST /api/media          the bytes
 *   POST /api/documents      the row  →  afterChange (background)
 *                            ingestStatus: extracting → embedding
 *   ai-service               chunks + embeds
 *   POST /api/ai-service/callback   ingest.completed → ready
 *
 * ⚠ Every transition is ASYNCHRONOUS and happens in a `setImmediate` on the
 * server, so everything here polls. A stall is reported with the LAST observed
 * status and error, because "timed out" alone tells nobody which hop broke.
 *
 * ⚠ THE FIXTURES ARE BUILT, NOT COMMITTED, and nothing here may spell one out.
 * Filenames, MIME types and marker words all come from `support/fixtures.ts`,
 * which reads the manifest `scripts/corpus-fixtures.sh` writes. The corpus is a
 * separate repo that gets regenerated, and a regeneration changes which document
 * sorts first — a literal in this file would then fail for a reason that has
 * nothing to do with the pipeline it is meant to be testing.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, apiJson, pollUntil, uploadFixture, type Caller } from './support/api'
import { fixtures, type FixtureEntry } from './support/fixtures'
import { stackDown } from './support/stack'
import { createTextDocument, provisionWorld, type World } from './support/world'

interface DocState {
  ingestStatus?: string
  ingestError?: string | null
  extractedText?: string | null
  ingestId?: string | null
  publicationStatus?: string
}

async function docState(caller: Caller, id: number): Promise<DocState> {
  const res = await apiGet(caller, `/api/documents/${id}?depth=0`)
  const d = res.body ?? {}
  return {
    ingestStatus: d.ingestStatus,
    ingestError: d.ingestError,
    // Truncated on purpose: a timeout message must stay readable.
    extractedText: typeof d.extractedText === 'string' ? d.extractedText.slice(0, 200) : d.extractedText,
    ingestId: d.ingestId,
    publicationStatus: d.publicationStatus,
  }
}

/**
 * The WHOLE extracted text, untruncated.
 *
 * `docState` above deliberately clips to 200 characters, because it is what a
 * poll timeout prints and an unbounded document dumped into a failure message
 * helps nobody. A marker assertion needs the opposite, so it asks again.
 */
async function fullExtractedText(caller: Caller, id: number): Promise<string> {
  const res = await apiGet(caller, `/api/documents/${id}?depth=0`)
  return typeof res.body?.extractedText === 'string' ? res.body.extractedText : ''
}

const TERMINAL = new Set(['ready', 'failed'])

describe.skipIf(stackDown)('document ingest', () => {
  let world: World
  let pdf: FixtureEntry
  let docId: number

  beforeAll(async () => {
    world = await provisionWorld()
    // 🔴 INSIDE the hook, never at module scope. `fixtures()` throws when the
    // fixtures have not been built, and this suite is `skipIf(stackDown)` — a
    // top-level call would turn a legitimate "I have no stack running" skip into
    // a collection error before the skip is ever consulted.
    pdf = fixtures().pdf

    const media = await uploadFixture(
      world.alice.caller,
      pdf.file,
      pdf.mimeType,
      `${world.ns}-${pdf.file}`,
    )
    expect(media.status).toBe(201)

    const doc = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      uploadConsentVersion: 1, // = UPLOAD_CONSENT_VERSION (src/lib/uploadConsent.ts)
      name: `${world.ns} sample pdf`,
      kind: 'pdf',
      mode: 'rag-retrieve',
      mediaFile: media.body.doc.id,
    })
    expect(doc.status).toBe(201)
    docId = doc.body.doc.id
  }, 120_000)

  it('starts a PDF in the pipeline rather than leaving it at n/a', async () => {
    const state = await pollUntil(
      'the PDF to leave the initial state',
      () => docState(world.alice.caller, docId),
      (s) => s.ingestStatus !== 'n/a' && s.ingestStatus !== 'pending',
      { timeoutMs: 30_000, intervalMs: 1000 },
    )
    expect(['extracting', 'embedding', 'ready', 'failed']).toContain(state.ingestStatus)
  })

  it('🔴 extracts the text out of the uploaded PDF and puts it on the row', async () => {
    const state = await pollUntil(
      'the PDF text to be extracted',
      () => docState(world.alice.caller, docId),
      (s) =>
        (typeof s.extractedText === 'string' && s.extractedText.trim().length > 0) ||
        s.ingestStatus === 'failed',
      { timeoutMs: 60_000, intervalMs: 1500 },
    )
    expect(state.ingestError ?? null).toBeNull()
    // The marker is the subject's NAME, unique across the corpus's 250
    // documents. That uniqueness is the whole assertion: an ordinary Spanish
    // word coming back would prove only that SOME text arrived, and a stubbed
    // or cross-wired extractor could satisfy it. This name could only have come
    // out of this file.
    //
    // ⚠ RE-READ, RATHER THAN ASSERTING ON `state`. `docState` truncates
    // `extractedText` to 200 characters so a timeout message stays readable, and
    // that truncation is not this test's business. Today's marker sits inside
    // the first 200 characters, so both would pass — but the corpus is
    // regenerable, and the first document it picks whose subject is named later
    // than character 200 would fail here with a message showing text that
    // plainly contains the name it says is missing.
    expect(await fullExtractedText(world.alice.caller, docId)).toContain(pdf.marker)
  })

  it('🔴 reaches `ready`, which means the ai-service callback landed', async () => {
    const state = await pollUntil(
      'the PDF ingest to reach a terminal state',
      () => docState(world.alice.caller, docId),
      (s) => TERMINAL.has(String(s.ingestStatus)),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )
    expect(state.ingestStatus).toBe('ready')
    // `ingestId` is the join-back key ai-service echoes on the callback. Without
    // it, "ready" could only have come from somewhere it should not have.
    expect(typeof state.ingestId).toBe('string')
    expect(state.ingestId).toBeTruthy()
  })

  it('records the callback it received, keyed on the ingest id', async () => {
    const state = await docState(world.alice.caller, docId)
    // The receiver dedupes on (correlationKey, eventKey) = (ingestId, docId).
    // Reading it back through the admin proves the round trip really happened
    // here and was not inferred from the status column alone.
    const res = await apiGet(
      world.admin,
      `/api/aiServiceCallbacks?limit=5&depth=0&where[correlationKey][equals]=${state.ingestId}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBeGreaterThan(0)
    expect(res.body.docs.map((c: { event: string }) => c.event)).toContain('ingest.completed')
  })

  it('🔴 the uploader can rename their own document', async () => {
    // The most ordinary write there is. Kept as its own test because it is the
    // narrowest possible probe of the document UPDATE path — nothing about
    // ingest, publication or tenancy is involved, so a failure here can only
    // mean the update path itself is broken for everyone.
    const patch = await apiJson(world.alice.caller, 'PATCH', `/api/documents/${docId}`, {
      name: `${world.ns} sample pdf (renamed)`,
    })
    expect(patch.status).toBe(200)

    const after = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    expect(after.body.name).toBe(`${world.ns} sample pdf (renamed)`)
    // …and the publication state is untouched by an unrelated field edit.
    expect(after.body.publicationStatus).toBe('draft')
  })

  it('a re-save does not enqueue a second ingest (the hook is idempotent)', async () => {
    const before = await docState(world.alice.caller, docId)
    const patch = await apiJson(world.alice.caller, 'PATCH', `/api/documents/${docId}`, {
      isPinned: false,
    })
    // ⚠ ASSERTED, not ignored. This test used to fire the PATCH and look only at
    // the ingest fields afterwards — so it passed green against a build where
    // every PATCH 400'd and the re-save never happened at all. A test that
    // cannot tell "the write was idempotent" from "the write was rejected" is
    // asserting nothing.
    expect(patch.status).toBe(200)
    await new Promise((r) => setTimeout(r, 4000))
    const after = await docState(world.alice.caller, docId)
    expect(after.ingestId).toBe(before.ingestId)
    expect(after.ingestStatus).toBe(before.ingestStatus)
  })

  it('refuses to retry a document that never had a pipeline', async () => {
    // A markdown note is not in INGESTABLE_KINDS, so there is nothing to re-run.
    // Deliberately NOT the PDF above: this assertion must not depend on whether
    // the PDF pipeline succeeded.
    const note = await createTextDocument(
      world.alice.caller,
      `${world.ns} nota`,
      'Una nota suelta.',
    )
    const res = await apiJson(world.alice.caller, 'POST', `/api/documents/${note.id}/retry`)
    expect(res.status).toBe(409)
  })

  it('a FAILED document is retryable — the state is terminal but not a dead end', async () => {
    const state = await docState(world.alice.caller, docId)
    const res = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/retry`)
    if (state.ingestStatus === 'failed') {
      // `failed` + a reason + this route is the whole recovery story. If it is
      // not reachable, a user whose upload broke has no way forward at all.
      expect(res.status).toBe(202)
    } else {
      expect(res.status).toBe(409)
    }
  })

  it('a colleague cannot retry, and gets 404 rather than 403', async () => {
    const res = await apiJson(world.bob.caller, 'POST', `/api/documents/${docId}/retry`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DOCX — the same pipeline, a different extractor
// ---------------------------------------------------------------------------

/**
 * 🔴 THE DOCX BRANCH HAD NEVER BEEN RUN END TO END. `kind: 'docx'` is in
 * `INGESTABLE_KINDS` and walks the identical route the block above walks, with
 * exactly one line differing: `extractText` hands the bytes to `mammoth`
 * instead of `unpdf`. That line is the entire risk. Everything downstream of it
 * — enqueue, embed, callback, `ready` — is already covered by the PDF tests, so
 * this block deliberately asserts the two things the PDF tests cannot borrow:
 * that the Word file's own words reached the row, and that they then travelled
 * the shared ingest to completion.
 *
 * ⚠ ITS OWN WORLD, ON PURPOSE. Folding this into the block above would put an
 * untested upload inside the `beforeAll` that the tested path depends on, so a
 * broken DOCX would fail the PDF tests too. That is the wrong way round: a new
 * path must not be able to take a known-good one down with it.
 */
describe.skipIf(stackDown)('docx ingest', () => {
  let world: World
  let docx: FixtureEntry
  let docId: number

  beforeAll(async () => {
    world = await provisionWorld()
    // Inside the hook, for the same reason as the PDF block above.
    docx = fixtures().docx

    const media = await uploadFixture(
      world.alice.caller,
      docx.file,
      docx.mimeType,
      `${world.ns}-${docx.file}`,
    )
    // ⚠ A 400 here is most likely the MIME allowlist, not the extractor:
    // `MEDIA_MIME_TYPES` has to carry the full
    // `application/vnd.openxmlformats-…wordprocessingml.document` string, and
    // that is the value the manifest hands us.
    expect(media.status).toBe(201)

    const doc = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      uploadConsentVersion: 1, // = UPLOAD_CONSENT_VERSION (src/lib/uploadConsent.ts)
      name: `${world.ns} carta docx`,
      kind: 'docx',
      mode: 'rag-retrieve',
      mediaFile: media.body.doc.id,
    })
    expect(doc.status).toBe(201)
    docId = doc.body.doc.id
  }, 120_000)

  it('🔴 extracts the text out of the uploaded DOCX and puts it on the row', async () => {
    const state = await pollUntil(
      'the DOCX text to be extracted',
      () => docState(world.alice.caller, docId),
      (s) =>
        (typeof s.extractedText === 'string' && s.extractedText.trim().length > 0) ||
        s.ingestStatus === 'failed',
      { timeoutMs: 60_000, intervalMs: 1500 },
    )
    expect(state.ingestError ?? null).toBeNull()
    // Same argument as the PDF marker, truncation included: unique name, read
    // back untruncated.
    expect(await fullExtractedText(world.alice.caller, docId)).toContain(docx.marker)
  })

  it('🔴 reaches `ready` — a DOCX rejoins the very ingest a PDF uses', async () => {
    const state = await pollUntil(
      'the DOCX ingest to reach a terminal state',
      () => docState(world.alice.caller, docId),
      (s) => TERMINAL.has(String(s.ingestStatus)),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )
    expect(state.ingestStatus).toBe('ready')
    // As for the PDF: `ingestId` is the key ai-service echoes back, so it is the
    // proof that `ready` was reported by the service rather than assumed here.
    expect(typeof state.ingestId).toBe('string')
    expect(state.ingestId).toBeTruthy()
  })
})
