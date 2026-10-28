/**
 * `payload run` awaits only the script's import, then exits. A bare top-level
 * `main()` (or `main().catch(...)`) is killed at its first await, so the script
 * exits 0 having written nothing — measured on dev with seed-answer-style.ts.
 * Every script must `await main()` at top level.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts')

describe('scripts/*.ts', () => {
  it('never call main() at top level without await', () => {
    const offenders = readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        readFileSync(path.join(scriptsDir, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
          .filter(({ line }) => /^(void\s+)?main\(\)/.test(line))
          .map(({ at }) => at),
      )
    expect(offenders).toEqual([])
  })
})
