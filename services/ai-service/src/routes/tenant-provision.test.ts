// Docker-backed tests for the provisioning surface:
//   PUT  /v1/budget/:org
//   POST /v1/tenant/provision
//   GET  /v1/tenant/readiness
//
// These need a REAL Postgres because the point of the surface is the SQL: the
// budget upsert's `LEAST(remaining, cap)` clamp, `createVersion`'s partial
// unique index on `is_active`, and the audit-row writer. A mocked db proves the
// wiring (see `tenant.test.ts` / `budget.test.ts`) but would happily accept a
// malformed SQL expression that only explodes in production.
//
// Same harness + skip semantics as `registry.test.ts`: throwaway
// `pgvector/pgvector:pg16` container, skipped entirely when docker is absent.

import { execSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const CONTAINER_NAME = 'ai-svc-tenant-test';
// Distinct from registry.test.ts's container/port — vitest runs test FILES in
// parallel, so a shared port would flake. Overridable for the same
// local-ecosystem-collision reason.
const PG_PORT = Number(process.env.AI_SVC_TEST_TENANT_PG_PORT ?? 55433);
const DB_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/ai_service_test`;

const APP_TOKEN = 'tenant-test-app';
const ADMIN_TOKEN = 'tenant-test-admin';
const ORG = 'tenant-test-org';
const PROJECT = 'tenant-test-project';

function hasDocker(): boolean {
  const which = spawnSync('which', ['docker'], { stdio: 'ignore' });
  if (which.status !== 0) return false;
  const info = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return info.status === 0;
}

const DOCKER_AVAILABLE = hasDocker();

async function waitForPg(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
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

describe.skipIf(!DOCKER_AVAILABLE)('tenant provisioning (integration)', () => {
  let app: FastifyInstance;
  let queryClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
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
    if (!(await waitForPg())) throw new Error('Postgres did not become ready in time');

    process.env.DATABASE_URL = DB_URL;
    process.env.API_KEYS = JSON.stringify({
      [APP_TOKEN]: { org: ORG, project: PROJECT, role: 'app' },
      [ADMIN_TOKEN]: { org: ORG, project: PROJECT, role: 'admin' },
    });

    const migrateClient = postgres(DB_URL, { max: 1 });
    await migrate(drizzle(migrateClient), { migrationsFolder: './drizzle' });
    await migrateClient.end();

    const { buildServer } = await import('../server.js');
    app = await buildServer();
    queryClient = postgres(DB_URL, { max: 2 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await queryClient?.end({ timeout: 5 });
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM budget_state`;
    await queryClient`DELETE FROM registry_entries`;
  });

  const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const appHeaders = { authorization: `Bearer ${APP_TOKEN}` };

  it('readiness on a brand-new tenant names all three missing pieces in plain words', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness',
      headers: appHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.org).toBe(ORG);
    const ids = body.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['api-key', 'budget', 'registry']);
    // The key worked (you got a 200), the other two are the real diagnosis.
    expect(body.checks[0].ok).toBe(true);
    expect(body.checks[1].ok).toBe(false);
    expect(body.checks[2].ok).toBe(false);
  });

  it('PUT /v1/budget creates then clamps against real SQL', async () => {
    const created = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: adminHeaders,
      payload: { limitUsd: 25 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ limitUsd: 25, remainingUsd: 25, created: true });

    // Simulate spend, then lower the cap: `remaining` must be clamped by the
    // LEAST(...) expression, not raised back to the cap.
    await queryClient`UPDATE budget_state SET remaining_usd = 4 WHERE org = ${ORG}`;
    const lowered = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: adminHeaders,
      payload: { limitUsd: 10 },
    });
    expect(lowered.statusCode).toBe(200);
    expect(lowered.json()).toMatchObject({ limitUsd: 10, remainingUsd: 4, created: false });

    // …and `refill` tops it back up.
    const refilled = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: adminHeaders,
      payload: { limitUsd: 10, refill: true },
    });
    expect(refilled.json()).toMatchObject({ limitUsd: 10, remainingUsd: 10 });

    // Exactly one row — the upsert never duplicates.
    const rows = await queryClient`SELECT * FROM budget_state WHERE org = ${ORG}`;
    expect(rows).toHaveLength(1);
  });

  it('provision sets up budget + registry, is idempotent, and reports the manual key step', async () => {
    const payload = {
      budget: { limitUsd: 25 },
      unitTypes: [
        {
          unitType: 'summary',
          version: '1',
          promptTemplate: 'Summarise: {{text}}',
          metaPromptTemplate: 'You are a careful summariser.',
        },
      ],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: adminHeaders,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items.find((i: { item: string }) => i.item === 'budget').status).toBe(
      'created',
    );
    expect(
      firstBody.items.find((i: { item: string }) => i.item === 'registry:summary').status,
    ).toBe('created');
    expect(firstBody.manualSteps[0].item).toBe('api-key');
    expect(firstBody.readiness.ready).toBe(true);

    // The entry is really active + carries the meta prompt template.
    const entries = await queryClient`
      SELECT unit_type, version, is_active, meta_prompt_template
        FROM registry_entries WHERE org = ${ORG} AND project = ${PROJECT}`;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.is_active).toBe(true);
    expect(entries[0]!.meta_prompt_template).toBe('You are a careful summariser.');

    // Re-running is a no-op, not a 4xx and not a duplicate row.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: adminHeaders,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(
      second.json().items.find((i: { item: string }) => i.item === 'registry:summary').status,
    ).toBe('unchanged');
    const after = await queryClient`SELECT count(*)::int AS n FROM registry_entries`;
    expect(after[0]!.n).toBe(1);
  });

  it('readiness flips to ready after provisioning, and answers per-unitType', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: adminHeaders,
      payload: {
        budget: { limitUsd: 5 },
        unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'x {{y}}' }],
      },
    });

    const ready = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness',
      headers: appHeaders,
    });
    expect(ready.json().ready).toBe(true);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/tenant/readiness?unitType=not-registered',
      headers: appHeaders,
    });
    const registryCheck = missing
      .json()
      .checks.find((c: { id: string }) => c.id === 'registry');
    expect(registryCheck.ok).toBe(false);
    expect(registryCheck.summary).toContain("unitType 'not-registered'");
  });

  it('writes an audit row for the provisioned registry entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: adminHeaders,
      payload: {
        unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'x {{y}}' }],
      },
    });
    const audit = await queryClient`
      SELECT action, target_table, actor_key_id FROM registry_audit
       WHERE org = ${ORG} ORDER BY created_at DESC LIMIT 1`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_table).toBe('registry_entries');
    expect(audit[0]!.actor_key_id).toBeTruthy();
  });

  it('an app-role key cannot provision or set a budget', async () => {
    const provision = await app.inject({
      method: 'POST',
      url: '/v1/tenant/provision',
      headers: appHeaders,
      payload: { budget: { limitUsd: 999 } },
    });
    expect(provision.statusCode).toBe(403);
    const budget = await app.inject({
      method: 'PUT',
      url: `/v1/budget/${ORG}`,
      headers: appHeaders,
      payload: { limitUsd: 999 },
    });
    expect(budget.statusCode).toBe(403);
    const rows = await queryClient`SELECT count(*)::int AS n FROM budget_state`;
    expect(rows[0]!.n).toBe(0);
  });
});
