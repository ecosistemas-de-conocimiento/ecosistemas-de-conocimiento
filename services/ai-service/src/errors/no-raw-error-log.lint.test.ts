// P-07: the shared lint rule (`apps/backend/eslint/noRawErrorLog.js`) run
// through ai-service's own `eslint.config.js` with the ESLint Node API, as
// `pnpm lint` runs it. Since 2026-11-10 it checks a logger whatever its name:
// `ingestLog.*` carried 9 raw error texts past the old rule, which only knew
// `logger`, `log` and `console` (measured with `eslint .` that day).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: service });

/** The lines the rule flags in `code`, linted as if it were a source file. */
async function flagged(code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(service, 'src/workers/__rawErrorLogFixture.ts'),
  });
  return result!.messages.filter((m) => m.ruleId === 'edc/no-raw-error-log').map((m) => m.line);
}

const prelude = `
type Log = { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; child: (b: object) => Log };
declare const ingestLog: Log;
declare const deps: { logger?: Log };
declare function getFallbackLog(): Promise<Log>;
declare function safeErrMessage(e: unknown): string;
declare const err: Error;
declare const job: Promise<void>;
`;
const lines = (body: string) => prelude.split('\n').length + body.trimStart().split('\n').length - 1;

describe('edc/no-raw-error-log in ai-service', () => {
  it.each([
    `ingestLog.warn(\`[x] failed: \${err instanceof Error ? err.message : String(err)}\`)`,
    `ingestLog.error({ id: 1, err: err.message }, '[x]')`,
    `job.catch((e) => ingestLog.error({ id: 1, err: e instanceof Error ? e.message : String(e) }, '[x]'))`,
    `deps.logger?.warn({ err: String(err) }, '[x]')`,
    `ingestLog.child({ c: 1 }).warn({ detail: err }, '[x]')`,
    `void getFallbackLog().then((l) => l.warn({ reason: err.stack }, '[x]'))`,
    `console.warn(\`[x] \${err.message}\`)`,
  ])('🔴 rejects %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([lines(body)]);
  });

  it.each([
    `ingestLog.error({ id: 1, err }, '[x]')`,
    `job.catch((e) => ingestLog.error({ id: 1, err: e }, '[x]'))`,
    `ingestLog.child({ c: 1 }).warn({ err }, '[x]')`,
    `console.warn(\`[x] \${safeErrMessage(err)}\`)`,
  ])('allows %s', async (body) => {
    expect(await flagged(prelude + body)).toEqual([]);
  });
});
