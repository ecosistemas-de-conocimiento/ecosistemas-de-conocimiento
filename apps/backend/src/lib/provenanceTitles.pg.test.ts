/**
 * 🔴 `scripts/backfill-provenance-titles.ts` — AGAINST A REAL POSTGRES.
 *
 *   · a saved answer citing a gated documento by its raw name gets
 *     `documentTitleFor(row)` in that citation's `metadata.title`, both
 *     provenance shapes (`{ chunks }` and the older bare array);
 *   · an ungated documento, a testimonio: untouched (a differing title is
 *     only counted); a message citing a consent-held row: untouched;
 *   · a dry run writes nothing; a second apply writes nothing;
 *   · the rest of the provenance JSON, `updated_at` and every other column are
 *     unchanged.
 *
 * Harness: `lib/testing/realPostgres` (migrations only, no Payload boot).
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { backfillProvenanceTitles } from './provenanceTitles'
import { dockerOk, rowsOf, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
const run = (s: string) => pg.db.execute(sql.raw(s))
const q = (s: string) => rowsOf(pg.db, sql.raw(s))

const RAW = 'Entrevista Juana Perez.pdf'
const chunk = (i: number, docId: string, title: string, extra: Record<string, unknown> = {}) => ({
  chunkId: `c-${i}`,
  documentId: `00000000-0000-0000-0000-00000000000${i}`,
  score: 0.5 + i / 100,
  corpus: 'eco-6',
  ordinal: i + 1,
  text: `pasaje ${i}`,
  metadata: { title, docId, publication: 'published', ...extra },
})
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`

const M = { mixed: 1, bare: 2, open: 3, held: 4, right: 5, elsewhere: 6, missing: 7 }

describe.skipIf(!dockerOk)('backfill provenance titles', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-provenance-titles-${process.pid}`, 'provenance_titles')
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  beforeEach(async () => {
    await run(`
      DROP TABLE IF EXISTS before_backfill;
      TRUNCATE messages, sessions, documents, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'a@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (6, 'Seis', 'seis'), (8, 'Ocho', 'ocho');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (60, 1, 6), (80, 1, 8);
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, publication_status, consent_held, anonymisation_report) VALUES
        (101, 6, 1, '${RAW}',             'pdf',   'documento',  true,  'published', false, NULL),
        (102, 6, 1, 'Otra Persona.pdf',   'pdf',   'documento',  true,  'published', false, '{"redactedTitle":"Entrevista a [Persona A].pdf"}'),
        (103, 6, 1, 'Libro abierto.pdf',  'pdf',   'documento',  false, 'published', false, NULL),
        (104, 6, 1, 'Voz de alguien.mp3', 'audio', 'testimonio', false, 'published', false, NULL),
        (105, 6, 1, 'Nula Persona.pdf',   'pdf',   'documento',  NULL,  'published', false, NULL),
        (801, 8, 1, 'Taller Persona.pdf', 'pdf',   'documento',  true,  'draft',     true,  NULL),
        (802, 8, 1, 'Taller Otra.pdf',    'pdf',   'documento',  true,  'published', false, NULL);
      INSERT INTO messages (id, session_id, role, content, generation_meta, provenance, updated_at) VALUES
        (${M.mixed}, 60, 'assistant', 'Respuesta [1][2][3].', '{"traceId":"t1"}', ${lit({
          chunks: [chunk(0, '101', RAW), chunk(1, '103', 'Libro abierto.pdf'), chunk(2, '104', 'Testimonio', { kind: 'testimonio' })],
        })}, '2026-11-01T10:00:00Z'),
        (${M.bare}, 60, 'assistant', 'Respuesta [1][2].', NULL, ${lit([
          chunk(0, '102', 'Otra Persona.pdf'),
          chunk(1, '105', 'Nula Persona.pdf'),
        ])}, '2026-11-01T10:00:00Z'),
        (${M.open}, 60, 'assistant', 'Respuesta [1].', NULL, ${lit({ chunks: [chunk(0, '103', 'Libro viejo.pdf')] })}, '2026-11-01T10:00:00Z'),
        (${M.held}, 80, 'assistant', 'Respuesta [1][2].', NULL, ${lit({
          chunks: [chunk(0, '801', 'Taller Persona.pdf'), chunk(1, '802', 'Taller Otra.pdf')],
        })}, '2026-11-01T10:00:00Z'),
        (${M.right}, 60, 'assistant', 'Respuesta [1].', NULL, ${lit({ chunks: [chunk(0, '101', 'Documento')] })}, '2026-11-01T10:00:00Z'),
        (${M.elsewhere}, 60, 'assistant', 'Según ${RAW} [1].', ${lit({ note: RAW })}, ${lit({ chunks: [chunk(0, '101', RAW)] })}, '2026-11-01T10:00:00Z'),
        (${M.missing}, 60, 'assistant', 'Respuesta [1].', NULL, ${lit({ chunks: [chunk(0, '999', 'Borrado.pdf')] })}, '2026-11-01T10:00:00Z');
      CREATE TABLE before_backfill AS SELECT * FROM messages;
    `)
  }, 60_000)

  /** Messages whose row differs from the snapshot in any column. */
  const changedIds = async () =>
    (
      await q(`SELECT m.id FROM messages m JOIN before_backfill b USING (id)
                WHERE (to_jsonb(m) - 'provenance')::text <> (to_jsonb(b) - 'provenance')::text
                   OR m.provenance::text <> b.provenance::text ORDER BY m.id`)
    ).map((r) => Number(r.id))

  const titleAt = async (id: number, path: string) =>
    (await q(`SELECT provenance #>> '${path}' AS t FROM messages WHERE id = ${id}`))[0]?.t

  it('a dry run reports ids and counts and writes nothing', async () => {
    const report = await backfillProvenanceTitles(pg.db, { apply: false, batchSize: 2 })
    expect(report.stale).toEqual([M.mixed, M.bare, M.elsewhere])
    expect(report.staleCitations).toBe(4)
    expect(report.written).toEqual([])
    expect(report.consentHeld).toEqual([M.held])
    expect(report.openStale).toEqual({ documento: 1, testimonio: 0, conversacion: 0, other: 0 })
    expect(report.missingDocument).toBe(1)
    expect(report.titleElsewhere).toEqual([M.elsewhere])
    expect(report.scanned).toBe(7)
    expect(JSON.stringify(report)).not.toMatch(/Juana|Persona|\.pdf/)
    expect(await changedIds()).toEqual([])
  })

  it('🔴 apply rewrites only gated citation titles; everything else is byte-identical; a second apply writes nothing', async () => {
    const report = await backfillProvenanceTitles(pg.db, { apply: true, batchSize: 2 })
    expect(report.written).toEqual([M.mixed, M.bare, M.elsewhere])
    expect(await changedIds()).toEqual([M.mixed, M.bare, M.elsewhere])

    expect(await titleAt(M.mixed, '{chunks,0,metadata,title}')).toBe('Documento')
    expect(await titleAt(M.mixed, '{chunks,1,metadata,title}')).toBe('Libro abierto.pdf')
    expect(await titleAt(M.mixed, '{chunks,2,metadata,title}')).toBe('Testimonio')
    expect(await titleAt(M.bare, '{0,metadata,title}')).toBe('Entrevista a [Persona A].pdf')
    expect(await titleAt(M.bare, '{1,metadata,title}')).toBe('Documento')
    expect(await titleAt(M.elsewhere, '{chunks,0,metadata,title}')).toBe('Documento')

    // Byte-identical once the rewritten titles are taken out, and the free text is left alone.
    const same = await q(`
      SELECT m.id, (m.provenance #- p)::text = (b.provenance #- p)::text AS rest_same
        FROM messages m JOIN before_backfill b USING (id)
        CROSS JOIN LATERAL (SELECT CASE m.id WHEN ${M.bare} THEN '{0,metadata,title}'::text[]
                                             ELSE '{chunks,0,metadata,title}'::text[] END AS p) x
       WHERE m.id IN (${M.mixed}, ${M.elsewhere})
      UNION ALL
      SELECT m.id, ((m.provenance #- '{0,metadata,title}') #- '{1,metadata,title}')::text
                 = ((b.provenance #- '{0,metadata,title}') #- '{1,metadata,title}')::text
        FROM messages m JOIN before_backfill b USING (id) WHERE m.id = ${M.bare}`)
    expect(same.every((r) => r.rest_same === true)).toBe(true)
    expect(same).toHaveLength(3)
    const elsewhere = (await q(`SELECT content, generation_meta::text AS meta FROM messages WHERE id = ${M.elsewhere}`))[0]!
    expect(String(elsewhere.content)).toContain(RAW)
    expect(String(elsewhere.meta)).toContain(RAW)

    const snapshot = await q(`SELECT id, provenance::text AS p, updated_at FROM messages ORDER BY id`)
    const again = await backfillProvenanceTitles(pg.db, { apply: true, batchSize: 2 })
    expect(again.stale).toEqual([])
    expect(again.written).toEqual([])
    expect(await q(`SELECT id, provenance::text AS p, updated_at FROM messages ORDER BY id`)).toEqual(snapshot)
  })

  it('🔴 a message citing a consent-held row is untouched, even its other gated citations', async () => {
    await backfillProvenanceTitles(pg.db, { apply: true })
    expect(await titleAt(M.held, '{chunks,1,metadata,title}')).toBe('Taller Otra.pdf')
    expect(await changedIds()).not.toContain(M.held)
    expect(await changedIds()).not.toContain(M.open)
  })

  it('PROVENANCE_ORG keeps to that ecosistema', async () => {
    const report = await backfillProvenanceTitles(pg.db, { apply: true, organizationId: 8 })
    expect(report.scanned).toBe(1)
    expect(report.written).toEqual([])
    expect(await changedIds()).toEqual([])
  })
})
