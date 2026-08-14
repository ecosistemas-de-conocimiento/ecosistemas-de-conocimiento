// Integration tests for /v1/registry/*.
//
// These tests need a real Postgres because they exercise transactions, the
// partial-unique index on `registry_entries.is_active`, and the audit-row
// writer. We spin up a throwaway `pgvector/pgvector:pg16` container on port
// 55432 in `beforeAll` and tear it down in `afterAll`.
//
// If docker isn't available (e.g. CI without DinD), the whole suite is skipped
// — environment problems shouldn't fail CI. The unit-level health tests still
// run.

import { execSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONTAINER_NAME = 'ai-svc-registry-test';
// Host port for the throwaway container. Overridable because 55432 is also the
// port the repo's root docker-compose publishes for the shared pgvector service
// — when that is up, `docker run -p 55432` fails with "port is already
// allocated" and this whole suite errors out for an environment reason. Set
// AI_SVC_TEST_PG_PORT to run it alongside a live local stack.
const PG_PORT = Number(process.env.AI_SVC_TEST_PG_PORT ?? 55432);
const DB_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/ai_service_test`;

const APP_TOKEN = 'reg-test-app';
const ADMIN_TOKEN = 'reg-test-admin';

function hasDocker(): boolean {
  // `which docker` succeeds even when the daemon is dead; require `docker info`
  // to be reachable too.
  const which = spawnSync('which', ['docker'], { stdio: 'ignore' });
  if (which.status !== 0) return false;
  const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return info.status === 0;
}

const DOCKER_AVAILABLE = hasDocker();

/**
 * Wait until the container's Postgres accepts connections, AND the externally
 * port-forwarded host:port can complete a `select 1` round-trip. Two stages
 * because `pg_isready` (inside the container) can succeed seconds before the
 * port-forwarded socket is fully usable — connecting too fast yields ECONNRESET.
 */
async function waitForPg(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Stage 1: container-local readiness.
  while (Date.now() < deadline) {
    const res = spawnSync('docker', [
      'exec',
      CONTAINER_NAME,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'ai_service_test',
    ]);
    if (res.status === 0) break;
    await delay(250);
  }

  // Stage 2: externally usable. Retry until a real query succeeds.
  while (Date.now() < deadline) {
    try {
      const probe = postgres(DB_URL, { max: 1, connect_timeout: 2 });
      await probe`select 1`;
      await probe.end({ timeout: 2 });
      return true;
    } catch {
      await delay(500);
    }
  }
  return false;
}

describe.skipIf(!DOCKER_AVAILABLE)('registry routes (integration)', () => {
  let app: FastifyInstance;
  let queryClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
    // Kill any stray container from a previous interrupted run.
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });

    execSync(
      [
        'docker run -d --rm',
        `--name ${CONTAINER_NAME}`,
        `-p ${PG_PORT}:5432`,
        '-e POSTGRES_USER=postgres',
        '-e POSTGRES_PASSWORD=postgres',
        '-e POSTGRES_DB=ai_service_test',
        'pgvector/pgvector:pg16',
      ].join(' '),
      { stdio: 'ignore' },
    );

    if (!(await waitForPg())) {
      throw new Error('Postgres did not become ready in time');
    }

    // Override the env *before* importing the app modules — env validation
    // and the postgres pool both read `process.env.DATABASE_URL` at import.
    process.env.DATABASE_URL = DB_URL;
    process.env.API_KEYS = JSON.stringify({
      [APP_TOKEN]: { org: 'demo', project: 'demo', role: 'app' },
      [ADMIN_TOKEN]: { org: 'demo', project: 'demo', role: 'admin' },
    });

    // Run migrations against the fresh DB on a one-shot client (the app's
    // shared pool comes up below).
    const migrateClient = postgres(DB_URL, { max: 1 });
    await migrate(drizzle(migrateClient), { migrationsFolder: './drizzle' });
    await migrateClient.end();

    const { buildServer } = await import('../server.js');
    app = await buildServer();
    queryClient = postgres(DB_URL, { max: 2 });
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore */
    }
    try {
      await queryClient?.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
  }, 30_000);

  // -------------------------------------------------------------------------
  // Role gating
  // -------------------------------------------------------------------------

  describe('role gating', () => {
    it('rejects PUT /config from an app key with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/registry/config',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { defaultModel: 'gpt-4o-mini' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects POST versions from an app key with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/registry/unit-types/test-rolegate/versions',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { version: '1', promptTemplate: 'hi' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects POST activate from an app key with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/registry/unit-types/test-rolegate/versions/1/activate',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows GET /config from an app key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/registry/config',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Config upsert
  // -------------------------------------------------------------------------

  describe('config upsert', () => {
    it('PUT then GET round-trips; updated_by is set; an audit row appears', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/v1/registry/config',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: {
          defaultModel: 'gpt-4o-mini',
          defaultEffort: 'standard',
          metadata: { source: 'test' },
        },
      });
      expect(put.statusCode).toBe(200);
      const putBody = put.json();
      expect(putBody.config.defaultModel).toBe('gpt-4o-mini');
      expect(putBody.config.defaultEffort).toBe('standard');
      expect(putBody.config.updatedBy).toBeTruthy();
      expect(typeof putBody.config.updatedBy).toBe('string');
      // SHA-256 truncated to 16 hex chars.
      expect(putBody.config.updatedBy).toMatch(/^[0-9a-f]{16}$/);

      const get = await app.inject({
        method: 'GET',
        url: '/v1/registry/config',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json().config.defaultModel).toBe('gpt-4o-mini');

      // Audit row exists for this config update.
      const audits = await queryClient<
        Array<{ action: string; target_table: string; actor_key_id: string }>
      >`select action, target_table, actor_key_id from registry_audit where org = 'demo' and project = 'demo' and action = 'config.update'`;
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const last = audits[audits.length - 1]!;
      expect(last.action).toBe('config.update');
      expect(last.target_table).toBe('project_configs');
      expect(last.actor_key_id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Version creation
  // -------------------------------------------------------------------------

  describe('version create without activate', () => {
    it('first version with activate:false leaves no row active for that unitType', async () => {
      const unitType = 'noactivate';
      const created = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: '1', promptTemplate: 'hello {{name}}' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().entry.isActive).toBe(false);

      const list = await app.inject({
        method: 'GET',
        url: '/v1/registry/unit-types',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(list.statusCode).toBe(200);
      const summary = (list.json().unitTypes as Array<{
        unitType: string;
        activeVersion: string | null;
        versionCount: number;
      }>).find((u) => u.unitType === unitType);
      expect(summary).toBeDefined();
      expect(summary!.activeVersion).toBeNull();
      expect(summary!.versionCount).toBe(1);
    });
  });

  describe('version create with activate', () => {
    it('activates the new version, deactivates previously-active ones, writes one audit row', async () => {
      const unitType = 'activate-me';

      // v1 active
      const v1 = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'v1', promptTemplate: 'first', activate: true },
      });
      expect(v1.statusCode).toBe(201);
      expect(v1.json().entry.isActive).toBe(true);

      // v2 active — should flip v1 to inactive
      const v2 = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'v2', promptTemplate: 'second', activate: true },
      });
      expect(v2.statusCode).toBe(201);
      expect(v2.json().entry.isActive).toBe(true);

      const versionsRes = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const versions = versionsRes.json().versions as Array<{
        version: string;
        isActive: boolean;
      }>;
      expect(versions.find((v) => v.version === 'v1')!.isActive).toBe(false);
      expect(versions.find((v) => v.version === 'v2')!.isActive).toBe(true);

      // Exactly one audit row per `create` call, scoped to this unitType.
      const audits = await queryClient<
        Array<{ action: string; after: unknown }>
      >`select action, after from registry_audit where org = 'demo' and project = 'demo' and action = 'unit_type.version.create' and after->>'unitType' = ${unitType} order by created_at`;
      expect(audits).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Activate endpoint
  // -------------------------------------------------------------------------

  describe('activate endpoint', () => {
    it('flips activation atomically; previous active goes to false; audit written', async () => {
      const unitType = 'explicit-activate';

      // Two inactive versions.
      await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'a', promptTemplate: 'A' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'b', promptTemplate: 'B' },
      });

      // Activate `a`.
      const actA = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions/a/activate`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(actA.statusCode).toBe(200);
      expect(actA.json().entry.version).toBe('a');
      expect(actA.json().entry.isActive).toBe(true);

      // Now flip to `b`.
      const actB = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions/b/activate`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(actB.statusCode).toBe(200);
      expect(actB.json().entry.version).toBe('b');
      expect(actB.json().entry.isActive).toBe(true);

      // Confirm exactly one is active.
      const versionsRes = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const versions = versionsRes.json().versions as Array<{
        version: string;
        isActive: boolean;
      }>;
      expect(versions.filter((v) => v.isActive)).toHaveLength(1);
      expect(versions.find((v) => v.version === 'b')!.isActive).toBe(true);
      expect(versions.find((v) => v.version === 'a')!.isActive).toBe(false);

      // Audit rows for both activations.
      const audits = await queryClient<
        Array<{ action: string }>
      >`select action from registry_audit where org = 'demo' and project = 'demo' and action = 'unit_type.version.activate' and after->>'unitType' = ${unitType}`;
      expect(audits.length).toBe(2);
    });

    it('returns 404 for an unknown version', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/registry/unit-types/explicit-activate/versions/does-not-exist/activate',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // List endpoints
  // -------------------------------------------------------------------------

  describe('list endpoints', () => {
    it('versions list is newest-first; shape matches', async () => {
      const unitType = 'order-check';
      await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'oldest', promptTemplate: 'x' },
      });
      // Force a measurable created_at delta — tests can run within the same ms.
      await new Promise((r) => setTimeout(r, 10));
      await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'middle', promptTemplate: 'y' },
      });
      await new Promise((r) => setTimeout(r, 10));
      await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: 'newest', promptTemplate: 'z' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const versions = res.json().versions as Array<{ version: string }>;
      expect(versions.map((v) => v.version)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('unit-types summary shape', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/registry/unit-types',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        unitTypes: Array<{
          unitType: string;
          activeVersion: string | null;
          versionCount: number;
        }>;
      };
      expect(Array.isArray(body.unitTypes)).toBe(true);
      for (const u of body.unitTypes) {
        expect(typeof u.unitType).toBe('string');
        expect(typeof u.versionCount).toBe('number');
        expect(u.activeVersion === null || typeof u.activeVersion === 'string').toBe(true);
      }
    });

    it('duplicate version is rejected with 400', async () => {
      const unitType = 'dup-check';
      const a = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: '1', promptTemplate: 'first' },
      });
      expect(a.statusCode).toBe(201);
      const b = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { version: '1', promptTemplate: 'again' },
      });
      expect(b.statusCode).toBe(400);
    });
  });

  // Keep a tiny smoke test that exercises the `sql` import — guards against
  // accidental tree-shaking once we lint with `noUnusedImports`.
  it('schema-side sql import is alive', () => {
    expect(sql).toBeDefined();
  });
});
