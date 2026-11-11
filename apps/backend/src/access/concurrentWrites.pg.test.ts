/**
 * 🔴 ONE MEMBER'S BURST OF WRITES ALL LANDS — AGAINST A REAL POSTGRES.
 *
 * Each write holds a pool connection for its transaction. A read inside it
 * without `req` asked for a second; past the pool's 10 connections the
 * writes waited on each other until the checkout timeout (`lib/dbPool.ts`)
 * failed them. 12 new chats at once from one member: 2 answered, 10 failed
 * at 10.1 s (measured by the auditor 2026-11-10, before the fix).
 *
 * This suite on d0457ee5 (before the fix): 0/12 chats, 3/16 ratings, 2/16
 * uploads, the rest failed at 10.0-10.1 s. After: all of them, each burst
 * done in 0.1-0.6 s (measured 2026-11-10 on torre, 16 cores, load average
 * about 2, real Postgres in docker, one run each).
 *
 * Through Payload's REST router, as the web sends them. Timings are printed
 * (`[burst]`), so a run doubles as the measurement. `oneConnection.pg.test.ts`
 * is the per-write guard; this is the load it stands for.
 */

import { rmSync } from 'node:fs'
import path from 'node:path'

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'burst-pw'
const MEDIA_DIR = path.resolve(process.cwd(), 'media')
const written: string[] = []
/** About 10× the slowest fixed burst (0.55 s, above); a failed checkout takes 10 s. */
const BOUND_MS = 8_000

let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
let token: string

async function rest(method: string, url: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = { Authorization: `JWT ${token}` }
  let sent: BodyInit | undefined
  if (body instanceof FormData) sent = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    sent = JSON.stringify(body)
  }
  return handleEndpoints({ config, request: new Request(`http://localhost${url}`, { method, headers, body: sent }) })
}

/** All at once; each one's status and its own time. */
async function burst(n: number, one: (i: number) => Promise<Response>) {
  const started = Date.now()
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const t0 = Date.now()
      const res = await one(i)
      const text = await res.text()
      return { status: res.status, ms: Date.now() - t0, text }
    }),
  )
  const ms = results.map((r) => r.ms).sort((a, b) => a - b)
  return { results, total: Date.now() - started, max: ms[ms.length - 1]!, median: ms[Math.floor(ms.length / 2)]! }
}

const report = (what: string, b: Awaited<ReturnType<typeof burst>>) =>
  console.info(
    `[burst] ${what}: ${b.results.filter((r) => r.status < 300).length}/${b.results.length} ok, ` +
      `total ${b.total} ms, median ${b.median} ms, max ${b.max} ms`,
  )

describe.skipIf(!dockerOk)('one member’s burst of writes', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-burst-${process.pid}`, 'burst')
    payload = await bootPayload(pg.url, 'burst-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, display_name) VALUES (1, 'memo@example.invalid', 'Memo');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
      INSERT INTO sessions (id, user_id, organization_id, kind, title) VALUES (1, 1, 1, 'generales', 'Chat');
      INSERT INTO messages (id, session_id, role, content, corpus_status)
        SELECT g, 1, 'assistant', 'Respuesta ' || g, 'pending' FROM generate_series(1, 16) g;
    `))
    for (const t of await rowsOf(pg.db, sql`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`)) {
      await pg.db.execute(sql.raw(`SELECT setval('"${String(t.sequencename)}"', 1000)`))
    }
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
    const { handleEndpoints } = await import('payload')
    const login = await handleEndpoints({
      config,
      request: new Request('http://localhost/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'memo@example.invalid', password: PASSWORD }),
      }),
    })
    token = ((await login.json()) as { token: string }).token
  }, 120_000)

  afterAll(async () => {
    for (const f of written) rmSync(path.join(MEDIA_DIR, f), { force: true })
    await shutdown(pg, payload)
  })

  it('12 new chats at once', async () => {
    const b = await burst(12, () => rest('POST', '/api/sessions', { organization: 1, kind: 'generales' }))
    report('12 new chats', b)
    expect(b.results.map((r) => r.status), b.results.map((r) => r.text.slice(0, 200)).join('\n')).toEqual(Array(12).fill(201))
    expect(b.max).toBeLessThan(BOUND_MS)
  }, 60_000)

  it('16 ratings at once, one per answer', async () => {
    const b = await burst(16, (i) => rest('POST', '/api/ratings', { message: i + 1, stars: 4 }))
    report('16 ratings', b)
    expect(b.results.map((r) => r.status), b.results.map((r) => r.text.slice(0, 200)).join('\n')).toEqual(Array(16).fill(201))
    expect(b.max).toBeLessThan(BOUND_MS)
  }, 60_000)

  it('16 uploads at once (file, then its document)', async () => {
    const b = await burst(16, async (i) => {
      const form = new FormData()
      form.append('file', new Blob([`# Nota ${i}\n\nTexto.\n`], { type: 'text/markdown' }), `nota-${i}.md`)
      const media = await rest('POST', '/api/media', form)
      if (media.status !== 201) return media
      const doc = ((await media.json()) as { doc: { id: number; filename: string } }).doc
      written.push(doc.filename)
      return rest('POST', '/api/documents', {
        session: [1],
        kind: 'markdown',
        contentKind: 'documento',
        mode: 'rag-retrieve',
        name: `nota-${i}.md`,
        mediaFile: doc.id,
        ingestStatus: 'pending',
      })
    })
    report('16 uploads', b)
    expect(b.results.map((r) => r.status), b.results.map((r) => r.text.slice(0, 200)).join('\n')).toEqual(Array(16).fill(201))
    expect(b.max).toBeLessThan(BOUND_MS)
  }, 60_000)
})
