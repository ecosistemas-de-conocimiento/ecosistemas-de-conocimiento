// Test-only helper: start a throwaway Postgres container on an EPHEMERAL host
// port and tell the caller which port it landed on.
//
// Why this exists
// ---------------
// Docker-backed test files used to publish a hardcoded host port
// (`-p 55432:5432`). That is a bet that no other process on the machine wants
// that number, and the bet loses: this repo's suite went red for days because
// 55432 was held by an unrelated product's live Postgres. Picking a different
// hardcoded number just moves the collision — on this workstation alone,
// 55432/55455/55532/55732/56379/56380/59000/59001 are all taken by other
// stacks. Any fixed number is a time bomb waiting for the next `docker
// compose up`.
//
// So we don't pick. `-p 127.0.0.1::5432` asks the Docker daemon to allocate a
// free host port from the ephemeral range and bind it itself, which is
// race-free in a way "probe a port, then bind it later" is not. We then read
// the assignment back with `docker port` and build the connection URL from it.
//
// Binding to 127.0.0.1 (rather than 0.0.0.0) keeps a test database off the
// network while the suite runs.
//
// An explicit port can still be forced via the caller's `portEnvVar`, for the
// case where someone needs a stable port to attach psql to a hung test.

import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import postgres from 'postgres';

import {
  assertClusterIsOurs,
  THROWAWAY_DATABASE_NAME,
  withDatabase,
} from './integration-database.js';

export interface ThrowawayPgOptions {
  /** `--name` for the container. Must be unique per test FILE: vitest may run files in parallel. */
  containerName: string;
  /** Image to run. Defaults to the pgvector image the service targets. */
  image?: string;
  /** Database segment of the returned `url`. */
  database?: string;
  /**
   * The database the container's ENTRYPOINT creates, and the one the readiness
   * probe connects to. Defaults to `database`, so existing callers are
   * unchanged: the container creates it and the URL names it.
   *
   * 🔴 The integration lane passes `'postgres'` instead, so that the container
   * boots with only the cluster's default database and `integration-database.
   * ts`'s `provisionDatabase()` is what brings `ai_service_test` into
   * existence. That keeps CREATE DATABASE in ONE place — the place a future
   * `CREATE DATABASE ... TEMPLATE` would be swapped in — instead of splitting
   * it between this helper's `POSTGRES_DB` and that function. It also stops
   * every docker-path run reporting a REBUILD: a database the entrypoint made
   * carries no schema stamp, and an unstamped database is stale by definition.
   */
  bootDatabase?: string;
  /**
   * Env var that, when set, forces a specific host port instead of an
   * ephemeral one. Escape hatch for debugging; unset in normal runs.
   */
  portEnvVar?: string;
}

export interface ThrowawayPg {
  /** The host port Docker actually bound. */
  port: number;
  /** `postgres://…@127.0.0.1:<port>/<database>` for the running container. */
  url: string;
  /** The same cluster, connected to the database the entrypoint created. */
  bootUrl: string;
  /** Force-remove the container. Safe to call twice. */
  stop: () => void;
}

/**
 * `which docker` succeeds even when the daemon is dead; require `docker info`
 * to be reachable too, or every docker-backed suite fails for an environment
 * reason rather than skipping.
 */
export function dockerAvailable(): boolean {
  const which = spawnSync('which', ['docker'], { stdio: 'ignore' });
  if (which.status !== 0) return false;
  const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return info.status === 0;
}

/**
 * Force-remove a container, ignoring "no such container". `-v` also removes
 * its anonymous volumes: the postgres and redis images both declare a
 * `VOLUME`, and without `-v` each run orphans one on the host disk.
 */
export function removeContainer(name: string): void {
  spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
}

/**
 * Ask Docker which host port it bound for the container's `<containerPort>/tcp`.
 *
 * Output looks like `127.0.0.1:32771`; with several bindings it is one per
 * line. Returns null while the mapping is not published yet.
 *
 * Exported because every throwaway-service helper needs the same read-back —
 * see `docker-redis.ts`. The parameter defaults to Postgres's port so existing
 * callers are unchanged.
 */
export function mappedPort(containerName: string, containerPort = 5432): number | null {
  let out: string;
  try {
    out = execFileSync('docker', ['port', containerName, `${containerPort}/tcp`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  for (const line of out.split('\n')) {
    const port = Number(line.trim().split(':').pop());
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/**
 * Block until the server ACCEPTS a real connection, not merely until the host
 * port exists.
 *
 * ── The race this closes (observed) ────────────────────────────
 * `docker run -d` returns as soon as the container is created, and Docker
 * publishes the host port immediately after. Postgres inside is still running
 * `initdb` for a second or two, and during that window `initdb`'s temporary
 * server listens on a UNIX SOCKET ONLY. A host connection therefore reaches
 * docker-proxy, which accepts the TCP handshake and then finds nothing to
 * forward to — the client sees `read ECONNRESET`, NOT `ECONNREFUSED`, which is
 * why this never looked like "not started yet".
 *
 * `startThrowawayPg` used to return as soon as `docker port` answered, so the
 * FIRST integration file to run raced `initdb` and lost roughly half the time.
 * Vitest orders files LARGEST-FIRST, so which file draws that straw changes
 * whenever a test file's byte size changes — a suite that is green today goes
 * red when an unrelated file grows a few lines. That is the "known ECONNRESET
 * flake" this suite carried.
 *
 * A TCP probe is NOT enough here, for the docker-proxy reason above: only a
 * completed startup + auth handshake proves the backend is serving. Hence a
 * real query.
 */
async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'none';
  for (;;) {
    const client = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1 });
    try {
      await client`select 1`;
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        throw new Error(
          `Postgres at ${url} never accepted a connection within ${timeoutMs}ms. ` +
            `Last error: ${lastError}`,
        );
      }
      await delay(250);
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  }
}

/**
 * Start the container and return its connection details. The caller is
 * responsible for calling `stop()` in `afterAll`.
 *
 * Throws (rather than returning a broken URL) if the port mapping never shows
 * up — a silent fallback to a default port is exactly the failure mode this
 * helper exists to remove.
 *
 * Returns only once the database is actually SERVING (see `waitForPostgres`),
 * so callers never have to retry the first query themselves.
 */
export async function startThrowawayPg(opts: ThrowawayPgOptions): Promise<ThrowawayPg> {
  const {
    containerName,
    image = 'pgvector/pgvector:pg16',
    database = 'ai_service_test',
    portEnvVar,
  } = opts;
  const bootDatabase = opts.bootDatabase ?? database;

  // Kill any stray container from a previous interrupted run.
  removeContainer(containerName);

  const forced = portEnvVar ? Number(process.env[portEnvVar]) : NaN;
  const publish = Number.isInteger(forced) && forced > 0 ? `${forced}:5432` : '127.0.0.1::5432';

  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      // Data on tmpfs: the image declares `VOLUME /var/lib/postgresql/data`,
      // so without this every run leaves an anonymous volume behind. RAM is
      // also faster than disk for a throwaway database.
      '--tmpfs',
      '/var/lib/postgresql/data',
      '--name',
      containerName,
      '-p',
      publish,
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      `POSTGRES_DB=${bootDatabase}`,
      image,
    ],
    { stdio: 'ignore' },
  );

  // `docker run -d` returns once the container is created; the port table can
  // lag it by a few milliseconds.
  let port: number | null = null;
  for (let i = 0; i < 40 && port === null; i++) {
    port = mappedPort(containerName);
    if (port === null) await delay(100);
  }
  if (port === null) {
    removeContainer(containerName);
    throw new Error(
      `docker never published a host port for ${containerName}:5432 — cannot reach the test database`,
    );
  }

  const url = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;
  const bootUrl = `postgres://postgres:postgres@127.0.0.1:${port}/${bootDatabase}`;
  try {
    // ⚠ Probe the BOOT database, not `url`. When the two differ, `url` names a
    // database nothing has created yet, and the probe would loop until timeout.
    await waitForPostgres(bootUrl);
  } catch (err) {
    removeContainer(containerName);
    throw err;
  }

  return {
    port,
    url,
    bootUrl,
    stop: () => removeContainer(containerName),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// EXTERNALLY SUPPLIED CLUSTER — the CI path.
//
// A workflow `services:` block starts a Postgres container ALONGSIDE the job,
// not inside it. That helps a suite which connects to a URL; it does nothing
// for a suite that shells out to `docker run` itself, which is what
// `startThrowawayPg` above does. So the docker-gated unit suites need a second
// way in: given a cluster URL, make a FRESH database on it per test FILE.
//
// Per FILE, not per suite: vitest runs test files in PARALLEL workers, so two
// files sharing one database would migrate and truncate on top of each other.
// Each caller passes its own name.
//
// ⚠ AN UNCONFIGURED MACHINE STILL USES DOCKER. This path is taken only when
// someone SET $AI_SVC_TEST_PG_URL on purpose — the check runs first so a CI job
// with both never pays for `docker info`, but nothing falls into it by default.
// That matters because a server we started cannot be somebody else's, and this
// path gives that property up; `assertClusterIsOurs` is what stands in for it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * What a caller needs from EITHER path — a URL to an empty database, and a way
 * to give it back. `ThrowawayPg` above satisfies this structurally.
 *
 * `stop()` is `void | Promise<void>` because the two paths genuinely differ:
 * `docker rm -f` is synchronous, `DROP DATABASE` is not. Callers `await` it
 * either way.
 */
export interface TestPostgres {
  /** `postgres://…/<database>` for a freshly created, empty database. */
  url: string;
  /** Release it. Safe to call twice; never throws. */
  stop: () => void | Promise<void>;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * DROP + CREATE `database` on the cluster named by `clusterUrl`, and return a
 * URL pointing at it.
 *
 * Unconditionally destructive on that ONE name, which is why the name has to
 * clear `THROWAWAY_DATABASE_NAME` — the same allowlist the integration lane
 * uses, imported rather than restated so the two cannot drift. `_test` as a
 * suffix would not be enough: the check is an allowlist of names ai-service
 * creates, not a denylist of names it refuses.
 *
 * `WITH (FORCE)` terminates leftover sessions from a killed run. It is safe
 * here for the same reason it is safe in `integration-database.ts`: the target
 * is a database this helper creates and owns, and nothing else connects to it.
 */
export async function createDatabaseOnCluster(
  clusterUrl: string,
  database: string,
): Promise<TestPostgres> {
  if (!THROWAWAY_DATABASE_NAME.test(database)) {
    throw new Error(
      `refusing to create "${database}": not a recognised ai-service throwaway ` +
        `(expected ${THROWAWAY_DATABASE_NAME}). Rename the database; do not widen the guard.`,
    );
  }
  // ⚠ Postgres truncates identifiers over 63 bytes SILENTLY, which would make
  // two suites share one database without either noticing.
  if (Buffer.byteLength(database) > 63) {
    throw new Error(
      `database name "${database}" is ${Buffer.byteLength(database)} bytes; ` +
        'Postgres truncates identifiers at 63 and does it silently.',
    );
  }

  const adminUrl = withDatabase(clusterUrl, 'postgres');
  const url = withDatabase(clusterUrl, database);

  // The cluster is somebody else's until proven otherwise, and it is reachable
  // before it is ready: a service container is health-checked by the runner,
  // but a hand-started one on a workstation is not.
  await waitForPostgres(adminUrl, 60_000);

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await assertClusterIsOurs(admin, url, '', `createDatabaseOnCluster(${database})`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }

  await waitForPostgres(url, 30_000);

  return {
    url,
    stop: async () => {
      const cleanup = postgres(adminUrl, { max: 1 });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
      } catch {
        /* a leftover database is noise, not a test failure */
      } finally {
        await cleanup.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}
