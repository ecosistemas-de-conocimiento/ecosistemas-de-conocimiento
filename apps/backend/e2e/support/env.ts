/**
 * READ THE LIVE STACK'S SECRETS AT RUNTIME. Never hardcode, never commit.
 *
 * The one source of truth is `infra/.env`, which is gitignored and lives in the
 * MAIN checkout. This file finds it and parses it the way Docker Compose does,
 * so a value here is the value the running containers actually saw.
 *
 * ⚠ Resolution order, and why there are three steps rather than one:
 *   1. `EDC_E2E_ENV_FILE` — an explicit override, for anyone running the suite
 *      against a stack whose env lives somewhere else.
 *   2. `<repo>/infra/.env` — the ordinary case.
 *   3. The MAIN worktree's `infra/.env` — because these tests are expected to be
 *      developed inside a `git worktree`, where the gitignored file does not
 *      exist. `.git` is a FILE in a linked worktree and points at
 *      `<main>/.git/worktrees/<name>`, which is how we get back to the main
 *      checkout without shelling out.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** apps/backend/e2e/support → apps/backend/e2e → apps/backend → apps → <repo> */
export const REPO_ROOT = path.resolve(here, '../../../..')
export const BACKEND_ROOT = path.resolve(here, '../..')
export const FIXTURES_DIR = path.resolve(here, '../fixtures')

/**
 * Parse a dotenv file. Deliberately narrow: `KEY=value`, full-line `#` comments
 * skipped, quotes stripped, and an UNQUOTED trailing ` # comment` removed —
 * which is exactly what Compose does, and `infra/.env` relies on it (several
 * values carry an inline annotation).
 */
export function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[key] = value
  }
  return out
}

function mainWorktreeRoot(): string | null {
  const dotGit = path.join(REPO_ROOT, '.git')
  try {
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return null // already the main checkout
    const contents = fs.readFileSync(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(contents)
    if (!match) return null
    // <main>/.git/worktrees/<name> → <main>
    return path.resolve(match[1].trim(), '../../..')
  } catch {
    return null
  }
}

export function envFilePath(): string | null {
  const override = process.env.EDC_E2E_ENV_FILE
  if (override && fs.existsSync(override)) return override

  const local = path.join(REPO_ROOT, 'infra', '.env')
  if (fs.existsSync(local)) return local

  const main = mainWorktreeRoot()
  if (main) {
    const candidate = path.join(main, 'infra', '.env')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

let cached: Record<string, string> | null = null

/** The stack's environment, or `null` when `infra/.env` cannot be found. */
export function stackEnv(): Record<string, string> | null {
  if (cached) return cached
  const file = envFilePath()
  if (!file) return null
  cached = parseDotenv(fs.readFileSync(file, 'utf8'))
  return cached
}

/**
 * A required secret, or a throw naming the variable AND the file it should be
 * in. A test that fails with "undefined is not a string" three frames deep
 * teaches nobody anything.
 */
export function requireEnv(name: string): string {
  const env = stackEnv()
  if (!env) {
    throw new Error(
      `[e2e] cannot read the stack's environment. Looked for infra/.env under ${REPO_ROOT} ` +
        `and under the main worktree. Set EDC_E2E_ENV_FILE=/path/to/infra/.env to point at it.`,
    )
  }
  const value = env[name]
  if (!value) {
    throw new Error(`[e2e] ${name} is missing or empty in ${envFilePath()}.`)
  }
  return value
}

/** Base URLs. Overridable so the suite can be pointed at a non-default stack. */
export const BACKEND_URL = (process.env.E2E_BACKEND_URL ?? 'http://localhost:3102').replace(
  /\/+$/,
  '',
)
export const AI_SERVICE_URL = (process.env.E2E_AI_SERVICE_URL ?? 'http://localhost:3101').replace(
  /\/+$/,
  '',
)
export const AUDIO_SERVICE_URL = (
  process.env.E2E_AUDIO_SERVICE_URL ?? 'http://localhost:3103'
).replace(/\/+$/, '')
