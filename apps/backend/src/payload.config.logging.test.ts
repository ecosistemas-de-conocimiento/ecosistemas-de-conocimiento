/**
 * 🔴 P-07 WIRED (review 2026-11-10, R-02): `safeErrSerializer` is the `err`
 * serializer of the REAL Payload logger, and the two `console.error` calls of
 * the background extract+ingest path log `errSummary`, never the error. The
 * serializer itself is tested in `lib/errorSummary.test.ts`; this checks that
 * production uses it.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Writable } from 'node:stream'

import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { defaultLoggerOptions } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { safeErrSerializer } from './lib/errorSummary'

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'

type Options = { serializers?: Record<string, unknown> }
type Pino = (options: Options, stream: Writable) => { error(obj: object, msg: string): void }
// `pino` is Payload's dependency, not ours: load the copy Payload uses.
const { pino } = createRequire(createRequire(import.meta.url).resolve('payload'))('pino') as { pino: Pino }

let logger: { options: Options; destination?: unknown }

beforeAll(async () => {
  process.env.PAYLOAD_SECRET ||= 'test-secret'
  process.env.DATABASE_URI ||= 'postgres://test@localhost:5433/test'
  const config = (await (await import('./payload.config')).default) as unknown as { logger: typeof logger }
  logger = config.logger
})

describe("Payload's logger", () => {
  it('uses safeErrSerializer for `err` and keeps the default pretty destination', () => {
    expect(logger.options.serializers?.err).toBe(safeErrSerializer)
    expect(logger.destination).toBe(defaultLoggerOptions)
  })

  it('🔴 a failed query logged as `{ err }` does not carry its params', () => {
    let out = ''
    const sink = new Writable({
      write(chunk, _enc, done) {
        out += String(chunk)
        done()
      },
    })
    const err = new DrizzleQueryError('update "documents" set "extracted_text" = $1', [SECRET], new Error('boom'))
    pino(logger.options, sink).error({ err }, 'request failed')
    expect(out).toContain('request failed')
    expect(out).not.toContain(SECRET)
  })
})

describe('Documents.ts background extract+ingest', () => {
  const source = readFileSync(new URL('./collections/Documents.ts', import.meta.url), 'utf8')

  it.each([
    "'[documents] background extract+ingest failed', row.id,",
    "'[documents] could not mark doc', docId, 'failed after extract+ingest threw',",
  ])('logs errSummary, never the raw error: %s', (call) => {
    const line = source.split('\n').find((l) => l.includes(call))
    expect(line).toBeDefined()
    expect(line).toMatch(/errSummary\((err|writeErr)\)\)\s*$/)
  })
})
