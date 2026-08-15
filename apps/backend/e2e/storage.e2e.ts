/**
 * OBJECT STORAGE, THROUGH THE APP.
 *
 * 🔴 THE PROPERTY UNDER TEST IS "NO PRESIGNED URLS, EVER". `lib/storage/plugin.ts`
 * lists four ordinary-looking plugin options that would each turn a served file
 * into a redirect to a bucket URL that outlives the access check by up to two
 * hours. None of them fails loudly, and none of them changes a single assertion
 * in a unit test. The only way to know is to ask the running server for a file
 * and look at the status code — which is what this file does, with
 * `redirect: 'manual'` so a 302 cannot be silently followed.
 *
 * The rest of the file proves the bytes actually round-trip: what went up comes
 * back, byte for byte, including under a Range request.
 */

import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import { anonymous, apiGet, apiJson, fixtureBytes, pollUntil, uploadFixture } from './support/api'
import { BACKEND_URL } from './support/env'
import { stackDown } from './support/stack'
import { provisionWorld, type World } from './support/world'

const FIXTURE = 'es-clip.mp3'
/** The second block publishes a real document, and only ingestable kinds can be. */
const PDF_FIXTURE = 'e2e-sample.pdf'

describe.skipIf(stackDown)('object storage', () => {
  let world: World
  let filename: string
  let mediaId: number
  let bytes: Buffer

  beforeAll(async () => {
    world = await provisionWorld()
    bytes = fixtureBytes(FIXTURE)
    const up = await uploadFixture(
      world.alice.caller,
      FIXTURE,
      'audio/mpeg',
      `${world.ns}-storage.mp3`,
    )
    expect(up.status).toBe(201)
    mediaId = up.body.doc.id
    filename = up.body.doc.filename
  }, 120_000)

  it('stamps the uploader and an operability prefix, and never trusts the body', async () => {
    const res = await apiGet(world.alice.caller, `/api/media/${mediaId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.uploadedBy).toBe(world.alice.id)
    // alice belongs to exactly one ecosistema, so the best-effort label is filled.
    expect(res.body.organization).toBe(world.orgA.id)
    // ⚠ Operability only — NOT an access boundary. Asserted because the serve
    // route rebuilds the object key from it: a stale value 404s a file that is
    // sitting intact in the bucket.
    expect(res.body.prefix).toBe(`eco_${world.orgA.id}/u_${world.alice.id}`)
    expect(res.body.filesize).toBe(bytes.length)
  })

  it('the app-relative URL points back at this app, not at the bucket', async () => {
    const res = await apiGet(world.alice.caller, `/api/media/${mediaId}?depth=0`)
    // `generateFileURL` is unset, so `url` must stay app-relative. A bucket or
    // CDN origin here would mean nobody authenticates the download.
    expect(res.body.url.startsWith('/api/media/file/')).toBe(true)
    expect(res.body.url).not.toMatch(/^https?:\/\//)
  })

  it('🔴 serves the bytes THROUGH the app — 200, never a redirect to a presigned URL', async () => {
    const res = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: { Authorization: `JWT ${world.alice.caller.token}` },
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    // Any 3xx here means `signedDownloads` (or a redirecting adapter) crept in.
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('content-type')).toContain('audio/mpeg')

    const served = Buffer.from(await res.arrayBuffer())
    expect(served.length).toBe(bytes.length)
    // Byte-for-byte, not just the right length: this is the round-trip assertion.
    expect(createHash('sha256').update(served).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
  })

  it('🔴 a RANGED request returns 206 with a correct Content-Range and the right bytes', async () => {
    // Range support is what makes an <audio> element seekable. It comes from the
    // S3 adapter's static handler, so it only exists if the handler really is in
    // the request path — which is the same fact the redirect assertion checks.
    const res = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: { Authorization: `JWT ${world.alice.caller.token}`, Range: 'bytes=100-199' },
      redirect: 'manual',
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${bytes.length}`)
    expect(res.headers.get('content-length')).toBe('100')

    const slice = Buffer.from(await res.arrayBuffer())
    expect(slice.length).toBe(100)
    expect(slice.equals(bytes.subarray(100, 200))).toBe(true)
  })

  it('a suffix range (the last N bytes) also comes back as 206', async () => {
    const res = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: { Authorization: `JWT ${world.alice.caller.token}`, Range: 'bytes=-50' },
      redirect: 'manual',
    })
    expect(res.status).toBe(206)
    const slice = Buffer.from(await res.arrayBuffer())
    expect(slice.length).toBe(50)
    expect(slice.equals(bytes.subarray(bytes.length - 50))).toBe(true)
  })

  it('🔴 an unauthorized caller is refused — and gets no bytes and no redirect', async () => {
    // carol is in another ecosistema; the file belongs to a document that is not
    // published anywhere she can see.
    const asCarol = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: { Authorization: `JWT ${world.carol.caller.token}` },
      redirect: 'manual',
    })
    expect(asCarol.status).toBe(403)
    expect(asCarol.headers.get('location')).toBeNull()
    const body = Buffer.from(await asCarol.arrayBuffer())
    expect(body.equals(bytes)).toBe(false)

    // bob is a COLLEAGUE in the same ecosistema. The file is still not attached
    // to anything published, so it is still uploader-only.
    const asBob = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: { Authorization: `JWT ${world.bob.caller.token}` },
      redirect: 'manual',
    })
    expect(asBob.status).toBe(403)

    const anon = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, { redirect: 'manual' })
    expect(anon.status).toBe(403)
    expect(anon.headers.get('location')).toBeNull()
  })

  it('the media ROW is invisible to everyone but the uploader', async () => {
    expect((await apiGet(world.carol.caller, `/api/media/${mediaId}`)).status).toBe(404)
    expect((await apiGet(world.bob.caller, `/api/media/${mediaId}`)).status).toBe(404)
    expect((await apiGet(anonymous, `/api/media/${mediaId}`)).status).toBe(403)
  })

  it('nobody but the uploader can delete or re-point a file', async () => {
    const del = await apiJson(world.bob.caller, 'DELETE', `/api/media/${mediaId}`)
    expect(del.status).toBeGreaterThanOrEqual(400)

    // ⚠ `uploadedBy` is the whole of the unconditional read clause. Re-pointing
    // it is the two-step version of stealing a file.
    const patch = await apiJson(world.alice.caller, 'PATCH', `/api/media/${mediaId}`, {
      uploadedBy: world.bob.id,
      alt: `${world.ns} etiqueta`,
    })
    // ⚠ EXACTLY 200. The rule is "the write is accepted and the privileged field
    // is ignored", and a loose `toBeLessThan(500)` cannot tell that apart from a
    // media PATCH path that is broken for everyone — which is precisely the bug
    // that hid in the equivalent assertion on `documents`.
    expect(patch.status).toBe(200)
    const after = await apiGet(world.alice.caller, `/api/media/${mediaId}?depth=0`)
    expect(after.status).toBe(200)
    // The ordinary field landed…
    expect(after.body.alt).toBe(`${world.ns} etiqueta`)
    // …and the one that decides who may read the bytes did not.
    expect(after.body.uploadedBy).toBe(world.alice.id)
  })

  it('refuses a file type that is not on the allowlist', async () => {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('#!/bin/sh\necho no')], { type: 'application/x-sh' }), `${world.ns}.sh`)
    const res = await fetch(`${BACKEND_URL}/api/media`, {
      method: 'POST',
      headers: { Authorization: `JWT ${world.alice.caller.token}` },
      body: form,
      redirect: 'manual',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// 🔴 The POSITIVE half of the file rule, and its revocation
// ---------------------------------------------------------------------------

/**
 * 🔴 THE OTHER HALF OF `mediaVisibleToCaller`, WHICH NOTHING ELSE EXERCISES.
 *
 * The block above proves the DENY side: a colleague cannot fetch a file behind
 * an unpublished document. A rule that only ever denies is trivially satisfied
 * by `return false`, so the deny tests alone would keep passing on a build where
 * published attachments had become undownloadable for everybody — a silent,
 * total loss of the sharing feature with no error anywhere.
 *
 * This block drives the whole cycle against the live stack:
 *
 *   draft      → colleague 403, uploader 200
 *   published  → colleague 200 WITH THE BYTES, uploader still 200
 *   draft again→ colleague 403 again
 *
 * ⚠ THE THIRD STEP IS THE ONE THAT MATTERS MOST. Unpublishing is the product's
 * "stop sharing this". If the row flips back to `draft` but the FILE stays
 * fetchable, the feature is a lie — and nothing about the document row's own
 * visibility would show it, because that half does flip correctly.
 *
 * ⚠ SLOW ON PURPOSE. It uploads, ingests, publishes and unpublishes for real —
 * `mediaVisibleToCaller` resolves the shared clause by QUERYING `documents` for
 * what the ecosistema has published, so nothing short of a real publish exercises
 * it. Its own world, so it cannot be perturbed by the block above.
 */
describe.skipIf(stackDown)('a published document\'s file follows its document', () => {
  let world: World
  let filename: string
  let bytes: Buffer
  let docId: number

  async function fileAs(caller: { token: string }): Promise<{ status: number; body: Buffer; location: string | null }> {
    const res = await fetch(`${BACKEND_URL}/api/media/file/${filename}`, {
      headers: caller.token ? { Authorization: `JWT ${caller.token}` } : {},
      redirect: 'manual',
    })
    return {
      status: res.status,
      body: Buffer.from(await res.arrayBuffer()),
      location: res.headers.get('location'),
    }
  }

  beforeAll(async () => {
    world = await provisionWorld()
    bytes = fixtureBytes(PDF_FIXTURE)

    const up = await uploadFixture(
      world.alice.caller,
      PDF_FIXTURE,
      'application/pdf',
      `${world.ns}-shared.pdf`,
    )
    expect(up.status).toBe(201)
    filename = up.body.doc.filename

    const doc = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      name: `${world.ns} pdf compartido`,
      kind: 'pdf',
      mode: 'rag-retrieve',
      mediaFile: up.body.doc.id,
    })
    expect(doc.status).toBe(201)
    docId = doc.body.doc.id

    // Publishing needs `extractedText`, so the ingest has to land first.
    await pollUntil(
      'the shared PDF to finish ingesting',
      async () => (await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)).body,
      (d: { ingestStatus?: string }) => d.ingestStatus === 'ready' || d.ingestStatus === 'failed',
      { timeoutMs: 120_000, intervalMs: 1500 },
    )
  }, 180_000)

  it('while it is a draft, only the uploader can fetch the file', async () => {
    const mine = await fileAs(world.alice.caller)
    expect(mine.status).toBe(200)
    expect(mine.body.equals(bytes)).toBe(true)
    expect((await fileAs(world.bob.caller)).status).toBe(403)
  })

  it('🔴 once published, a COLLEAGUE gets the real bytes — still through the app', async () => {
    const started = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/publish`)
    expect(started.status).toBe(202)
    await pollUntil(
      'the publish to settle before checking file access',
      async () => (await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)).body,
      (d: { publicationStatus?: string; publicationError?: string | null }) =>
        d.publicationStatus === 'published' || Boolean(d.publicationError),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )

    const asBob = await fileAs(world.bob.caller)
    expect(asBob.status).toBe(200)
    // ⚠ The bytes, not just the status: a 200 with an empty or wrong body would
    // be a broken share that reads as a working one.
    expect(asBob.body.equals(bytes)).toBe(true)
    // Still no presigned URL, on the shared path as well as the private one.
    expect(asBob.location).toBeNull()

    // …and the ecosistema boundary is untouched by publication.
    expect((await fileAs(world.carol.caller)).status).toBe(403)
    expect((await fileAs({ token: '' })).status).toBe(403)
  })

  it('🔴 unpublishing REVOKES the colleague\'s access to the file, not just to the row', async () => {
    const started = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/unpublish`)
    expect(started.status).toBe(202)
    await pollUntil(
      'the unpublish to settle',
      async () => (await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)).body,
      (d: { publicationStatus?: string; publicationError?: string | null }) =>
        d.publicationStatus === 'draft' || Boolean(d.publicationError),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )

    const asBob = await fileAs(world.bob.caller)
    expect(asBob.status).toBe(403)
    expect(asBob.body.equals(bytes)).toBe(false)
    // The uploader never lost it, in either direction.
    expect((await fileAs(world.alice.caller)).status).toBe(200)
  })
})
