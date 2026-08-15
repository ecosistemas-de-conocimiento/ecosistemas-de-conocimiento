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

import { anonymous, apiGet, apiJson, fixtureBytes, uploadFixture } from './support/api'
import { BACKEND_URL } from './support/env'
import { stackDown } from './support/stack'
import { provisionWorld, type World } from './support/world'

const FIXTURE = 'es-clip.mp3'

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
    })
    const after = await apiGet(world.alice.caller, `/api/media/${mediaId}?depth=0`)
    expect(after.status).toBe(200)
    expect(after.body.uploadedBy).toBe(world.alice.id)
    expect(patch.status).toBeLessThan(500)
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
