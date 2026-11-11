/**
 * 🔴 `cleanStoredReasons` (what `scripts/clean-stored-errors.ts` runs) —
 * AGAINST A REAL POSTGRES: dry run writes nothing, apply rewrites only the
 * rows holding database error text (every reason column), a second apply
 * changes nothing. The report carries ids, never text.
 *
 * Harness: `lib/testing/realPostgres` (migrations only, no Payload boot).
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { cleanStoredReasons, safeStoredReason } from './storedReason'
import { dockerOk, rowsOf, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
const NAMES = /Juana Perez|Milpa Alta/

/** Every reason column of every row, as one comparable snapshot. */
const snapshot = async () =>
  rowsOf(
    pg.db,
    sql`SELECT 'd' || id AS k, ingest_error AS a, publication_error AS b, anonymisation_error AS c, graph_error AS e, updated_at::text AS u FROM documents
        UNION ALL SELECT 'm' || id, corpus_error, NULL, NULL, NULL, updated_at::text FROM messages
        UNION ALL SELECT 'r' || id, gate_reason, NULL, NULL, NULL, updated_at::text FROM anonymisation_reviews
        UNION ALL SELECT 'e' || id, error, NULL, NULL, NULL, updated_at::text FROM eval_runs
        ORDER BY k`,
  )

describe.skipIf(!dockerOk)('clean-stored-errors (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-clean-errors-${process.pid}`, 'clean_errors')
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE anonymisation_reviews, eval_runs, messages, sessions, documents, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'subio@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, ingest_error, publication_error, anonymisation_error, graph_error) VALUES
        (11, 1, 1, 'a.pdf', 'pdf', E'ingest_failed: Failed query: update "documents" set "extracted_text" = $1\\nparams: Juana Perez,11', NULL, NULL, NULL),
        (12, 1, 1, 'b.pdf', 'pdf', 'no_audio_stream: the file has no audio', E'Failed query: select 1\\nparams: Milpa Alta', NULL, NULL),
        (13, 1, 1, 'c.pdf', 'pdf', NULL, NULL, 'verify: 2 nombres', E'graph_failed: duplicate key value violates unique constraint "x" Key (name)=(Juana Perez) already exists.'),
        (14, 1, 1, 'd.pdf', 'pdf', 'ingest_failed: [database error text withheld]', 'publish_failed: timeout', NULL, NULL);
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO messages (id, session_id, role, content, corpus_error) VALUES
        (21, 10, 'user', 'q', E'ingest_failed: Failed query: insert\\nparams: Juana Perez'),
        (22, 10, 'user', 'q', 'gate: 1 nombre');
      INSERT INTO anonymisation_reviews (id, organization_id, reviewer_id, decision, gate_reason) VALUES
        (31, 1, 1, 'approved', E'content: null value in column "x" violates not-null constraint\\nDETAIL: Failing row contains (Juana Perez).');
      INSERT INTO eval_runs (id, organization_id, status, error) VALUES (41, 1, 'failed', 'TypeError');
    `))
  })

  it('dry run: reports the matching ids per column, writes nothing', async () => {
    const before = await snapshot()
    const report = await cleanStoredReasons(pg.db, { apply: false, batchSize: 1 })
    expect(await snapshot()).toEqual(before)
    const byColumn = Object.fromEntries(report.columns.map((c) => [`${c.table}.${c.column}`, c.ids]))
    expect(byColumn).toEqual({
      'documents.ingest_error': [11],
      'documents.publication_error': [12],
      'documents.anonymisation_error': [],
      'documents.graph_error': [13],
      'messages.corpus_error': [21],
      'anonymisation_reviews.gate_reason': [31],
      'eval_runs.error': [],
    })
    expect(JSON.stringify(report)).not.toMatch(NAMES)
  })

  it('apply rewrites only the matching rows; a second apply changes nothing', async () => {
    const before = await snapshot()
    const report = await cleanStoredReasons(pg.db, { apply: true, batchSize: 1 })
    expect(report.columns.flatMap((c) => c.ids).sort()).toEqual([11, 12, 13, 21, 31])

    const after = await snapshot()
    expect(JSON.stringify(after)).not.toMatch(NAMES)
    expect(JSON.stringify(after)).not.toMatch(/Failed query|params:/)
    const at = (k: string) => after.find((r) => r.k === k)!
    expect(at('d11').a).toBe('ingest_failed: [database error text withheld]')
    expect(at('d12')).toMatchObject({ a: 'no_audio_stream: the file has no audio', b: '[database error text withheld]' })
    expect(at('d13')).toMatchObject({ c: 'verify: 2 nombres', e: 'graph_failed: [database error text withheld]' })
    expect(at('m21').a).toBe('ingest_failed: [database error text withheld]')
    expect(at('m22').a).toBe('gate: 1 nombre')
    expect(at('r31').a).toBe('content: [database error text withheld]')
    // Untouched rows are byte-identical, and nobody's `updated_at` moved.
    expect(at('d14')).toEqual(before.find((r) => r.k === 'd14'))
    expect(at('e41')).toEqual(before.find((r) => r.k === 'e41'))
    expect(after.map((r) => r.u)).toEqual(before.map((r) => r.u))

    const again = await cleanStoredReasons(pg.db, { apply: true })
    expect(again.columns.flatMap((c) => c.ids)).toEqual([])
    expect(await snapshot()).toEqual(after)
  })
})

describe('safeStoredReason', () => {
  it('passes a clean reason and non-strings, and is idempotent', () => {
    expect(safeStoredReason('no_audio_stream: the file has no audio')).toBe('no_audio_stream: the file has no audio')
    expect(safeStoredReason(null)).toBe(null)
    const once = safeStoredReason('ingest_failed: Failed query: x\nparams: Juana')
    expect(once).toBe('ingest_failed: [database error text withheld]')
    expect(safeStoredReason(once)).toBe(once)
  })
})
