/**
 * A NARROW ESCAPE HATCH TO THE LIVE DATABASE — and the reason one exists.
 *
 * 🔴 THIS IS NOT A GENERAL-PURPOSE DB HELPER, AND MUST NOT BECOME ONE. Every
 * other assertion in this suite goes through HTTP on purpose: the API is the
 * whole surface, and a test that reaches around it stops proving anything about
 * the API. Exactly one thing cannot be done that way, and this file exists for
 * it alone.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 *
 * A hold is TERMINAL. `POST /api/holds/:id` flips the document to `approved` or
 * `rejected` and clears `heldText` / `anonymisationSurvivors`; nothing puts it
 * back, by design (see `lib/holdReview.ts`). And a held row cannot be CREATED
 * through the API either: `heldText`, `anonymisationSurvivors` and
 * `anonymisationStatus` are all `gateWritesOnly` on `collections/Documents.ts`,
 * so only the gate — a MODEL CALL, on an ingestable upload — can produce one.
 *
 * So the decision path has exactly two possible shapes as a test:
 *   (a) consume a held row that somebody hand-made, and leave the next person
 *       with nothing to review, or
 *   (b) make one, decide on it, and put the world back.
 *
 * (a) is how this fixture got destroyed once already. This file is (b).
 *
 * ── THE RULE THIS BUYS ───────────────────────────────────────────────────────
 *
 * ⚠ `holds.e2e.ts` NEVER decides on a hold it did not create. It seeds its own
 * `e2e-be-…`-namespaced held document here and decides on THAT. Any hold that
 * was already in the database — the hand-made review fixture, or whatever the
 * demo seed grows — is read, asserted against, and left holding.
 *
 * ⚠ The seeded row is LEFT BEHIND once decided, not deleted, which is the same
 * rule `support/world.ts` states for everything else this suite creates: a
 * suite that tidies up by deleting is one wrong `where` clause away from wiping
 * a colleague's stack. The row is cheap and its name says who made it.
 *
 * ⚠ IF THIS CANNOT REACH THE DATABASE THE DESTRUCTIVE TESTS SKIP, LOUDLY. They
 * do not fall back to deciding on somebody else's row. A skipped test is a gap;
 * a consumed fixture is damage.
 */

import { execFileSync } from 'node:child_process'

import { requireEnv, stackEnv } from './env'

/**
 * The compose project the stack runs under, and the service inside it.
 * Overridable because the port and the project name are the two things that
 * differ between one developer's stack and another's.
 */
const PROJECT = process.env.EDC_E2E_COMPOSE_PROJECT ?? 'edc'
const SERVICE = 'postgres'

/**
 * ⚠ Payload's database, NOT ai-service's. `docker-compose.yml` names it
 * `BACKEND_DB_NAME` and defaults it to `edc_backend`; the compose default is
 * repeated here because `infra/.env` usually does not set it at all.
 */
function databaseName(): string {
  return stackEnv()?.BACKEND_DB_NAME || 'edc_backend'
}

let containerCache: string | null | undefined

/**
 * The postgres container's name, found by its COMPOSE LABELS rather than by a
 * literal `edc-postgres-1`. Several unrelated compose projects run postgres on
 * this machine, so the project label is what makes the answer unambiguous.
 */
export function postgresContainer(): string | null {
  if (containerCache !== undefined) return containerCache
  try {
    const out = execFileSync(
      'docker',
      [
        'ps',
        '--filter',
        `label=com.docker.compose.project=${PROJECT}`,
        '--filter',
        `label=com.docker.compose.service=${SERVICE}`,
        '--format',
        '{{.Names}}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    containerCache = out.split('\n')[0]?.trim() || null
  } catch {
    containerCache = null
  }
  return containerCache
}

export interface DbAccess {
  ok: boolean
  reason: string
}

let probeCache: DbAccess | undefined

/**
 * Can we run SQL at all? Answered once, and the reason is written for a human
 * who has to decide whether a skip is expected.
 */
export function dbAccess(): DbAccess {
  if (probeCache) return probeCache
  const container = postgresContainer()
  if (!container) {
    probeCache = {
      ok: false,
      reason:
        `no running container with compose labels project=${PROJECT} service=${SERVICE}. ` +
        `Start the stack (cd infra && docker compose up -d --wait), or set ` +
        `EDC_E2E_COMPOSE_PROJECT if your project is named differently.`,
    }
    return probeCache
  }
  try {
    // 🔴 A ROW, not a zero exit status. psql exits 0 on an empty script, so
    // "the command succeeded" is compatible with "psql never saw any SQL" —
    // which is exactly what a missing `docker exec -i` looks like. Asking for a
    // value back is the only check that distinguishes them.
    const [row] = sql<{ ok: number }>('select 1 as ok')
    if (row?.ok !== 1) throw new Error('psql returned no rows for `select 1`')
    probeCache = { ok: true, reason: '' }
  } catch (err) {
    probeCache = {
      ok: false,
      reason: `psql in ${container} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return probeCache
}

/**
 * Run one statement and return the rows as JSON.
 *
 * ⚠ NO SHELL IS INVOLVED — `execFileSync` takes an argv array, so nothing here
 * can be quoted wrong into a different statement. Parameters go in as psql
 * variables (`-v`) and are referenced as `:'name'`, which makes psql apply its
 * own literal quoting.
 *
 * 🔴 THE SQL GOES IN ON STDIN, NOT VIA `-c`. psql does NOT perform variable
 * interpolation for a `-c` string — it hands it straight to the server, so
 * `:'name'` arrives as a literal colon and the server answers `syntax error at
 * or near ":"`. Interpolation only happens for input psql itself reads, which
 * means stdin. This cost a run to find; do not "simplify" it back to `-c`.
 */
export function sql<T = Record<string, unknown>>(
  statement: string,
  params: Record<string, string | number | null> = {},
): T[] {
  const container = postgresContainer()
  if (!container) throw new Error('[e2e] no postgres container — see dbAccess()')

  const vars: string[] = []
  for (const [key, value] of Object.entries(params)) {
    vars.push('-v', `${key}=${value === null ? '' : String(value)}`)
  }

  // `-A -t` plus a `row_to_json` wrapper: one JSON object per line, which
  // survives newlines inside a text column far better than psql's own columns.
  const out = execFileSync(
    'docker',
    [
      'exec',
      // 🔴 `-i` OR NOTHING HAPPENS. Without it `docker exec` does not attach stdin,
      // psql reads an empty script, prints nothing and EXITS 0 — so every query
      // returns no rows and every write silently does not happen, with no error
      // anywhere. This is why `dbAccess()` below checks for a ROW, not for a
      // zero exit status.
      '-i',
      '-e',
      `PGPASSWORD=${requireEnv('POSTGRES_PASSWORD')}`,
      container,
      'psql',
      '-U',
      requireEnv('POSTGRES_USER'),
      '-d',
      databaseName(),
      '-v',
      'ON_ERROR_STOP=1',
      ...vars,
      '-A',
      '-t',
    ],
    {
      encoding: 'utf8',
      input: `select row_to_json(t) from (${statement}) t;\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

/** Run a statement that returns nothing (INSERT/UPDATE/DELETE without RETURNING). */
export function exec(statement: string, params: Record<string, string | number | null> = {}): void {
  const container = postgresContainer()
  if (!container) throw new Error('[e2e] no postgres container — see dbAccess()')

  const vars: string[] = []
  for (const [key, value] of Object.entries(params)) {
    vars.push('-v', `${key}=${value === null ? '' : String(value)}`)
  }

  execFileSync(
    'docker',
    [
      'exec',
      // 🔴 `-i` OR NOTHING HAPPENS. Without it `docker exec` does not attach stdin,
      // psql reads an empty script, prints nothing and EXITS 0 — so every query
      // returns no rows and every write silently does not happen, with no error
      // anywhere. This is why `dbAccess()` below checks for a ROW, not for a
      // zero exit status.
      '-i',
      '-e',
      `PGPASSWORD=${requireEnv('POSTGRES_PASSWORD')}`,
      container,
      'psql',
      '-U',
      requireEnv('POSTGRES_USER'),
      '-d',
      databaseName(),
      '-v',
      'ON_ERROR_STOP=1',
      ...vars,
      '-A',
      '-t',
    ],
    { encoding: 'utf8', input: `${statement};\n`, stdio: ['pipe', 'pipe', 'pipe'] },
  )
}
