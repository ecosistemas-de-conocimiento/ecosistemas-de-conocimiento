/**
 * 🔴 C-12 (audit 2026-11-10): an upload's stored filename, and so its object
 * key, carry nothing of the name the person gave the file. Real Payload on a
 * throwaway Postgres (`lib/testing/realPostgres.ts`), the upload through
 * Payload's real REST router as the web sends it, files on local disk.
 *
 * ⚠ No docker → the suite SKIPS.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import {
  bootPayload,
  dockerOk,
  eventually,
  rowsOf,
  shutdown,
  startRealPostgres,
  type RealPostgres,
} from '@/lib/testing/realPostgres'

import { neutralMediaFilename } from './Media'
import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'

const PASSWORD = 'neutral-name-test-pw'
// Payload's default `staticDir` for `media` is the slug, relative to cwd.
const MEDIA_DIR = path.resolve(process.cwd(), 'media')
const ORIGINAL = `Entrevista a Rosa Martínez ${process.pid}.md`
const BODY = '# Notas\n\nLa reunión fue en el salón comunal.\n'
const NEUTRAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/

let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const written: string[] = []

async function rest(method: string, url: string, token: string, body?: BodyInit): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  return handleEndpoints({
    config,
    request: new Request(`http://localhost${url}`, { method, headers: { Authorization: `JWT ${token}` }, body }),
  })
}

async function token(): Promise<string> {
  const { token } = await payload.login({ collection: 'users', data: { email: 'neutral@example.invalid', password: PASSWORD } })
  if (!token) throw new Error('login returned no token')
  return token
}

/** Every word of the original name, lowercased and without accents. */
const nameParts = ORIGINAL.replace(/\.md$/, '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .split(/\s+/)
  .filter((w) => w.length > 1)

describe('neutralMediaFilename', () => {
  it('keeps a listed extension, else the mime type’s, and nothing of the name', () => {
    expect(neutralMediaFilename('Testimonio de M.Lopez', 'audio/mp4')).toMatch(/^[0-9a-f-]{36}\.m4a$/)
    expect(neutralMediaFilename('Entrevista.PDF', 'application/pdf')).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(neutralMediaFilename('Grabación 2026-11-10.webm', 'video/webm')).toMatch(/^[0-9a-f-]{36}\.webm$/)
    expect(neutralMediaFilename('sin extension', null)).toMatch(/^[0-9a-f-]{36}$/)
    expect(neutralMediaFilename('a.md', 'text/markdown')).not.toBe(neutralMediaFilename('a.md', 'text/markdown'))
  })
})

describe.skipIf(!dockerOk)('upload filename on a real Postgres', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-media-neutral-${process.pid}`, 'media_neutral')
    payload = await bootPayload(pg.url, 'media-neutral-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'neutral@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
    `))
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 120_000)

  afterAll(async () => {
    for (const f of written) rmSync(path.join(MEDIA_DIR, f), { force: true })
    await shutdown(pg, payload)
  })

  it('🔴 a new upload’s filename and key carry no part of the original name; download and extraction still work', async () => {
    const jwt = await token()
    const form = new FormData()
    form.append('file', new Blob([BODY], { type: 'text/markdown' }), ORIGINAL)
    const res = await rest('POST', '/api/media', jwt, form)
    expect(res.status).toBe(201)
    const id = ((await res.json()) as { doc: { id: number } }).doc.id

    const [row] = await rowsOf(pg.db, sql`SELECT filename, prefix FROM media WHERE id = ${id}`)
    const filename = String(row?.filename)
    written.push(filename)
    expect(filename).toMatch(NEUTRAL)
    // The key every reader rebuilds: `{prefix}/{filename}`.
    const key = `${String(row?.prefix)}/${filename}`.toLowerCase()
    expect(key).toBe(`eco_1/u_1/${filename}`)
    for (const part of nameParts) expect(key, part).not.toContain(part)

    // The bytes are where the row says, and nowhere under the original name.
    expect(readFileSync(path.join(MEDIA_DIR, filename), 'utf8')).toBe(BODY)
    expect(existsSync(path.join(MEDIA_DIR, ORIGINAL))).toBe(false)

    // Download: the serve route finds the file by the stored name.
    const file = await rest('GET', `/api/media/file/${encodeURIComponent(filename)}`, jwt)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe(BODY)

    // Read: a document on that file extracts its text.
    const owner = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    const doc = await payload.create({
      collection: 'documents',
      data: { uploadConsentVersion: UPLOAD_CONSENT_VERSION, name: 'Entrevista', kind: 'markdown', ingestStatus: 'pending', mediaFile: id } as never,
      overrideAccess: false,
      user: owner,
    })
    const extracted = async () =>
      String((await rowsOf(pg.db, sql`SELECT extracted_text AS t FROM documents WHERE id = ${doc.id}`))[0]?.t ?? '')
    expect(await eventually(async () => (await extracted()).includes('salón comunal'), 15_000)).toBe(true)
  }, 60_000)
})
