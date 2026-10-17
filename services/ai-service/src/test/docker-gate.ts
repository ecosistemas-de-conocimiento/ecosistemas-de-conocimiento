// THE PREREQUISITE GATE: skip locally, FAIL IN CI.
//
// ── The defect this closes (FG-12) ──────────────────────────────────────────
// Three suites used to gate themselves on `describe.skipIf(!dockerAvailable())`
// and friends. `skipIf` has exactly one behaviour: the suite reports ZERO tests
// and the run is green. That is the right answer on a developer laptop with no
// Docker daemon, and the WRONG answer on a CI runner, where "the prerequisite
// is missing" is a broken pipeline, not an environment preference.
//
// Measured cost of the old shape: on a runner with no daemon,
// `src/routes/registry.test.ts` (13 tests) and
// `src/routes/tenant-provision.test.ts` (6 tests) both vanish. What stops being
// executed is precisely the SQL those files exist for — the budget upsert's
// `LEAST(remaining, cap)` clamp, the partial-unique index on
// `registry_entries.is_active`, and the audit-row writer. None of it is covered
// anywhere else, because the mocked-db siblings (`tenant.test.ts`,
// `budget.test.ts`) prove the wiring and would accept a malformed SQL
// expression happily. The job still exits 0 and the deploy gate still opens.
//
// ── The rule ────────────────────────────────────────────────────────────────
//   NOT in CI + no Postgres obtainable  → skip (returns true).
//   IN CI     + no Postgres obtainable  → THROW at module scope.
//
// The throw is the point. A module-scope throw makes vitest fail to COLLECT the
// file, which is a hard non-zero exit that names the file — as opposed to a
// silent zero-test suite, which nothing downstream can see. It is deliberately
// not a `beforeAll` throw: a collection failure cannot be mistaken for a flaky
// fixture, and it fires before any container is started.
//
// ⚠ THIS FILE MUST NOT IMPORT ANYTHING THAT NEEDS A DATABASE. It is evaluated
// at module scope in the UNIT lane, which runs with no Postgres, no Redis and
// no Docker.

import { dockerAvailable } from './docker-pg.js';

/**
 * The env var naming an ALREADY-RUNNING Postgres cluster the suites may
 * provision throwaway databases on.
 *
 * ⚠ DELIBERATELY NOT `TEST_DATABASE_URL`. That name is consumed by
 * `src/test/integration-global-setup.ts` and rebinds the INTEGRATION lane's
 * database; setting it on a unit-suite job would silently change a different
 * lane's behaviour. This one is read by the unit lane only.
 */
export const TEST_CLUSTER_ENV_VAR = 'AI_SVC_TEST_PG_URL';

/**
 * Are we on a CI runner?
 *
 * Both signals are checked because neither is universal: GitHub Actions sets
 * `CI=true` AND `GITHUB_ACTIONS=true`, most other runners set only `CI`, and a
 * developer who has `CI` exported for an unrelated reason gets the strict
 * behaviour — which is the safe direction to be wrong in.
 */
export const isCi = (): boolean => {
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  const ci = (process.env.CI ?? '').trim().toLowerCase();
  return ci === 'true' || ci === '1';
};

/**
 * The externally supplied cluster URL, or undefined when none is set.
 *
 * An empty / whitespace-only value counts as UNSET on purpose: `env: { FOO: '' }`
 * in a workflow is how a variable gets accidentally blanked, and treating it as
 * "set" would send the suite at `postgres:///` and fail with a connection error
 * instead of the gate's own message.
 */
export const externalTestClusterUrl = (): string | undefined => {
  const raw = process.env[TEST_CLUSTER_ENV_VAR];
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
};

/** Where a real Postgres would come from for this run, if anywhere. */
export type TestPostgresSource = 'external-cluster' | 'docker' | 'none';

/**
 * Resolve the source WITHOUT starting anything.
 *
 * Order matters: the external cluster is checked FIRST so that a CI runner
 * which has both a service container and a Docker daemon takes the cheap path
 * and never spawns `docker info`.
 */
export const testPostgresSource = (): TestPostgresSource => {
  if (externalTestClusterUrl() !== undefined) return 'external-cluster';
  if (dockerAvailable()) return 'docker';
  return 'none';
};

/**
 * Should this suite skip for want of a real Postgres?
 *
 * Returns true ONLY on a developer machine. In CI a missing prerequisite
 * throws, so the caller never receives `true` there.
 *
 * Call it at MODULE SCOPE:
 *
 *     // skip-reason: <reason>
 *     describe.skipIf(skipWithoutTestPostgres('registry routes'))('…', () => { … })
 */
export const skipWithoutTestPostgres = (suiteName: string): boolean => {
  if (testPostgresSource() !== 'none') return false;
  if (!isCi()) return true;

  throw new Error(
    [
      `🔴 CI HAS NO TEST POSTGRES — refusing to skip "${suiteName}".`,
      '',
      'What was checked, in order:',
      `  1. $${TEST_CLUSTER_ENV_VAR} — UNSET (or empty). This names an already-running`,
      '     Postgres cluster the suite provisions a throwaway database on.',
      '  2. a reachable Docker daemon — `which docker` or `docker info` failed, so the',
      '     suite cannot start its own throwaway pgvector container either.',
      '',
      'Why this is a hard failure and not a skip:',
      '  This suite is the ONLY thing that executes its SQL against a real server. Its',
      '  mocked-db siblings prove the wiring and would accept a malformed SQL expression',
      '  that only explodes in production. Skipping it leaves the job green while the',
      '  coverage it reports is not there.',
      '',
      'What the runner must provide (either one is enough):',
      `  · a Postgres SERVICE container plus ${TEST_CLUSTER_ENV_VAR}, e.g.`,
      '',
      '      services:',
      '        postgres:',
      '          image: pgvector/pgvector:pg16',
      '          env: { POSTGRES_USER: ai_service, POSTGRES_PASSWORD: ai_service,',
      '                 POSTGRES_DB: ai_service_test }',
      '          ports: ["5432:5432"]',
      '      env:',
      `        ${TEST_CLUSTER_ENV_VAR}: postgres://ai_service:ai_service@localhost:5432/postgres`,
      '',
      '  · or a runner with a working Docker daemon (github-hosted `ubuntu-latest` has one;',
      '    a container-based or restricted self-hosted runner may not).',
      '',
      `⚠ Do NOT "fix" this by widening the gate. Setting ${TEST_CLUSTER_ENV_VAR} to a cluster`,
      '  that is not ours is refused separately by `assertClusterIsOurs`.',
      '',
      'A developer with neither still gets a clean skip — this message is CI-only',
      `(CI=${process.env.CI ?? '<unset>'}, GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? '<unset>'}).`,
    ].join('\n'),
  );
};
