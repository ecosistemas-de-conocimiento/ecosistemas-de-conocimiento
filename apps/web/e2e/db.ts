/**
 * A NARROW ESCAPE HATCH TO THE LIVE DATABASE, for one job: MAKING A HELD
 * DOCUMENT so the review screens have something real to review.
 *
 * 🔴 NOT A GENERAL-PURPOSE HELPER. Everything else in this suite drives the app
 * through the browser, which is the point of a Playwright suite. Reaching past
 * the UI for anything a user can do would make the test stop proving the UI
 * works.
 *
 * ── WHY IT HAS TO EXIST ──────────────────────────────────────────────────────
 *
 * `/revision` only shows documents the anonymisation gate REFUSED. A hold
 * cannot be created through the API — `heldText`, `anonymisationSurvivors` and
 * `anonymisationStatus` are `gateWritesOnly` on `collections/Documents.ts` — and
 * the only other producer is the gate itself, which is a model call on an
 * ingestable upload and therefore not something a test can require to refuse.
 *
 * And a decision is TERMINAL: approving or rejecting clears the held text for
 * good. So a suite that drove the buttons on somebody else's hold would consume
 * it. That already happened once to the hand-made fixture in the shared dev
 * database.
 *
 * ⚠ SO: this suite SEEDS ITS OWN HOLD, decides on that, and never presses a
 * button on a hold it did not create. Rows already in the database are read and
 * left alone.
 *
 * Kept deliberately parallel to `apps/backend/e2e/support/db.ts`, the same way
 * `env.ts` and `fixtures.ts` mirror their backend counterparts.
 */

import { execFileSync } from 'node:child_process';

import { stackVar } from './env';

const PROJECT = process.env.EDC_E2E_COMPOSE_PROJECT ?? 'edc';
const SERVICE = 'postgres';

/** Payload's database, not ai-service's. Compose defaults it to `edc_backend`. */
function databaseName(): string {
  return stackVar('BACKEND_DB_NAME') ?? 'edc_backend';
}

let containerCache: string | null | undefined;

/**
 * The postgres container, found by COMPOSE LABELS rather than a literal
 * `edc-postgres-1` — several unrelated compose projects run postgres on a
 * developer machine, and the project label is what disambiguates.
 */
function container(): string | null {
  if (containerCache !== undefined) return containerCache;
  try {
    const out = execFileSync(
      'docker',
      [
        'ps',
        '--filter', `label=com.docker.compose.project=${PROJECT}`,
        '--filter', `label=com.docker.compose.service=${SERVICE}`,
        '--format', '{{.Names}}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    containerCache = out.split('\n')[0]?.trim() || null;
  } catch {
    containerCache = null;
  }
  return containerCache;
}

function psql(input: string, params: Record<string, string | number>): string {
  const name = container();
  if (!name) throw new Error('[e2e] no postgres container — see dbAvailable()');
  const user = stackVar('POSTGRES_USER');
  const password = stackVar('POSTGRES_PASSWORD');
  if (!user || !password) {
    throw new Error('[e2e] infra/.env has no POSTGRES_USER / POSTGRES_PASSWORD.');
  }

  const vars: string[] = [];
  for (const [key, value] of Object.entries(params)) vars.push('-v', `${key}=${value}`);

  return execFileSync(
    'docker',
    [
      'exec',
      // 🔴 `-i` OR NOTHING HAPPENS. Without it `docker exec` never attaches
      // stdin: psql reads an empty script, prints nothing, and EXITS 0. Every
      // query then returns no rows and every write silently does not happen,
      // with no error anywhere. That is why `dbAvailable()` checks for a ROW
      // rather than for a zero exit status.
      '-i',
      '-e', `PGPASSWORD=${password}`,
      name,
      'psql', '-U', user, '-d', databaseName(),
      // 🔴 The SQL goes in on STDIN, never `-c`: psql does not interpolate `:'x'`
      // variables into a `-c` string, it ships the literal colon to the server.
      '-v', 'ON_ERROR_STOP=1',
      ...vars,
      '-A', '-t',
    ],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export function query<T>(statement: string, params: Record<string, string | number> = {}): T[] {
  const out = psql(`select row_to_json(t) from (${statement}) t;\n`, params);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export function execute(statement: string, params: Record<string, string | number> = {}): void {
  psql(`${statement};\n`, params);
}

/**
 * Run a statement UNWRAPPED and return the first column of the first row.
 *
 * ⚠ Exists because `query()` wraps its argument in `select row_to_json(t) from
 * (…) t`, and Postgres refuses a data-modifying CTE anywhere but the top level:
 * `INSERT … RETURNING id` cannot go inside that subquery. So an insert gets its
 * id back through here instead.
 */
export function insertReturning(
  statement: string,
  params: Record<string, string | number> = {},
): string {
  const out = psql(`${statement};\n`, params);
  const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!first) throw new Error('[e2e] statement returned nothing');
  return first;
}

let probe: { ok: boolean; reason: string } | undefined;

/** Can we run SQL? Answered once, with a reason a human can act on. */
export function dbAvailable(): { ok: boolean; reason: string } {
  if (probe) return probe;
  if (!container()) {
    probe = {
      ok: false,
      reason:
        `no running container labelled project=${PROJECT} service=${SERVICE}. ` +
        'Start the stack (cd infra && docker compose up -d --wait), or set ' +
        'EDC_E2E_COMPOSE_PROJECT.',
    };
    return probe;
  }
  try {
    const [row] = query<{ ok: number }>('select 1 as ok');
    if (row?.ok !== 1) throw new Error('psql returned no rows for `select 1`');
    probe = { ok: true, reason: '' };
  } catch (err) {
    probe = { ok: false, reason: (err as Error).message };
  }
  return probe;
}
