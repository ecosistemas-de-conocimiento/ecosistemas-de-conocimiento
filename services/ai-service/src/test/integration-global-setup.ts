// Vitest `globalSetup` for the integration suite — owns the LIFETIME of the
// throwaway Postgres + Redis containers, and is the ONE place this repo's
// integration database is provisioned.
//
// Why globalSetup and not the setup file
// --------------------------------------
// `setupFiles` look like the obvious home for this, and they are wrong for it.
// Vitest isolates test FILES by default, so a setup file re-executes once per
// file even inside a single fork. Starting containers there means starting
// them N times; and because each start first removes any container of the same
// name, run N+1 kills the database run N is still talking to. Observed exactly
// that: `ECONNREFUSED` against three different ephemeral Redis ports in one
// run, plus two containers surviving the suite because only the last file's
// teardown fired.
//
// `globalSetup` runs ONCE per vitest invocation, in the main process, before
// any worker is forked — so the env vars it sets are inherited by every worker,
// and its `teardown` runs once at the very end.
//
// 🔴 THAT ORDERING IS ALSO WHY THE GUARDS LIVE HERE. `baseDatabaseUrl()` must be
// read BEFORE `integration-setup.ts` rebinds `process.env.DATABASE_URL` to the
// test URL inside each worker. After that rebind the throwaway guard would be
// comparing a value with itself, refusing every run — chat-backend has that
// exact trap on record. Here nothing has rebound anything yet.
//
// What it does NOT do: override anything the caller supplied. If
// TEST_DATABASE_URL / TEST_REDIS_URL are already set, they win and no container
// is started (and none is removed at the end — removing a container the caller
// provided would be a nasty surprise).
//
// 🔴 THERE IS NO SKIP PATH. Every branch below either resolves a database or
// THROWS. A skipped integration test is indistinguishable from a passing one.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { dockerAvailable, startThrowawayPg } from './docker-pg.js';
import { startThrowawayRedis } from './docker-redis.js';
import {
  INTEGRATION_DATABASES,
  baseDatabaseUrl,
  databaseOf,
  requireIntegrationDb,
} from './integration-database.js';

// Container names are per CHECKOUT, not host-wide: a fixed name let a second
// checkout's run `docker rm -f` this run's containers mid-suite (its startup
// clears "strays" by name). Stable per path, so a stray from an interrupted
// run of THIS checkout is still cleared.
const CHECKOUT_TAG = createHash('sha1')
  .update(fileURLToPath(new URL('../..', import.meta.url)))
  .digest('hex')
  .slice(0, 8);
const PG_CONTAINER = `ai-svc-integration-pg-${CHECKOUT_TAG}`;
const REDIS_CONTAINER = `ai-svc-integration-redis-${CHECKOUT_TAG}`;

/** Teardown handles for containers THIS process started. */
const stops: Array<() => void> = [];

const SPEC = INTEGRATION_DATABASES.integration!;

export async function setup(): Promise<void> {
  // Read the dev cluster's identity FIRST — see the header. Nothing has
  // rebound `DATABASE_URL` at this point, and nothing may before this line.
  const baseUrl = baseDatabaseUrl();

  const needsPg = process.env.TEST_DATABASE_URL === undefined;
  const needsRedis = process.env.TEST_REDIS_URL === undefined;
  const docker = needsPg || needsRedis ? dockerAvailable() : false;

  // ── Postgres ─────────────────────────────────────────────────────────────
  // Docker is the DEFAULT and the strongest option: a server we started cannot
  // be somebody else's. Without it, `requireIntegrationDb` falls back to
  // provisioning a SEPARATE database on the cluster `DATABASE_URL` names, and
  // failing loudly if there is no such cluster either.
  if (needsPg && docker) {
    const pg = await startThrowawayPg({
      containerName: PG_CONTAINER,
      portEnvVar: 'AI_SVC_TEST_INTEGRATION_PG_PORT',
      database: SPEC.database,
      // 🔴 Boot with only the cluster default so `requireIntegrationDb` is what
      // CREATES this suite's database — one provisioning entry point, including
      // on the docker path. Without this the entrypoint makes the database, it
      // arrives with no schema stamp, and every docker run reports a REBUILD.
      bootDatabase: 'postgres',
    });
    stops.push(pg.stop);
    // Inherited by every forked worker — globalSetup runs before they spawn.
    process.env.TEST_DATABASE_URL = pg.url;
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  // ⚠ Redis has NO derived fallback. There is no `REDIS_URL`-derived
  // equivalent of "a second database on the same cluster": a Redis logical
  // database is a number, not a namespace, and picking one on the live fleet
  // Redis (56379) would share keyspace with running services. So: a container,
  // an explicit URL, or a failure.
  if (needsRedis) {
    if (!docker) {
      throw new Error(
        'Integration setup: no Redis to connect to, so this suite FAILS rather than skipping.\n\n' +
          'TEST_REDIS_URL is unset and Docker is not available, so it cannot start its own ' +
          'throwaway container. This suite uses BullMQ; there is nothing to fall back to.\n\n' +
          'There is deliberately NO default host:port: on this fleet, 56379 is the live fleet ' +
          "Redis and 55432 has held an unrelated product's LIVE Postgres.\n\n" +
          'Either start Docker, or point the suite at services you know are disposable:\n' +
          "  export TEST_REDIS_URL='redis://127.0.0.1:PORT'\n" +
          `  export TEST_DATABASE_URL='postgres://user:pass@127.0.0.1:PORT/${SPEC.database}'`,
      );
    }
    const redis = await startThrowawayRedis({
      containerName: REDIS_CONTAINER,
      portEnvVar: 'AI_SVC_TEST_INTEGRATION_REDIS_PORT',
    });
    stops.push(redis.stop);
    process.env.TEST_REDIS_URL = redis.url;
  }

  // ── Provision, guard, migrate, stamp, clean ──────────────────────────────
  // Everything destructive happens inside this call, behind the name guard,
  // the throwaway guard and the ownership guard. It throws if it cannot find a
  // database; it never returns a half-built one.
  const provisioned = await requireIntegrationDb(SPEC, { baseUrl });
  process.env.TEST_DATABASE_URL = provisioned.url;

  // One line, always. A run that silently rebuilt someone's database, or
  // silently trusted a stale one, is exactly what this machinery exists to make
  // visible — so it says which happened rather than leaving it to be inferred.
  const state = provisioned.created
    ? 'created'
    : provisioned.rebuilt
      ? 'REBUILT (schema stamp did not match the migrations on disk)'
      : 'reused (schema stamp matches)';
  const wiped = provisioned.truncated.length
    ? `, emptied ${provisioned.truncated.length} fixture table(s)`
    : '';
  console.log(
    `[integration] ${databaseOf(provisioned.url)} ${state} @ ${provisioned.fingerprint}${wiped}`,
  );
}

export function teardown(): void {
  for (const stop of stops) {
    try {
      stop();
    } catch {
      /* best-effort: the container may already be gone */
    }
  }
  stops.length = 0;
}
