/**
 * 🔴 `clearLegacyHeldText` (ola 11, item 4) on a real Postgres (every
 * migration, no Payload boot):
 *   · dry run lists ids and writes nothing;
 *   · apply NULLs `held_text` / `held_text_hash` only on `content` holds whose
 *     model never ran, and leaves org 8, consent-held rows, other reasons,
 *     other stages and non-held rows exactly as they were;
 *   · no log line carries text.
 *
 * Harness: `lib/testing/realPostgres`. No docker → SKIP.
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearLegacyHeldText } from './clearLegacyHeldText'
import { dockerOk, rowsOf, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
const NEVER = 'content: La revisión automática no pudo terminar (red). Todavía no se agregó a la búsqueda.'
const RAW = 'Vino Gumersinda Talavera a la clínica.'

const state = async () =>
  rowsOf(pg.db, sql`SELECT id, held_text AS t, held_text_hash AS h, anonymisation_status AS s, anonymisation_error AS e
                      FROM documents ORDER BY id`)

describe.skipIf(!dockerOk)('clearLegacyHeldText (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-clear-held-text-${process.pid}`, 'clear_held_text')
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  beforeEach(async () => {
    await pg.db.execute(sql.raw(`TRUNCATE documents, organizations, users RESTART IDENTITY CASCADE`))
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'u@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (6, 'Seis', 'seis'), (8, 'Ocho', 'ocho'), (9, 'Nueve', 'nueve');
    `))
    const ins = (id: number, org: number, status: string, error: string, text: string | null, held = false) =>
      pg.db.execute(sql`
        INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, publication_status,
                               anonymisation_status, anonymisation_error, held_text, held_text_hash, consent_held)
        VALUES (${id}, ${org}, 1, 'x', 'pdf', 'testimonio', 'draft', ${status}, ${error}, ${text},
                ${text === null ? null : 'h-' + id}, ${held})`)
    await ins(1, 6, 'held', NEVER, RAW) // ✔ cleared
    await ins(2, 9, 'held', NEVER, RAW) // ✔ cleared
    await ins(3, 8, 'held', NEVER, RAW) // org 8: never
    await ins(4, 6, 'held', NEVER, RAW, true) // consent held: never
    await ins(5, 6, 'held', 'verify: La segunda revisión automática no pudo terminar (red). x', RAW) // other stage
    await ins(6, 6, 'held', 'content: La revisión automática señaló un dato que no se pudo ubicar en el texto. x', RAW) // other reason
    await ins(7, 6, 'rejected', NEVER, RAW) // not held
    await ins(8, 6, 'held', NEVER, null) // post-P-01: nothing to clear
  }, 60_000)

  it('dry run lists the ids and writes nothing, and logs no text', async () => {
    const before = await state()
    const lines: string[] = []
    const report = await clearLegacyHeldText(pg.db, { apply: false, log: (l) => lines.push(l) })
    expect(report).toMatchObject({ apply: false, ids: [1, 2], cleared: 0 })
    expect(await state()).toEqual(before)
    expect(lines.join('\n')).not.toContain('Gumersinda')
  })

  it('🔴 apply clears only the legacy model-never-ran holds; org 8, consent-held and other reasons untouched', async () => {
    const before = await state()
    const lines: string[] = []
    const report = await clearLegacyHeldText(pg.db, { apply: true, log: (l) => lines.push(l) })
    expect(report).toMatchObject({ apply: true, ids: [1, 2], cleared: 2, clearedIds: [1, 2] })
    const after = await state()
    for (const r of after) {
      const was = before.find((b) => b.id === r.id)!
      if (r.id === 1 || r.id === 2) {
        expect(r).toEqual({ ...was, t: null, h: null })
      } else {
        expect(r).toEqual(was)
      }
    }
    expect(lines.filter((l) => l.endsWith('held_text cleared'))).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('Gumersinda')
    // A second run finds nothing.
    expect((await clearLegacyHeldText(pg.db, { apply: true })).ids).toEqual([])
  })

  it('one ecosistema only; org 8 stays excluded even when named', async () => {
    expect((await clearLegacyHeldText(pg.db, { apply: false, organizationId: 9 })).ids).toEqual([2])
    expect((await clearLegacyHeldText(pg.db, { apply: true, organizationId: 8 })).cleared).toBe(0)
    expect((await state()).find((r) => r.id === 3)!.t).toBe(RAW)
  })
})
