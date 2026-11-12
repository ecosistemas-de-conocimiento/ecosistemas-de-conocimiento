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

import { safeErrMessage } from './errorSummary'
import { cleanStoredReasons, quotesRow, ROW_TEXT_SOURCE, safeStoredReason } from './storedReason'
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

beforeAll(async () => {
  if (dockerOk) pg = await startRealPostgres(`edc-clean-errors-${process.pid}`, 'clean_errors')
}, 120_000)

afterAll(async () => {
  await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
  pg?.stop()
})

describe.skipIf(!dockerOk)('clean-stored-errors (real Postgres)', () => {
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
      INSERT INTO eval_runs (id, organization_id, status, error) VALUES (41, 1, 'failed', 'TypeError'),
        (42, 1, 'failed', 'invalid input value for enum enum_x: "Juana Perez"');
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
      'eval_runs.error': [42],
    })
    expect(JSON.stringify(report)).not.toMatch(NAMES)
  })

  it('apply rewrites only the matching rows; a second apply changes nothing', async () => {
    const before = await snapshot()
    const report = await cleanStoredReasons(pg.db, { apply: true, batchSize: 1 })
    expect(report.columns.flatMap((c) => c.ids).sort()).toEqual([11, 12, 13, 21, 31, 42])

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
    expect(at('e42').a).toBe('[database error text withheld]')
    // Untouched rows are byte-identical, and nobody's `updated_at` moved.
    expect(at('d14')).toEqual(before.find((r) => r.k === 'd14'))
    expect(at('e41')).toEqual(before.find((r) => r.k === 'e41'))
    expect(after.map((r) => r.u)).toEqual(before.map((r) => r.u))

    const again = await cleanStoredReasons(pg.db, { apply: true })
    expect(again.columns.flatMap((c) => c.ids)).toEqual([])
    expect(await snapshot()).toEqual(after)
  })
})

describe.skipIf(!dockerOk)('clean-stored-errors: a row a writer changed between the SELECT and the UPDATE', () => {
  it('keeps the writer value and is not reported', async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE anonymisation_reviews, eval_runs, messages, sessions, documents, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'subio@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, ingest_error) VALUES
        (11, 1, 1, 'a.pdf', 'pdf', E'ingest_failed: Failed query: x\\nparams: Juana Perez'),
        (12, 1, 1, 'b.pdf', 'pdf', E'ingest_failed: Failed query: y\\nparams: Juana Perez');
    `))
    let raced = false
    // After the SELECT that returns row 12, a writer stores a new reason on it.
    const db = new Proxy(pg.db, {
      get(target, key) {
        if (key !== 'execute') return Reflect.get(target, key)
        return async (q: unknown) => {
          const out = await target.execute(q as never)
          if (!raced && (out as unknown as { rows?: Array<{ id: unknown }> }).rows?.some((r) => Number(r.id) === 12)) {
            raced = true
            await target.execute(sql`UPDATE documents SET ingest_error = 'no_audio_stream: nuevo' WHERE id = 12`)
          }
          return out
        }
      },
    })
    const report = await cleanStoredReasons(db as never, { apply: true })
    expect(raced).toBe(true)
    expect(report.columns.find((c) => c.column === 'ingest_error')!.ids).toEqual([11])
    expect(await rowsOf(pg.db, sql`SELECT id, ingest_error FROM documents ORDER BY id`)).toEqual([
      { id: 11, ingest_error: 'ingest_failed: [database error text withheld]' },
      { id: 12, ingest_error: 'no_audio_stream: nuevo' },
    ])
  })
})

/** Clean reasons our writers store: never withheld, in JS or in SQL. */
const CLEAN = [
  'no_audio_stream: the file has no audio',
  'verify: 2 nombres',
  'publish_failed: timeout',
  'gate: 1 nombre',
  'ingest_failed: ai-service reported a failure',
  'TypeError',
  'PostgresError(22P02)',
  'ingest_failed: [database error text withheld]',
]

describe.skipIf(!dockerOk)('ROW_TEXT_SOURCE: every Postgres error that quotes its input (real Postgres)', () => {
  /**
   * label → [statement, marker that must not survive]. The input reaches
   * Postgres as a bind parameter. An empty marker: Postgres does not quote the
   * input there, and the message is withheld all the same.
   */
  const cases: Array<[string, () => ReturnType<typeof sql>, string]> = [
    ['integer', () => sql`SELECT ${'Juana Perez'}::int`, 'Juana'],
    ['uuid', () => sql`SELECT ${'Juana Perez'}::uuid`, 'Juana'],
    ['boolean', () => sql`SELECT ${'Juana Perez'}::boolean`, 'Juana'],
    ['date', () => sql`SELECT ${'Juana Perez'}::date`, 'Juana'],
    ['interval', () => sql`SELECT ${'Juana Perez'}::interval`, 'Juana'],
    ['numeric', () => sql`SELECT ${'Juana Perez'}::numeric`, 'Juana'],
    ['enum', () => sql`SELECT ${'Juana Perez'}::zz_enum`, 'Juana'],
    ['array', () => sql`SELECT ${'Juana Perez'}::text[]`, 'Juana'],
    ['record', () => sql`SELECT ${'Juana Perez'}::zz_rec`, 'Juana'],
    ['range', () => sql`SELECT ${'Juana Perez'}::int4range`, 'Juana'],
    ['json token', () => sql`SELECT ${'Juana Perez'}::jsonb`, 'Juana'],
    ['json found', () => sql`SELECT ${'{"a": 1 Juana}'}::jsonb`, 'Juana'],
    ['jsonpath', () => sql`SELECT ${'$.a Juana Perez'}::jsonpath`, ''],
    ['tsquery', () => sql`SELECT to_tsquery('simple', ${'Juana &'})`, 'Juana'],
    ['to_date', () => sql`SELECT to_date(${'Juana'}, 'YYYY')`, 'Juan'],
    ['integer range', () => sql`SELECT ${'98765432109'}::int`, '98765432109'],
    ['date range', () => sql`SELECT ${'2019-13-45'}::date`, '2019-13-45'],
    ['bytea', () => sql`SELECT ${'\\xJJ'}::bytea`, 'J'],
    ['encoding', () => sql`SELECT convert_from(${'\\xffe9'}::bytea, 'UTF8')`, '0xff'],
    ['varchar', () => sql`INSERT INTO zz_v VALUES (${'Juana Perez'})`, ''],
    ['bit', () => sql`SELECT ${'Juana'}::bit(3)`, '"J"'],
    ['money', () => sql`SELECT ${'Juana Perez'}::money`, 'Juana'],
    ['regclass', () => sql`SELECT ${'Juana'}::regclass`, 'juana'],
    ['setting', () => sql`SELECT current_setting(${'Juana'})`, 'Juana'],
    ['unique', () => sql`INSERT INTO zz_u VALUES (${'Juana Perez'})`, 'Juana'],
    ['not-null', () => sql`INSERT INTO zz_n VALUES (${'Juana Perez'}, NULL)`, 'Juana'],
    ['check', () => sql`INSERT INTO zz_c VALUES (${'Juana Perez'})`, 'Juana'],
    ['foreign key', () => sql`INSERT INTO zz_f VALUES (${98765})`, '98765'],
    ['syntax', () => sql.raw(`SELECT Juana Perez Lopez`), 'Lopez'],
  ]

  beforeAll(async () => {
    await pg.db.execute(sql.raw(`
      CREATE TYPE zz_enum AS ENUM ('a');
      CREATE TYPE zz_rec AS (a int);
      CREATE TABLE zz_v (v varchar(3));
      CREATE TABLE zz_u (v text UNIQUE); INSERT INTO zz_u VALUES ('Juana Perez');
      CREATE TABLE zz_n (a text, b text NOT NULL);
      CREATE TABLE zz_c (v text CHECK (length(v) < 5));
      CREATE TABLE zz_p (id int PRIMARY KEY); CREATE TABLE zz_f (p int REFERENCES zz_p(id));
    `))
  })

  it.each(cases.map(([label, q, marker]) => ({ label, q, marker })))('$label', async ({ q, marker }) => {
    let caught: unknown
    try {
      await pg.db.execute(q())
    } catch (err) {
      caught = err
    }
    expect(caught, 'the statement must fail').toBeTruthy()
    const pgErr = ((caught as { cause?: unknown }).cause ?? caught) as { message?: string; detail?: string; where?: string }
    const parts = [pgErr.message, pgErr.detail, pgErr.where].filter((v): v is string => typeof v === 'string' && v !== '')
    // Every way a writer may have stored it: each part, joined, `DETAIL:`-prefixed.
    const shapes = [...parts, parts.join(' '), parts.join('\n'), `${parts[0]}\nDETAIL: ${parts[1] ?? ''}`]
    const quoting = marker ? shapes.filter((v) => v.includes(marker)) : [parts[0]!]
    expect(quoting.length, 'Postgres quoted the input somewhere').toBeGreaterThan(0)
    for (const v of quoting) {
      expect(quotesRow(v), v.replace(marker, '<input>')).toBe(true)
      expect(safeStoredReason(`ingest_failed: ${v}`)).toBe('ingest_failed: [database error text withheld]')
      // What the ai-service callback stores: `safeErrMessage` of a string.
      expect(safeErrMessage(v)).toBe('[database error text withheld]')
      // The script's SQL prefilter agrees with the JS check.
      const [row] = await rowsOf(pg.db, sql`SELECT ${v} ~ ${ROW_TEXT_SOURCE} AS m`)
      expect(row!.m).toBe(true)
    }
  })

  it('a clean reason matches neither in JS nor in SQL, and passes unchanged', async () => {
    for (const v of CLEAN) {
      expect(quotesRow(v)).toBe(false)
      expect(safeStoredReason(v)).toBe(v)
      const [row] = await rowsOf(pg.db, sql`SELECT ${v} ~ ${ROW_TEXT_SOURCE} AS m`)
      expect(row!.m).toBe(false)
    }
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
