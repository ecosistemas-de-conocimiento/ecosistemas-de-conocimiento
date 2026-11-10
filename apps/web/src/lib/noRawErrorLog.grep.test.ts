/**
 * P-07, second guard (re-audit 2026-11-10), as in the backend. The lint rule
 * (`eslint.config.js`) is the real one; this grep catches its most common
 * one-line shapes in a plain `pnpm test`, `.svelte` files included.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ERR = String.raw`(?:err|error|e|ex|cause|reason|\w+Err|\w+Error)`;
const SHAPES = [
  // console.error('…', err) and friends: the raw error as a whole argument.
  new RegExp(String.raw`console\.(?:log|info|warn|error|debug)\(.*,\s*${ERR}\s*\)`),
  // Its text: `(err as Error).message`, `err.stack`, `String(err)`, `JSON.stringify(err)`.
  new RegExp(String.raw`console\.(?:log|info|warn|error|debug)\(.*\(?${ERR}(?: as Error)?\)?\??\.(?:message|stack)\b`),
  new RegExp(String.raw`console\.(?:log|info|warn|error|debug)\(.*(?:String|JSON\.stringify)\(${ERR}\)`),
  new RegExp(String.raw`console\.(?:log|info|warn|error|debug)\(.*\$\{${ERR}\}`),
];

/** The lint rule's own opt-out on the line above, which the rule also honours. */
const EXEMPT = /eslint-disable-next-line edc\/no-raw-error-log -- \S/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return sources(full);
    return /\.(?:ts|svelte)$/.test(d.name) && !/\.(?:test|spec)\.ts$/.test(d.name) ? [full] : [];
  });
}

/** Every line in `root` that matches a shape, as `file:line: text`. */
function rawErrorLogLines(root: string): string[] {
  return sources(root).flatMap((file) => {
    const rel = path.relative(root, file);
    const all = readFileSync(file, 'utf8').split('\n');
    return all.flatMap((line, i) =>
      SHAPES.some((re) => re.test(line)) && !EXEMPT.test(all[i - 1] ?? '') ? [`${rel}:${i + 1}: ${line.trim()}`] : [],
    );
  });
}

describe('no raw error text in a log line (grep)', () => {
  it('🔴 no source file logs a raw error', () => {
    expect(rawErrorLogLines(src)).toEqual([]);
  });

  it.each([
    `console.error('[handleError] uncaught error', error);`,
    `console.warn('[sign-in] la petición no salió:', (err as Error).message);`,
    `console.warn('[x]', { mediaId, err: String(err) });`,
    `console.error('[x]', JSON.stringify(ex));`,
    `console.warn(\`[x] failed: \${err}\`);`,
  ])('🔴 the shapes catch %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(true);
  });

  it.each([
    `console.error('[x] failed', errSummary(err));`,
    `console.warn('[x] failed:', safeErrMessage(err));`,
    `console.warn(\`[x] failed (\${(err as Error)?.name ?? 'Error'})\`);`,
  ])('allows %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(false);
  });
});
