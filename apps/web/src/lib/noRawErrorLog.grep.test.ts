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
  // `err.toString()`, a settled result's `.reason`, an error's `.cause`.
  new RegExp(String.raw`console\.(?:log|info|warn|error|debug)\(.*\b${ERR}\??\.toString\(`),
  /console\.(?:log|info|warn|error|debug)\(.*(?:\.cause|\b(?:r|res|result|outcome|settled|\w+Result)\??\.reason)\b(?!\??\.)/,
  // `.then(ok, (x) => console.error('…', x))`: the rejection handler's error.
  /\.then\(.+,\s*(?:async\s*)?\(?(\w+)\)?\s*=>.*console\.(?:log|info|warn|error|debug)\(.*(?:,\s*\1\s*\)|\$\{\1\})/,
  // A logger under any name (`routeLog.warn`, `logFor(x).error`), since
  // 2026-11-10: the error's text, through `.message`, `String()` or `JSON.stringify()`.
  new RegExp(
    String.raw`\.(?:info|warn|error|debug|fatal|trace)\(.*(?:\(?\b${ERR}(?: as Error)?\)?\??\.(?:message|stack)\b|\b(?:String|JSON\.stringify)\(${ERR}\))`,
  ),
  // 2026-11-11: an error as a format argument after a string first argument
  // (`log.error('x %s', err)`: pino prints `String(err)`), a database error's
  // own fields, a child binding not under `err`, `util.format` / `inspect`,
  // and `process.stderr.write`.
  new RegExp(String.raw`\.(?:info|warn|error|debug|fatal|trace)\((?:'[^']*'|"[^"]*"|\x60[^\x60]*\x60)\s*,(?:[^,]*,)*\s*${ERR}\s*\)`),
  new RegExp(
    String.raw`(?:console\.(?:log|info|warn|error|debug)|\.(?:info|warn|error|debug|fatal|trace))\(.*\b${ERR}(?: as [^)]*\))?\??\.(?:detail|where|query|params|parameters)\b`,
  ),
  new RegExp(String.raw`\.child\(\{[^}]*\b(?!err\b)\w+:\s*${ERR}\s*[,}]`),
  new RegExp(String.raw`(?:console\.(?:log|info|warn|error|debug)|\.(?:info|warn|error|debug|fatal|trace))\(.*\b(?:format|inspect)\([^)]*\b${ERR}\b`),
  new RegExp(
    String.raw`process\.std(?:err|out)\.write\(.*(?:\b${ERR}(?: as Error)?\)?\??\.(?:message|stack)\b|(?:String|JSON\.stringify)\(${ERR}\)|\$\{${ERR}\})`,
  ),
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
    `console.error('[x]', err.toString());`,
    `console.warn(\`[x] \${error?.toString()}\`);`,
    `if (r.status === 'rejected') console.warn('[x]', r.reason);`,
    `console.error('[x]', err.cause);`,
    `job.then(() => undefined, (boom) => console.error('[x]', boom));`,
    `routeLog.warn(\`[x] failed: \${(err as Error).message}\`);`,
    `logFor('x').error({ id, err: String(err) });`,
    `routeLog.error('[x] %s', err);`,
    `console.warn('[x]', err.detail);`,
    `routeLog.warn({ id, at: (err as PgError).where });`,
    `routeLog.child({ e: err });`,
    `console.warn(util.format('[x] %s', err));`,
    `process.stderr.write(\`[x] \${err.message}\`);`,
  ])('🔴 the shapes catch %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(true);
  });

  it.each([
    `console.error('[x] failed', errSummary(err));`,
    `console.warn('[x] failed:', safeErrMessage(err));`,
    `console.warn(\`[x] failed (\${(err as Error)?.name ?? 'Error'})\`);`,
    `console.error('[x]', err.cause?.name);`,
    `console.log('[x]', n.toString());`,
    `console.warn('[x] refused', decision.reason);`,
    `job.then((boom) => console.log('[x]', boom));`,
    `job.then(() => undefined, (boom) => console.error('[x]', safeErrMessage(boom)));`,
    `routeLog.warn('[x] failed', safeErrMessage(err));`,
    `routeLog.error({ err }, '[x] %s', id);`,
    `routeLog.info('[x] %s', url.searchParams);`,
    `routeLog.child({ err });`,
    `console.log('[x]', event.params, url.search);`,
    `process.stderr.write(\`[x] \${safeErrMessage(err)}\`);`,
  ])('allows %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(false);
  });
});
