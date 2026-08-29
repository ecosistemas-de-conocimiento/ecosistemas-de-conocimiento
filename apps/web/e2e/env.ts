import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the seeded admin credentials out of `infra/.env` AT RUNTIME.
 *
 * 🔴 Never hardcode them, never write them into a fixture, never print them.
 * `infra/.env` is gitignored; this module only ever returns the two values a
 * sign-in needs, and every error message below names the FILE and the KEY and
 * nothing else.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/web/e2e` → repo root. */
const repoRoot = resolve(here, '../../..');

/**
 * Where `infra/.env` lives, in order of preference.
 *
 * The third candidate matters when these tests run from a git WORKTREE: an
 * untracked file like `infra/.env` exists only in the main checkout, and
 * `--git-common-dir` is the one reliable pointer back to it.
 */
function envFileCandidates(): string[] {
  const out: string[] = [];
  if (process.env.EDC_ENV_FILE) out.push(resolve(process.env.EDC_ENV_FILE));
  out.push(resolve(repoRoot, 'infra/.env'));
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (common) out.push(resolve(common, '../infra/.env'));
  } catch {
    /* not a git checkout, or no git on PATH — the other candidates still apply */
  }
  return out;
}

/** Minimal dotenv reader: `KEY=VALUE`, `#` comments, optional quotes. */
function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

export interface AdminCredentials {
  email: string;
  password: string;
}

let cached: AdminCredentials | null = null;

/**
 * The seeded admin's credentials. Env vars win, so CI can inject them without
 * a file on disk; otherwise the first readable `infra/.env` wins.
 */
export function adminCredentials(): AdminCredentials {
  if (cached) return cached;

  const fromProcess = {
    email: process.env.SEED_ADMIN_EMAIL,
    password: process.env.SEED_ADMIN_PASSWORD,
  };
  if (fromProcess.email && fromProcess.password) {
    cached = { email: fromProcess.email, password: fromProcess.password };
    return cached;
  }

  const candidates = envFileCandidates();
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find infra/.env. Looked at:\n  ${candidates.join('\n  ')}\n` +
        'Set EDC_ENV_FILE, or export SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.',
    );
  }

  const vars = parseDotenv(readFileSync(found, 'utf8'));
  const email = vars.get('SEED_ADMIN_EMAIL');
  const password = vars.get('SEED_ADMIN_PASSWORD');
  if (!email || !password) {
    // Names the keys, never the values.
    throw new Error(
      `${found} is missing SEED_ADMIN_EMAIL and/or SEED_ADMIN_PASSWORD.`,
    );
  }

  cached = { email, password };
  return cached;
}

/** Directory holding the upload fixtures (`e2e/fixtures`). */
export const fixturesDir = resolve(here, 'fixtures');

let stackVars: Map<string, string> | null = null;

/**
 * Any other value out of `infra/.env` — the stack's own environment, read the
 * way Compose read it.
 *
 * ⚠ Used for the database credentials in `e2e/db.ts` and NOTHING ELSE. Every
 * other value this suite needs is either a URL it can be pointed at or one of
 * the two seeded credentials above. A process env var of the same name wins, so
 * CI can inject without a file on disk.
 *
 * 🔴 Returns the value, never logs it. Same rule as `adminCredentials()`.
 */
export function stackVar(name: string): string | null {
  if (process.env[name]) return process.env[name] as string;
  if (!stackVars) {
    const found = envFileCandidates().find((p) => existsSync(p));
    stackVars = found ? parseDotenv(readFileSync(found, 'utf8')) : new Map();
  }
  return stackVars.get(name) ?? null;
}

/** The backend's REST base URL, for the bits of provisioning the UI cannot do. */
export const backendUrl = (
  process.env.EDC_BACKEND_URL ?? 'http://localhost:45402'
).replace(/\/+$/, '');
