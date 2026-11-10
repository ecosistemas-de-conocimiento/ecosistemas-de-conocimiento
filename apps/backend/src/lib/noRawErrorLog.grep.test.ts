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
  /console\.(?:log|info|warn|error|debug)\(.*,\s*(?:err|error|e|cause|\w+Err|\w+Error)\s*\)/,
  // A log field holding the error's text.
  /\berr: err instanceof Error \? err\.message/,
  /\berr: String\(err\)/,
  /\berr: \(err as Error\)\.message/,
]

/**
 * ⚠ Files other lanes were editing when this landed (wave 4, 2026-11-10).
 * Each must leave this list once its sites are fixed; the test fails when one
 * is clean and still listed.
 */
const PENDING = new Set([
  'app/api/ai-service/callback/route.ts',
  'collections/Documents.ts',
  'lib/publishDocument.ts',
  'payload.config.ts',
])

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
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (SHAPES.some((re) => re.test(line)) ? [`${rel}:${i + 1}: ${line.trim()}`] : []))
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
})
