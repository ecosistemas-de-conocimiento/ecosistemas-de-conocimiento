// Integration tests for the /v1/registry routes.
//
// ⚠ THAT FIRST LINE USED TO END IN A SLASH-STAR, AND IT MATTERED.
// `src/test/integration-database.test.ts` strips comments with a regex before
// scanning this file for `startThrowawayPg`, and that stripper cannot tell a
// slash-star inside a LINE comment from the start of a BLOCK comment. It opened
// one at line 1 and blanked everything down to the next star-slash — lines 1-40
// as the file then stood, this file's import of `startThrowawayPg` among them.
// The guard stayed green only because a SECOND occurrence sat below that point.
// Deleting a JSDoc block from this file moved the closing star-slash down, both
// occurrences went dark at once, and the guard failed naming a file that had
// not changed. Keep slash-star out of the line comments here — including out of
// this paragraph, which is why it spells the characters instead of showing them.
//
// These tests need a real Postgres because they exercise transactions, the
// partial-unique index on `registry_entries.is_active`, and the audit-row
// writer. `beforeAll` obtains one and `afterAll` gives it back.
//
// On the Docker path the host port is allocated by Docker, not chosen here —
// see `src/test/docker-pg.ts` for why a hardcoded number cannot work.
//
// 🔴 A MISSING PREREQUISITE IS A SKIP LOCALLY AND A HARD FAILURE IN CI.
// This suite used to gate on `!dockerAvailable()` alone, so on a runner without
// a daemon its 13 tests reported ZERO and the job stayed green — with the
// partial-unique index on `registry_entries.is_active` and the audit-row writer
// unexecuted. `skipWithoutTestPostgres` throws instead when `CI` is set; see
// `src/test/docker-gate.ts` for the whole argument.
//
// Two ways to get a real server, checked in that order:
//   · $AI_SVC_TEST_PG_URL — an already-running cluster (the CI service
//     container). A FRESH database is created on it for this file alone.
//   · a Docker daemon — the suite starts its own throwaway pgvector container.

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { externalTestClusterUrl, skipWithoutTestPostgres } from '../test/docker-gate.js';
import type { TestPostgres } from '../test/docker-pg.js';
import { createDatabaseOnCluster, startThrowawayPg } from '../test/docker-pg.js';

const CONTAINER_NAME = 'ai-svc-registry-test';
// ⚠ Must differ from every other file's: the unit suite runs files in PARALLEL,
// and on the external-cluster path the name is all that keeps two files apart.
//
// 🔴 AND IT MUST DIFFER PER PROCESS TOO. `createDatabaseOnCluster` opens with
// `DROP DATABASE ... WITH (FORCE)` and `stop()` drops again in `afterAll`, so
// two RUNS sharing one $AI_SVC_TEST_PG_URL delete each other's database
// mid-test — the var exported in a shell profile, or two worktrees on one
// workstation. Measured against a fixed name, two runs started 0.8s
// apart: the first stayed green, the second went 9 failed / 4 passed with
// `database "ai_service_registry_test" does not exist`. CI never saw it —
// each runner owns its own service container.
//
// ⚠ THE PID GOES BEFORE `_test`, NOT AFTER. `THROWAWAY_DATABASE_NAME` is
// /^ai_service(?:_[a-z0-9_]+)?_test$/, so a trailing `_<pid>` fails the
// allowlist and `createDatabaseOnCluster` refuses to run at all.
const DATABASE_NAME = `ai_service_registry_${process.pid}_test`;

// 🔴 EVALUATED AT MODULE SCOPE ON PURPOSE. With `CI` set and no Postgres to be
// had, this THROWS, vitest fails to collect the file, and the run exits
// non-zero naming it. A `beforeAll` throw would look like a flaky fixture; a
// skip would look like success.
const SKIP_SUITE = skipWithoutTestPostgres('registry routes (integration)');

const APP_TOKEN = 'reg-test-app';
const ADMIN_TOKEN = 'reg-test-admin';

// ── A SECOND AND A THIRD TENANT ────────────────────────────────────────────
// 🔴 THIS FILE HAD NO CROSS-TENANT TEST AT ALL. Every one of the thirteen
// cases above ran as a single tenant, so `registry_entries`
// and `project_configs` — both `(org, project)`-scoped, both admin-WRITABLE —
// had their tenancy predicate exercised by nothing. `rg -i
// 'cross-tenant|cross-org|isolation'` over this file returned zero hits.
//
// That is not a weak assertion; it is an absent one, and the registry is the
// worst place for it: `activateVersion` issues a bulk
// `UPDATE registry_entries SET is_active = false WHERE org/project/unit_type`
// as its first statement. Drop the tenancy terms from THAT and one tenant's
// activate silently DEACTIVATES every other tenant's prompt for the same
// unitType — no error, no 404, just a service that starts resolving the wrong
// prompt version for somebody else.
//
// Tenant A stays the tokens above. B is reached two ways so each
// half of the `(org, project)` tuple is gated independently.
const OTHER_ORG_ADMIN = 'reg-other-org-admin';
const OTHER_ORG_APP = 'reg-other-org-app';
const OTHER_PROJECT_ADMIN = 'reg-other-project-admin';
const OTHER_PROJECT_APP = 'reg-other-project-app';

const A = { org: 'tenant-b', project: 'tenant-b', admin: ADMIN_TOKEN, app: APP_TOKEN } as const;
const B_ORG = {
  org: 'otherorg',
  project: 'tenant-b',
  admin: OTHER_ORG_ADMIN,
  app: OTHER_ORG_APP,
} as const;
const B_PROJECT = {
  org: 'tenant-b',
  project: 'otherproject',
  admin: OTHER_PROJECT_ADMIN,
  app: OTHER_PROJECT_APP,
} as const;

type Tenant = typeof A | typeof B_ORG | typeof B_PROJECT;

// Skipped ONLY on a developer machine with neither $AI_SVC_TEST_PG_URL nor a
// Docker daemon. In CI the same condition THROWS at module scope (vitest then
// fails to collect this file, non-zero exit) rather than silently reporting an
// empty suite.
// skip-reason: needs a real Postgres (CI service container or Docker); in CI a missing one FAILS, it never skips
describe.skipIf(SKIP_SUITE)('registry routes (integration)', () => {
  let app: FastifyInstance;
  let queryClient: ReturnType<typeof postgres>;
  let pg: TestPostgres | undefined;

  beforeAll(async () => {
    const cluster = externalTestClusterUrl();
    pg = cluster
      ? await createDatabaseOnCluster(cluster, DATABASE_NAME)
      : await startThrowawayPg({
          containerName: CONTAINER_NAME,
          portEnvVar: 'AI_SVC_TEST_PG_PORT',
        });

    // Override the env *before* importing the app modules — env validation
    // and the postgres pool both read `process.env.DATABASE_URL` at import.
    process.env.DATABASE_URL = pg.url;
    process.env.API_KEYS = JSON.stringify({
      [APP_TOKEN]: { org: 'tenant-b', project: 'tenant-b', role: 'app' },
      [ADMIN_TOKEN]: { org: 'tenant-b', project: 'tenant-b', role: 'admin' },
      // The second tenant, reached by a DIFFERENT org…
      [OTHER_ORG_APP]: { org: B_ORG.org, project: B_ORG.project, role: 'app' },
      [OTHER_ORG_ADMIN]: { org: B_ORG.org, project: B_ORG.project, role: 'admin' },
      // …and by a different PROJECT in the SAME org, which is the half a
      // single-org fixture can never gate.
      [OTHER_PROJECT_APP]: { org: B_PROJECT.org, project: B_PROJECT.project, role: 'app' },
      [OTHER_PROJECT_ADMIN]: {
        org: B_PROJECT.org,
        project: B_PROJECT.project,
        role: 'admin',
      },
    });

    // Run migrations against the fresh DB on a one-shot client (the app's
    // shared pool comes up below).
    const migrateClient = postgres(pg.url, { max: 1 });
    await migrate(drizzle(migrateClient), { migrationsFolder: './drizzle' });
    await migrateClient.end();

    const { buildServer } = await import('../server.js');
    app = await buildServer();
    queryClient = postgres(pg.url, { max: 2 });
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
    await pg?.stop();
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
      >`select action, target_table, actor_key_id from registry_audit where org = 'tenant-b' and project = 'tenant-b' and action = 'config.update'`;
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
      >`select action, after from registry_audit where org = 'tenant-b' and project = 'tenant-b' and action = 'unit_type.version.create' and after->>'unitType' = ${unitType} order by created_at`;
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
      >`select action from registry_audit where org = 'tenant-b' and project = 'tenant-b' and action = 'unit_type.version.activate' and after->>'unitType' = ${unitType}`;
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

  // -------------------------------------------------------------------------
  // 🔴 CROSS-TENANT ISOLATION — the coverage this file did not have
  // -------------------------------------------------------------------------
  //
  // Every case runs against the REAL Postgres this suite already provisions, so
  // what is exercised is the actual `(org, project)` predicate in
  // `src/db/registry.ts` rather than a stub that would agree with any WHERE
  // clause. Where the operation WRITES, the other tenant's rows are read back
  // with `queryClient` — a 404 assertion alone cannot tell a refused write from
  // one that happened and then reported nothing.
  //
  // Deliberately NOT truncating between cases: this file has no per-test wipe
  // (it is a unit-lane file with its own database), so every fixture below uses
  // a unitType unique to its own test.
  describe('cross-tenant isolation', () => {
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    /** Create one version for `t`, optionally active. */
    async function createVersion(
      t: Tenant,
      unitType: string,
      version: string,
      promptTemplate: string,
      activate = false,
    ) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: auth(t.admin),
        payload: { version, promptTemplate, activate },
      });
      expect(res.statusCode).toBe(201);
      return res.json().entry as { id: string; isActive: boolean };
    }

    /** Read `(unitType, version)` rows straight from the table for one tenant. */
    async function rowsFor(t: Tenant, unitType: string) {
      return queryClient<
        Array<{ version: string; is_active: boolean; prompt_template: string }>
      >`select version, is_active, prompt_template
          from registry_entries
         where org = ${t.org} and project = ${t.project} and unit_type = ${unitType}
         order by version`;
    }

    // ── registry_entries: READ ──────────────────────────────────────────────

    it('GET versions: a unitType that exists ONLY in another org is an empty list, not the other org’s rows', async () => {
      const unitType = 'iso-read-org';
      await createVersion(B_ORG, unitType, '1', 'B-ONLY prompt', true);

      // Positive control first — the row IS reachable, by its owner.
      const owner = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: auth(B_ORG.app),
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().versions).toHaveLength(1);

      const foreign = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: auth(A.app),
      });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().versions).toEqual([]);
      // The prompt body is the payload that must not travel. Assert on the
      // whole response, not just the array we happened to read.
      expect(foreign.body).not.toContain('B-ONLY');
    });

    it('GET versions: the same check across a different PROJECT in the SAME org', async () => {
      const unitType = 'iso-read-project';
      await createVersion(B_PROJECT, unitType, '1', 'B-ONLY project prompt', true);

      const owner = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: auth(B_PROJECT.app),
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().versions).toHaveLength(1);

      const foreign = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions`,
        headers: auth(A.app),
      });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().versions).toEqual([]);
      expect(foreign.body).not.toContain('B-ONLY');
    });

    it('GET a single version owned by another tenant is 404 and leaks no prompt', async () => {
      const unitType = 'iso-getone';
      await createVersion(B_ORG, unitType, 'v9', 'B-ONLY single prompt');

      const owner = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions/v9`,
        headers: auth(B_ORG.app),
      });
      expect(owner.statusCode).toBe(200);

      const foreign = await app.inject({
        method: 'GET',
        url: `/v1/registry/unit-types/${unitType}/versions/v9`,
        headers: auth(A.app),
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain('B-ONLY');
    });

    it('GET /unit-types summary never lists another tenant’s unitType', async () => {
      const unitType = 'iso-summary-b-only';
      await createVersion(B_ORG, unitType, '1', 'B-ONLY summary prompt', true);

      const owner = await app.inject({
        method: 'GET',
        url: '/v1/registry/unit-types',
        headers: auth(B_ORG.app),
      });
      expect(
        (owner.json().unitTypes as Array<{ unitType: string }>).map((u) => u.unitType),
      ).toContain(unitType);

      const foreign = await app.inject({
        method: 'GET',
        url: '/v1/registry/unit-types',
        headers: auth(A.app),
      });
      expect(
        (foreign.json().unitTypes as Array<{ unitType: string }>).map((u) => u.unitType),
      ).not.toContain(unitType);
    });

    // ── registry_entries: WRITE ─────────────────────────────────────────────

    it('the SAME (unitType, version) can exist in two tenants at once, with different prompts and independent active flags', async () => {
      // The unique index is `("org","project","unit_type","version")`. If the
      // tenancy columns were not in it — or not in the insert path — the second
      // create would 400 as a duplicate instead of standing on its own.
      const unitType = 'iso-samename';
      await createVersion(B_ORG, unitType, '1', 'B-ONLY prompt', true);
      await createVersion(A, unitType, '1', 'A prompt', true);

      const [bRow] = await rowsFor(B_ORG, unitType);
      const [aRow] = await rowsFor(A, unitType);
      expect(bRow!.prompt_template).toBe('B-ONLY prompt');
      expect(aRow!.prompt_template).toBe('A prompt');
      // 🔴 BOTH active. The partial-unique index is per `(org, project,
      // unit_type)`, so one tenant activating must not have cleared the other.
      expect(bRow!.is_active).toBe(true);
      expect(aRow!.is_active).toBe(true);
    });

    it('🔴 activate: A’s activate NEVER clears another tenant’s active flag for the same unitType', async () => {
      // `activateVersion` opens with a BULK update:
      //   UPDATE registry_entries SET is_active = false
      //    WHERE org = $1 AND project = $2 AND unit_type = $3 AND is_active
      // Drop the org/project terms and this test goes red on B's row, silently,
      // with A's request still returning 200. That is the whole reason this case
      // reads B's row back instead of trusting A's response.
      const unitType = 'iso-activate';
      await createVersion(B_ORG, unitType, 'b1', 'B-ONLY v1', true);
      await createVersion(B_PROJECT, unitType, 'p1', 'B-PROJECT v1', true);
      await createVersion(A, unitType, 'a1', 'A v1');
      await createVersion(A, unitType, 'a2', 'A v2');

      const act = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions/a1/activate`,
        headers: auth(A.admin),
      });
      expect(act.statusCode).toBe(200);

      // A's own state changed as asked…
      expect(await rowsFor(A, unitType)).toEqual([
        { version: 'a1', is_active: true, prompt_template: 'A v1' },
        { version: 'a2', is_active: false, prompt_template: 'A v2' },
      ]);
      // …and NEITHER neighbour was touched.
      expect(await rowsFor(B_ORG, unitType)).toEqual([
        { version: 'b1', is_active: true, prompt_template: 'B-ONLY v1' },
      ]);
      expect(await rowsFor(B_PROJECT, unitType)).toEqual([
        { version: 'p1', is_active: true, prompt_template: 'B-PROJECT v1' },
      ]);
    });

    it('activate: a version that exists only in ANOTHER tenant is 404, and stays active for its owner', async () => {
      const unitType = 'iso-activate-foreign';
      await createVersion(B_ORG, unitType, 'only-b', 'B-ONLY foreign', true);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/registry/unit-types/${unitType}/versions/only-b/activate`,
        headers: auth(A.admin),
      });
      expect(res.statusCode).toBe(404);

      // Read it back: a 404 emitted AFTER the bulk deactivate ran would leave
      // B's row inactive while still reporting "not found".
      expect(await rowsFor(B_ORG, unitType)).toEqual([
        { version: 'only-b', is_active: true, prompt_template: 'B-ONLY foreign' },
      ]);
    });

    // ── project_configs ─────────────────────────────────────────────────────

    it('🔴 config: A’s PUT does not overwrite another tenant’s config, and A cannot read it', async () => {
      // `upsertProjectConfig` selects the existing row on `(org, project)` and
      // then updates it. Without those terms the upsert resolves to whichever
      // row it finds and REWRITES another tenant's default model — a silent
      // cross-tenant change to which model their generations run on.
      const seedB = await app.inject({
        method: 'PUT',
        url: '/v1/registry/config',
        headers: auth(B_ORG.admin),
        payload: { defaultModel: 'b-only/model', defaultEffort: 'maximum' },
      });
      expect(seedB.statusCode).toBe(200);

      const putA = await app.inject({
        method: 'PUT',
        url: '/v1/registry/config',
        headers: auth(A.admin),
        payload: { defaultModel: 'a/model', defaultEffort: 'quick' },
      });
      expect(putA.statusCode).toBe(200);

      // B's row, read straight from the table.
      const bConfig = await queryClient<
        Array<{ default_model: string; default_effort: string }>
      >`select default_model, default_effort from project_configs
         where org = ${B_ORG.org} and project = ${B_ORG.project}`;
      expect(bConfig).toHaveLength(1);
      expect(bConfig[0]).toEqual({
        default_model: 'b-only/model',
        default_effort: 'maximum',
      });

      // And A's GET returns A's own row, not B's.
      const getA = await app.inject({
        method: 'GET',
        url: '/v1/registry/config',
        headers: auth(A.app),
      });
      expect(getA.statusCode).toBe(200);
      expect(getA.json().config.defaultModel).toBe('a/model');
      expect(getA.body).not.toContain('b-only/model');
    });

    it('config: a different PROJECT in the same org keeps its OWN row', async () => {
      const putP = await app.inject({
        method: 'PUT',
        url: '/v1/registry/config',
        headers: auth(B_PROJECT.admin),
        payload: { defaultModel: 'project-only/model' },
      });
      expect(putP.statusCode).toBe(200);

      const getA = await app.inject({
        method: 'GET',
        url: '/v1/registry/config',
        headers: auth(A.app),
      });
      expect(getA.statusCode).toBe(200);
      expect(getA.json().config.defaultModel).not.toBe('project-only/model');

      const rows = await queryClient<
        Array<{ org: string; project: string; default_model: string }>
      >`select org, project, default_model from project_configs
         where default_model = 'project-only/model'`;
      expect(rows).toEqual([
        { org: B_PROJECT.org, project: B_PROJECT.project, default_model: 'project-only/model' },
      ]);
    });

    // ── registry_audit ──────────────────────────────────────────────────────

    it('audit rows are stamped with the ACTING tenant, so one tenant’s history cannot be attributed to another', async () => {
      const unitType = 'iso-audit';
      await createVersion(B_ORG, unitType, '1', 'B-ONLY audited');

      const rows = await queryClient<
        Array<{ org: string; project: string }>
      >`select org, project from registry_audit
         where action = 'unit_type.version.create' and after->>'unitType' = ${unitType}`;
      expect(rows).toEqual([{ org: B_ORG.org, project: B_ORG.project }]);
    });
  });

  // Keep a tiny smoke test that exercises the `sql` import — guards against
  // accidental tree-shaking once we lint with `noUnusedImports`.
  it('schema-side sql import is alive', () => {
    expect(sql).toBeDefined();
  });
});
