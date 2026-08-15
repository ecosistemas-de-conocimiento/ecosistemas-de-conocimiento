// Throwaway Postgres (pgvector) container for the docker-backed route tests.
//
// Shared by `routes/registry.test.ts` and `routes/tenant-provision.test.ts`,
// which both need a REAL database (partial unique indexes, transactions, the
// `LEAST(...)` budget clamp) and both used to carry their own near-identical
// copy of this harness.
//
// 🔴 Why the host port is EPHEMERAL (`-p 0:5432`)
//
// These suites used to publish fixed host ports: 55432 for the registry suite,
// 55433 for the tenant suite. 55432 is also the port `infra/docker-compose.yml`
// publishes for the local demo's Postgres. So the moment anyone had the demo
// running, `docker run -p 55432:5432` failed with "port is already allocated",
// `beforeAll` threw, and 13 tests were reported as a hard suite failure — for a
// reason that had nothing to do with the code under test.
//
// Two other fixes were on the table and both are worse:
//
//   - A different fixed port only MOVES the collision. Nothing reserves 55433,
//     a second worktree running the same suite collides with itself, and the
//     next service added to docker-compose re-opens the bug silently.
//   - Detecting the collision and skipping keeps the suite green but deletes
//     the coverage exactly on the machines where a developer is most likely to
//     be changing this code — the ones with the stack up. A test that skips
//     when the environment gets busy is not a gate.
//
// Binding host port 0 lets the kernel pick a free port; we read the assignment
// back out of `docker port`. There is then no port to collide with, no env var
// to remember, and the suite runs alongside the live stack. Nothing outside the
// test process needs to know the port. To poke at the DB during a debugging
// session, ask docker: `docker port ai-svc-registry-test 5432`.
//
// The container NAME stays fixed and predictable on purpose: `start()` force-
// removes a same-named leftover first, which is what recovers from a previous
// run that was interrupted before `afterAll` could clean up. Callers must use
// distinct names — vitest runs test files in parallel.

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import postgres from 'postgres';

const IMAGE = 'pgvector/pgvector:pg16';
const DB_NAME = 'ai_service_test';

export interface PgContainer {
  /** `postgres://…` URL pointing at the container's kernel-assigned host port. */
  url: string;
  /** The host port docker assigned. Useful in failure messages. */
  port: number;
  /** Force-remove the container. Safe to call twice. */
  stop(): void;
}

/**
 * True when docker is usable. `which docker` succeeds even when the daemon is
 * dead, so the daemon is probed too.
 */
export function hasDocker(): boolean {
  const which = spawnSync('which', ['docker'], { stdio: 'ignore' });
  if (which.status !== 0) return false;
  const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return info.status === 0;
}

export function stopContainer(name: string): void {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}

/** Read back the host port docker bound to the container's 5432. */
function readAssignedPort(name: string): number {
  // `docker port <name> 5432/tcp` prints one line per binding:
  //   0.0.0.0:32769
  //   [::]:32769
  const res = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `Could not read the published port of container '${name}': ${res.stderr?.trim() ?? ''}`,
    );
  }
  const first = res.stdout.split('\n').find((l) => l.trim().length > 0);
  const port = Number(first?.trim().split(':').pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Could not parse the published port of container '${name}' from: ${JSON.stringify(res.stdout)}`,
    );
  }
  return port;
}

/**
 * Wait until the container's Postgres accepts connections AND the forwarded
 * host:port completes a `select 1` round-trip.
 *
 * Two stages because `pg_isready` (run inside the container) can succeed
 * seconds before the port-forwarded socket is usable — connecting too early
 * yields ECONNRESET.
 */
async function waitForPg(name: string, url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Stage 1: container-local readiness.
  while (Date.now() < deadline) {
    const res = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', DB_NAME]);
    if (res.status === 0) break;
    await delay(250);
  }

  // Stage 2: externally usable. Retry a real query until it succeeds.
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 });
      await probe`select 1`;
      await probe.end({ timeout: 2 });
      return true;
    } catch {
      await delay(500);
    }
  }
  return false;
}

/**
 * Start a throwaway pgvector container on a kernel-assigned host port and wait
 * for it to accept queries.
 *
 * Throws with docker's own stderr on failure — the previous `execSync(…, {
 * stdio: 'ignore' })` swallowed it, so a port clash surfaced as the useless
 * `Command failed: docker run …` with no cause attached.
 */
export async function startPostgres(
  name: string,
  { readyTimeoutMs = 60_000 }: { readyTimeoutMs?: number } = {},
): Promise<PgContainer> {
  // Clear a leftover from a run that was interrupted before cleanup.
  stopContainer(name);

  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      // Host port 0 = "kernel, pick a free one". See the header.
      '-p',
      '0:5432',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      `-e`,
      `POSTGRES_DB=${DB_NAME}`,
      IMAGE,
    ],
    { encoding: 'utf8' },
  );

  if (run.status !== 0) {
    throw new Error(
      `Failed to start the throwaway Postgres container '${name}' from ${IMAGE}.\n` +
        `docker exited ${run.status}: ${(run.stderr ?? '').trim() || '(no stderr)'}\n` +
        `The host port is ephemeral, so this is NOT a port clash — check that the ` +
        `image is pulled (\`docker pull ${IMAGE}\`) and that the daemon has room.`,
    );
  }

  const port = readAssignedPort(name);
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/${DB_NAME}`;

  if (!(await waitForPg(name, url, readyTimeoutMs))) {
    stopContainer(name);
    throw new Error(
      `Postgres in container '${name}' (host port ${port}) did not accept queries ` +
        `within ${readyTimeoutMs} ms.`,
    );
  }

  return { url, port, stop: () => stopContainer(name) };
}
