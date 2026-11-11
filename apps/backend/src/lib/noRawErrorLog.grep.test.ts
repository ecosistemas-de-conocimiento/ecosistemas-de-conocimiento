/**
 * P-07, second guard (re-audit 2026-11-10). The lint rule
 * (`eslint/noRawErrorLog.js`) is the real one; this grep catches its most
 * common one-line shapes in a plain `pnpm test`, which runs where lint does not.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SHAPES = [
  // console.error('…', err) and friends: the raw error as a whole argument.
  /console\.(?:log|info|warn|error|debug)\(.*,\s*(?:err|error|e|ex|cause|reason|\w+Err|\w+Error)\s*\)/,
  // JSON.stringify of an error in a log line.
  /(?:console|logger)\.(?:log|info|warn|error|debug)\(.*JSON\.stringify\(\s*(?:err|error|e|ex|cause|reason|\w+Err|\w+Error)\s*\)/,
  // A log field holding the error's text.
  /\berr: err instanceof Error \? err\.message/,
  /\berr: String\(err\)/,
  /\berr: \(err as Error\)\.message/,
  // Its text through toString(), and a settled result's `.reason` or an
  // error's `.cause` (an error object, not text: fine under `err`).
  /(?:console|logger)\.(?:log|info|warn|error|debug)\(.*\b(?:err|error|e|ex|cause|reason|\w+Err|\w+Error)\??\.toString\(/,
  /console\.(?:log|info|warn|error|debug)\(.*(?:\.cause|\b(?:r|res|result|outcome|settled|\w+Result)\??\.reason)\b(?!\??\.)/,
  /(?:console|logger)\.(?:log|info|warn|error|debug)\(.*\$\{[^}]*(?:\.cause|\b(?:r|res|result|outcome|settled|\w+Result)\??\.reason)\}/,
  // `.then(ok, (x) => console.error('…', x))`: the rejection handler's error.
  /\.then\(.+,\s*(?:async\s*)?\(?(\w+)\)?\s*=>.*console\.(?:log|info|warn|error|debug)\(.*(?:,\s*\1\s*\)|\$\{\1\})/,
]

/** The lint rule's own opt-out on the line above, which the rule also honours. */
const EXEMPT = /eslint-disable-next-line edc\/no-raw-error-log -- \S/

/**
 * ⚠ Files other lanes were editing when this landed (wave 4, 2026-11-10).
 * Each must leave this list once its sites are fixed; the test fails when one
 * is clean and still listed.
 */
const PENDING = new Set<string>([])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) return sources(full)
    return /\.tsx?$/.test(d.name) && !/\.(?:test|spec)\.ts$/.test(d.name) ? [full] : []
  })
}

function hits(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of sources(src)) {
    const rel = path.relative(src, file)
    const all = readFileSync(file, 'utf8').split('\n')
    const lines = all.flatMap((line, i) =>
      SHAPES.some((re) => re.test(line)) && !EXEMPT.test(all[i - 1] ?? '') ? [`${rel}:${i + 1}: ${line.trim()}`] : [],
    )
    if (lines.length) out.set(rel, lines)
  }
  return out
}

describe('no raw error text in a log line (grep)', () => {
  it('🔴 no source file outside the pending list logs a raw error', () => {
    const found = [...hits()].filter(([rel]) => !PENDING.has(rel)).flatMap(([, lines]) => lines)
    expect(found).toEqual([])
  })

  it('every file on the pending list still has a site, or it leaves the list', () => {
    const found = hits()
    expect([...PENDING].filter((rel) => !found.has(rel))).toEqual([])
  })

  it.each([
    `console.error('[x] failed', err)`,
    `payload.logger.warn(\`[x] \${JSON.stringify(err)}\`)`,
    `console.error('[x]', err.toString())`,
    `payload.logger.warn(\`[x] \${error?.toString()}\`)`,
    `if (r.status === 'rejected') console.error('[x]', r.reason)`,
    `console.warn('[x]', { id, detail: r.reason })`,
    `payload.logger.warn(\`[x] \${r.reason}\`)`,
    `console.error('[x]', err.cause)`,
    `job.then(() => undefined, (boom) => console.error('[x]', boom))`,
    `job.then(ok, (boom) => console.warn(\`[x] \${boom}\`))`,
  ])('🔴 the shapes catch %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(true)
  })

  it.each([
    `console.error('[x] failed', errSummary(err))`,
    `payload.logger.error({ err }, '[x] failed')`,
    `payload.logger.warn({ err: r.reason }, '[x]')`,
    `console.error('[x]', err.cause?.name, err.cause.code)`,
    `console.log('[x]', n.toString())`,
    `console.warn('[x] gate not claimed', decision.reason)`,
    `payload.logger.info(\`[x] \${decision.reason}\`)`,
    `job.then((boom) => console.log('[x]', boom))`,
    `job.then(() => undefined, (boom) => console.error('[x]', safeErrMessage(boom)))`,
  ])('allows %s', (line) => {
    expect(SHAPES.some((re) => re.test(line))).toBe(false)
  })
})
