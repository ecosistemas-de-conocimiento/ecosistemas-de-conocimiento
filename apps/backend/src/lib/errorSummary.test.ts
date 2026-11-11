/**
 * P-07 (audit 2026-11-10): a failed database write must not put the row in
 * the log. The error here is drizzle's own `DrizzleQueryError` (the class
 * `pg-core/session.js` wraps every failed query in) around pg's own
 * `DatabaseError`, so the shape is the one production throws.
 */
import { createRequire } from 'node:module'
import { Writable } from 'node:stream'

import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { defaultLoggerOptions, type Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { errSummary, isDatabaseError, safeErrSerializer } from './errorSummary'

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'

const requireFromPayload = createRequire(createRequire(import.meta.url).resolve('payload'))
const requireFromPg = createRequire(
  createRequire(createRequire(import.meta.url).resolve('@payloadcms/db-postgres')).resolve('pg'),
)

function pgError(code: string): Error {
  const { DatabaseError } = requireFromPg('pg-protocol') as {
    DatabaseError: new (message: string, length: number, name: string) => Error & Record<string, unknown>
  }
  const e = new DatabaseError(`value too long, near "${SECRET}"`, 0, 'error')
  e.code = code
  e.detail = `Key (extracted_text)=(${SECRET}) already exists.`
  return e
}

function dbError(code = '57P01'): Error {
  return new DrizzleQueryError(
    'update "documents" set "extracted_text" = $1, "redacted_text" = $2 where "documents"."id" = $3',
    [SECRET, `[Persona 1] ${SECRET}`, 42],
    pgError(code),
  )
}

describe('the premise: drizzle puts the params in the message and the stack', () => {
  it('🔴 message, stack and String(err) all carry the row text', () => {
    const err = dbError()
    expect(err.message).toContain(SECRET)
    expect(String(err)).toContain(SECRET)
    expect(err.stack).toContain(SECRET)
  })
})

describe('errSummary', () => {
  it('🔴 a DrizzleQueryError is its class and its SQLSTATE, nothing else', () => {
    const s = errSummary(dbError('57P01'))
    expect(s).toBe('DrizzleQueryError(57P01)')
    expect(s).not.toContain('Lucía')
  })

  it('a pg error alone keeps its own class and code', () => {
    expect(errSummary(pgError('40P01'))).toBe('DatabaseError(40P01)')
  })

  it('a plain error is its name; a non-error says its type', () => {
    expect(errSummary(new TypeError(SECRET))).toBe('TypeError')
    expect(errSummary(SECRET)).toBe('string')
    expect(errSummary(undefined)).toBe('undefined')
    expect(errSummary(null)).toBe('null')
  })

  it('a code that is not a SQLSTATE is not printed (it could be anything)', () => {
    const e = Object.assign(new Error(SECRET), { code: SECRET })
    expect(errSummary(e)).toBe('Error')
  })
})

/** What Node's `net` throws for a refused connection (`errno` -111 on Linux). */
function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: '127.0.0.1',
    port: 5432,
  })
}

describe('a Node system error keeps its code (2026-11-10)', () => {
  it('🔴 an ECONNREFUSED is summarised with its code, also from the cause chain', () => {
    expect(errSummary(refused())).toBe('Error(ECONNREFUSED)')
    expect(errSummary(new DrizzleQueryError('select 1', [], refused()))).toBe('DrizzleQueryError(ECONNREFUSED)')
  })

  it('🔴 the serializer keeps code, errno and syscall, and still drops a database error\'s text', () => {
    const viaDb = safeErrSerializer(new DrizzleQueryError('select $1', [SECRET], refused())) as Record<string, unknown>
    expect(viaDb).toMatchObject({ type: 'DrizzleQueryError', code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })
    expect(viaDb.message).toBeUndefined()
    expect(JSON.stringify(viaDb)).not.toContain('Lucía')

    const db = safeErrSerializer(dbError('23505')) as Record<string, unknown>
    expect(db.code).toBe('23505')
    expect(db.message).toBeUndefined()
    expect(JSON.stringify(db)).not.toContain('Lucía')
  })
})

describe('safeErrSerializer', () => {
  it('🔴 a database error loses message, query, params, detail and cause', () => {
    const out = safeErrSerializer(dbError('57014'))
    const text = JSON.stringify(out)
    expect(text).not.toContain('Lucía')
    expect(text).not.toContain('extracted_text')
    expect(out).toMatchObject({ type: 'DrizzleQueryError', code: '57014' })
    // Stack frames survive, so the log still says where.
    expect((out as { stack?: string }).stack).toMatch(/^\s+at /)
  })

  it('a wrapper that copied drizzle text into its own message is withheld too', () => {
    const wrapped = new Error(dbError().message)
    expect(isDatabaseError(wrapped)).toBe(true)
    expect(JSON.stringify(safeErrSerializer(wrapped))).not.toContain('Lucía')
  })

  it('a non-database error keeps its message (a validation error is useless without it)', () => {
    expect(safeErrSerializer(new Error('The following field is invalid: email'))).toMatchObject({
      type: 'Error',
      message: 'The following field is invalid: email',
    })
  })

  it('a caller-chosen string passes, unless it is drizzle text', () => {
    expect(safeErrSerializer('DrizzleQueryError(57P01)')).toBe('DrizzleQueryError(57P01)')
    expect(safeErrSerializer(String(dbError()))).not.toContain('Lucía')
  })

  it('🔴 wired into a real pino, a logged database error leaves no row text in the output', () => {
    type Pino = (opts: object, dest: Writable) => { error(obj: object, msg: string): void }
    const { pino } = requireFromPayload('pino') as { pino: Pino }
    const lines: string[] = []
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const logger = pino({ serializers: { err: safeErrSerializer } }, sink)
    logger.error({ err: dbError('57P01') }, 'background extract+ingest failed')
    const out = lines.join('')
    expect(out).toContain('DrizzleQueryError')
    expect(out).toContain('57P01')
    expect(out).not.toContain('Lucía')
    expect(out).not.toContain('Failed query')

    // And without it, the same call leaks: the reason the serializer exists.
    lines.length = 0
    pino({}, sink).error({ err: dbError('57P01') }, 'x')
    expect(lines.join('')).toContain('Lucía')
  })

  it('the payload.config.ts wiring handed to edc-1 type-checks as Payload\'s logger option', () => {
    const logger: Config['logger'] = {
      options: { serializers: { err: safeErrSerializer } },
      destination: defaultLoggerOptions,
    }
    expect(logger).toBeTruthy()
  })
})
