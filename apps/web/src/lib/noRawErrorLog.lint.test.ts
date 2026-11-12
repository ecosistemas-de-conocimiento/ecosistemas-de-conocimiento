/**
 * P-07 (re-audit 2026-11-10): the lint rule that keeps a raw error's text out
 * of every log line (`apps/backend/eslint/noRawErrorLog.js`, shared), run
 * through the web's own `eslint.config.js` with the ESLint Node API, as
 * `pnpm lint` runs it. That config has no `.svelte` parser, so the last test
 * lints each component's `<script>` blocks here instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: web });

/** The lines the rule flags in `code`, linted as if it were a source file. */
async function flagged(code: string, filePath = 'src/lib/__rawErrorLogFixture.ts'): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(web, filePath) });
  return result!.messages.filter((m) => m.ruleId === 'edc/no-raw-error-log' || m.fatal).map((m) => m.line);
}

const prelude = `
declare function errSummary(e: unknown): string
declare function safeErrMessage(e: unknown): string
declare const err: Error, error: Error, ex: Error, reason: Error
type Log = { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; child: (b: object) => Log }
declare const routeLog: Log
declare function logFor(name: string): Log
declare const job: Promise<void>
declare const results: PromiseSettledResult<void>[]
declare const util: { format: (...a: unknown[]) => string }
`;
const lines = (body: string) => prelude.split('\n').length + body.trimStart().split('\n').length - 1;

describe('edc/no-raw-error-log in apps/web', () => {
  it.each([
    `console.error('[handleError] uncaught error', error)`,
    `console.warn('[grafo] graph view read failed', err)`,
    `console.warn('[sign-in] la petición no salió:', (err as Error).message)`,
    `console.warn('[chat] turn failed:', (err as Error)?.message ?? err)`,
    `console.warn('[upload] could not delete', { mediaId: 1, err: String(err) })`,
    `console.error('[x]', ex)`,
    `console.error('[x]', reason)`,
    `console.error('[x]', JSON.stringify(err))`,
    `try { void 0 } catch (boom) { console.error('[x]', boom) }`,
    `job.catch((boom) => console.warn(\`[x] \${boom}\`))`,
    `console.error('[x]', err.toString())`,
    `try { void 0 } catch (boom) { console.warn(\`[x] \${boom.toString()}\`) }`,
    `job.then(() => undefined, (boom) => console.error('[x]', boom))`,
    `for (const r of results) if (r.status === 'rejected') console.warn('[x]', r.reason)`,
    `console.error('[x]', error.cause)`,
    // A logger under any name, a logger a call returns, a child (2026-11-10).
    `routeLog.warn(\`[x] failed: \${(err as Error).message}\`)`,
    `logFor('x').error({ id: 1, err: String(err) }, '[x]')`,
    `routeLog.child({ c: 1 }).error({ detail: error }, '[x]')`,
    // 2026-11-11: format arguments, a database error's fields, child bindings,
    // destructured text, a console alias, util.format, process.stderr.
    `routeLog.error('[x] %s', err)`,
    `console.warn('[x]', err.detail)`,
    `try { void 0 } catch (boom) { routeLog.warn({ id: 1, at: (boom as { where: string }).where }, '[x]') }`,
    `routeLog.child({ e: err })`,
    `const { message } = err; console.warn('[x]', message)`,
    `const log = console.error; log('[x]', ex)`,
    `console.warn(util.format('[x] %s', err))`,
    `process.stderr.write(\`[x] \${err.message}\`)`,
  ])('🔴 rejects %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([lines(body)]);
  });

  it.each([
    `console.error('[x] failed', errSummary(err))`,
    `console.warn('[x] failed', safeErrMessage(err))`,
    `console.warn(\`[x] failed (\${(err as Error)?.name ?? 'Error'})\`)`,
    `try { void 0 } catch (boom) { console.error('[x]', safeErrMessage(boom)) }`,
    `job.then((boom) => console.log('[x]', boom))`,
    `job.then(() => undefined, (boom) => console.error('[x]', safeErrMessage(boom)))`,
    `for (const r of results) if (r.status === 'rejected') console.warn('[x]', safeErrMessage(r.reason))`,
    `console.error('[x]', err.cause instanceof Error ? err.cause.name : 'x')`,
    `routeLog.warn('[x] failed', safeErrMessage(err))`,
    `const n = 1; console.log('[x]', n.toString())`,
    `routeLog.error({ err }, '[x] %s', 'id-1')`,
    `routeLog.child({ err })`,
    `const { name } = err; console.warn('[x]', name)`,
    `const log = console.error; log('[x]', safeErrMessage(err))`,
    `const url = new URL('http://x'); console.log('[x]', url.search, util.format('%s', 1))`,
  ])('allows %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([]);
  });

  it("🔴 no component's <script> logs a raw error", async () => {
    const src = path.join(web, 'src');
    const svelte = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const full = path.join(dir, d.name);
        return d.isDirectory() ? svelte(full) : d.name.endsWith('.svelte') ? [full] : [];
      });
    const found: string[] = [];
    for (const file of svelte(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
        // Blank lines before the block keep the reported line numbers the file's.
        const offset = text.slice(0, m.index + m[1]!.length).split('\n').length - 1;
        const rel = path.relative(web, file);
        for (const line of await flagged('\n'.repeat(offset) + m[2]!, `${rel}.script.ts`)) {
          found.push(`${rel}:${line}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
