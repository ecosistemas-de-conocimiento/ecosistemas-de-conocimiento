/**
 * P-07 (re-audit 2026-11-10): the lint rule that keeps a raw error's text out
 * of every log line (`eslint/noRawErrorLog.js`), run through the backend's own
 * `eslint.config.js` with the ESLint Node API, as `pnpm lint` runs it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const eslint = new ESLint({ cwd: backend })

/** The lines the rule flags in `code`, linted as if it were a source file. */
async function flagged(code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(backend, 'src/lib/__rawErrorLogFixture.ts') })
  return result.messages.filter((m) => m.ruleId === 'edc/no-raw-error-log').map((m) => m.line)
}

const prelude = `
declare const payload: { logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } }
declare const opts: { log?: { warn: (...a: unknown[]) => void } }
type Log = { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; child: (b: object) => Log }
declare const ingestLog: Log
declare function loggerOf(d: unknown): Log | undefined
declare function errSummary(e: unknown): string
declare function safeErrMessage(e: unknown): string
declare const err: Error, error: Error, e: Error, cause: Error, writeErr: Error, updateError: Error, ex: Error, reason: Error
declare const job: Promise<void>
declare const results: PromiseSettledResult<void>[]
`
const lines = (body: string) => prelude.split('\n').length + body.trimStart().split('\n').length - 1

describe('edc/no-raw-error-log', () => {
  it.each([
    `console.error('[x] failed', err)`,
    `console.warn('[x] failed', error)`,
    `console.log('[x]', e)`,
    `console.error('[x]', cause)`,
    `console.error('[x]', writeErr)`,
    `console.error('[x]', updateError)`,
    `console.error('[x]', err.message)`,
    `console.error('[x]', err?.stack)`,
    `console.error('[x]', String(err))`,
    `console.error(\`[x] failed: \${err}\`)`,
    `console.error(\`[x] failed: \${err.message}\`)`,
    `console.error('[x]', err instanceof Error ? err.message : String(err))`,
    `console.error('[x]', { err })`,
    `payload.logger.warn({ id: 1, err: err instanceof Error ? err.message : String(err) }, '[x]')`,
    `payload.logger.warn({ err: String(err) }, '[x]')`,
    `payload.logger.warn({ error: err }, '[x]')`,
    `payload.logger.warn(\`[x] failed: \${err instanceof Error ? err.message : String(err)}\`)`,
    `payload.logger.warn('[x] ' + err.message)`,
    `opts.log?.warn({ err: (err as Error).message }, '[x]')`,
    `console.error('[x]', ex)`,
    `console.error('[x]', reason)`,
    `console.error('[x]', JSON.stringify(err))`,
    `console.error(\`[x] \${JSON.stringify({ err })}\`)`,
    `payload.logger.warn({ detail: JSON.stringify(writeErr) }, '[x]')`,
    // Any name a catch binds, whatever it is.
    `try { void 0 } catch (boom) { console.error('[x]', boom) }`,
    `try { void 0 } catch (boom) { console.error(\`[x] \${boom}\`) }`,
    `try { void 0 } catch (boom) { payload.logger.warn({ id: 1, detail: boom }, '[x]') }`,
    `job.catch((boom) => console.error('[x]', boom))`,
    `job.catch(function (boom) { console.warn('[x]', String(boom)) })`,
    // toString(), the rejection handler of .then(), .reason and .cause.
    `console.error('[x]', err.toString())`,
    `payload.logger.warn(\`[x] \${err?.toString()}\`)`,
    `try { void 0 } catch (boom) { console.error('[x] ' + boom.toString()) }`,
    `job.then(() => undefined, (boom) => console.error('[x]', boom))`,
    `job.then(() => undefined, function (boom) { payload.logger.warn(\`[x] \${boom}\`) })`,
    `for (const r of results) if (r.status === 'rejected') console.error('[x]', r.reason)`,
    `for (const r of results) if (r.status === 'rejected') payload.logger.warn({ id: 1, detail: r.reason }, '[x]')`,
    `console.error('[x]', err.cause)`,
    `results.forEach((outcome) => console.warn('[x]', outcome.reason))`,
    `payload.logger.warn(\`[x] \${error.cause}\`)`,
    // A logger under any name, a logger a call returns, a child (2026-11-10).
    `ingestLog.warn(\`[x] failed: \${err instanceof Error ? err.message : String(err)}\`)`,
    `ingestLog.error({ id: 1, err: e instanceof Error ? e.message : String(e) }, '[x]')`,
    `loggerOf(job)?.warn({ id: 1, err: String(writeErr) }, '[x]')`,
    `payload.logger.child({ c: 1 }).error({ detail: err }, '[x]')`,
    `ingestLog.child({ c: 1 }).warn('[x] ' + err.message)`,
  ])('🔴 rejects %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([lines(body)])
  })

  it.each([
    `console.error('[x] failed', errSummary(err))`,
    `console.error('[x] failed', safeErrMessage(err))`,
    `console.error(\`[x] failed: \${safeErrMessage(err)}\`)`,
    `console.error('[x] failed', err.name, err instanceof Error ? err.name : typeof err)`,
    `payload.logger.error({ err }, '[x] failed')`,
    `payload.logger.error({ id: 1, err: err }, '[x] failed')`,
    `payload.logger.error(err)`,
    `payload.logger.warn({ err: safeErrMessage(err) }, '[x]')`,
    `opts.log?.warn(\`[x] \${errSummary(err)}\`)`,
    `throw new Error(\`wrapped: \${err.message}\`)`,
    `console.error('[x]', JSON.stringify({ id: 1 }))`,
    `try { void 0 } catch (boom) { console.error('[x]', errSummary(boom), boom instanceof Error ? boom.name : 'x') }`,
    `try { void 0 } catch (boom) { payload.logger.error({ err: boom }, '[x]') }`,
    `job.catch((boom) => payload.logger.error(boom))`,
    // Bound outside a catch: an ordinary value.
    `const boom = 'fine'; console.log('[x]', boom)`,
    `job.then((boom) => console.log('[x]', boom))`,
    `job.then(() => undefined, (boom) => payload.logger.error({ err: boom }, '[x]'))`,
    `for (const r of results) if (r.status === 'rejected') payload.logger.warn({ err: r.reason }, '[x]')`,
    `payload.logger.warn({ err: err.cause }, '[x]')`,
    `console.error('[x]', safeErrMessage(err.cause), err.cause instanceof Error ? err.cause.name : 'x')`,
    `const n = 1; console.log('[x]', n.toString())`,
    // A domain reason, not a rejection.
    `const decision = { reason: 'tier' }; payload.logger.info(\`[x] \${decision.reason}\`)`,
    `ingestLog.error({ id: 1, err }, '[x]')`,
    `loggerOf(job)?.warn({ id: 1, err: writeErr }, '[x]')`,
    `ingestLog.child({ c: 1 }).warn(\`[x] \${errSummary(err)}\`)`,
  ])('allows %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([])
  })
})
