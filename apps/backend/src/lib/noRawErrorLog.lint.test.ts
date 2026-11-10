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
declare function errSummary(e: unknown): string
declare function safeErrMessage(e: unknown): string
declare const err: Error, error: Error, e: Error, cause: Error, writeErr: Error, updateError: Error, ex: Error, reason: Error
declare const job: Promise<void>
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
  ])('allows %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([])
  })
})
