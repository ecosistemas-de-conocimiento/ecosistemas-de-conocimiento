// Unit tests for tenant readiness + provisioning.
//
// `db/registry.js` (createVersion / listUnitTypes) and `budget/provision.js`
// (setOrgBudget) are mocked at the module boundary — they have their own
// coverage — so these tests pin the logic this module actually owns: the
// plain-language diagnosis, the per-item statuses, idempotency, and the
// never-omitted manual API-key step.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// It used to read `where: () => chain` — a function with NO parameter — so the
// tenant predicates `getTenantReadiness` builds were discarded before the stub
// could look at them, and every case below agreed with any WHERE clause at all,
// INCLUDING NONE. This module is the one a new consumer is pointed at when
// nothing works: it answers "is THIS tenant provisioned". Drop
// `eq(budgetState.org, org)` and it answers about whichever org Postgres
// happened to return first — reporting a tenant ready on someone else's budget,
// or leaking another org's remaining spend in the `detail` payload.
//
// Predicates now go through `WhereRecorder` (drizzle's own dialect, bound
// params kept), and the dedicated cases at the bottom assert on them.
//
// 🔴 …AND WHY BOTH TERMINALS SETTLE THROUGH `WhereRecorder.guard()`.
// Taking the argument closes the mutation that EMPTIES the predicate and does
// nothing about the one that DELETES the `.where()` call. This stub is the
// worst-case shape for that: `where` returns the chain, the chain is THENABLE,
// so both `.from(t).limit(1)` and a bare `await db.select().from(t)` resolve to
// the canned rows with the recorder untouched. Measured on this file at HEAD,
// with `.where(eq(budgetState.org, org))` deleted from `provision.ts`: 8 of 13
// cases stayed GREEN over a whole-table read of every org's remaining spend,
// and the 5 reds named the wrong culprit — "no where() was recorded for
// 'budget_state' at all — the stub was never reached". The stub was reached on
// every call; the PREDICATE was gone, which is the opposite diagnosis and sends
// a reader hunting a broken fixture.
//
// `guard.settle()` on `limit` AND on `then` records a never-filtered chain as
// `<NO PREDICATE>`, so that mutation now fails by its real name and
// `expectNoUnfilteredQuery()` below is a gate rather than a restatement.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { budgetState, registryEntries } from '../../db/schema/index.js';
import type { Db } from '../../db/client.js';
import { WhereRecorder } from '../../test/where-recorder.js';

const listUnitTypesMock = vi.fn();
const createVersionMock = vi.fn();
const setOrgBudgetMock = vi.fn();

vi.mock('../../db/registry.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/registry.js')>(
    '../../db/registry.js',
  );
  return {
    ...actual,
    listUnitTypes: (...args: unknown[]) => listUnitTypesMock(...args),
    createVersion: (...args: unknown[]) => createVersionMock(...args),
  };
});

vi.mock('../budget/provision.js', () => ({
  setOrgBudget: (...args: unknown[]) => setOrgBudgetMock(...args),
}));

import { RegistryConflictError } from '../../db/registry.js';

import { getTenantReadiness, provisionTenant } from './provision.js';

const ORG = 'test-org';
const PROJECT = 'test-project';

interface DbRows {
  budget: Record<string, unknown>[];
  activeEntry: Record<string, unknown>[];
}

/** Every predicate the stubbed queries built. Cleared in `beforeEach`. */
const wheres = new WhereRecorder();

function makeDb(rows: DbRows): Db {
  return {
    select: () => ({
      from(table: unknown) {
        const result =
          table === budgetState
            ? rows.budget
            : table === registryEntries
              ? rows.activeEntry
              : [];
        // Name the table as Postgres knows it, so a failure message reads like
        // the schema rather than like a JS object identity.
        const name =
          table === budgetState
            ? 'budget_state'
            : table === registryEntries
              ? 'registry_entries'
              : 'unknown';
        // ONE guard per chain instance — per `from()`, i.e. per query.
        // `getTenantReadiness` issues two (budget_state, registry_entries) and
        // each gets its own, so "was this chain ever filtered?" is answered per
        // query rather than per readiness call.
        const guard = wheres.guard(name);
        const chain: Record<string, unknown> = {
          // 🔴 TAKES its argument — see the header.
          where: (predicate: unknown) => {
            guard.where(predicate);
            return chain;
          },
          // 🔴 BOTH terminals settle through the guard — see the header. `then`
          // is the load-bearing one: this chain is THENABLE, so before the
          // guard existed `await db.select().from(t)` with no `.where()` handed
          // back the canned rows and left the recorder completely empty.
          limit: () => guard.settle(Promise.resolve(result)),
          then: (resolve: (v: unknown[]) => void) => resolve(guard.settle(result)),
        };
        return chain;
      },
    }),
  } as unknown as Db;
}

beforeEach(() => {
  wheres.reset();
  listUnitTypesMock.mockReset();
  createVersionMock.mockReset();
  setOrgBudgetMock.mockReset();
  listUnitTypesMock.mockResolvedValue([]);
});

describe('getTenantReadiness', () => {
  it('reports a fully unprovisioned tenant with a fix for each missing piece', async () => {
    const db = makeDb({ budget: [], activeEntry: [] });
    const report = await getTenantReadiness(db, { org: ORG, project: PROJECT, role: 'app' });

    expect(report.ready).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    // Auth is proven by having reached the handler at all.
    expect(byId['api-key']!.ok).toBe(true);
    expect(byId['budget']!.ok).toBe(false);
    expect(byId['budget']!.summary).toContain('402');
    expect(byId['budget']!.fix).toBeTruthy();
    expect(byId['registry']!.ok).toBe(false);
    expect(byId['registry']!.summary).toContain('no active registry entry for unitType');
    expect(byId['registry']!.fix).toBeTruthy();
  });

  it('is ready when budget + at least one active registry entry exist', async () => {
    listUnitTypesMock.mockResolvedValue([
      { unitType: 'summary', activeVersion: '2', versionCount: 2 },
      { unitType: 'draft', activeVersion: null, versionCount: 1 },
    ]);
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '24.5', currency: 'USD' }],
      activeEntry: [],
    });
    const report = await getTenantReadiness(db, { org: ORG, project: PROJECT, role: 'admin' });

    expect(report.ready).toBe(true);
    const registry = report.checks.find((c) => c.id === 'registry')!;
    expect(registry.summary).toContain('summary');
    expect(registry.detail?.activeUnitTypes).toEqual(['summary']);
    expect(registry.fix).toBeUndefined();
  });

  it('flags an exhausted budget as not-ready (402 BudgetExceeded ahead)', async () => {
    listUnitTypesMock.mockResolvedValue([
      { unitType: 'summary', activeVersion: '1', versionCount: 1 },
    ]);
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '0', currency: 'USD' }],
      activeEntry: [],
    });
    const report = await getTenantReadiness(db, { org: ORG, project: PROJECT, role: 'app' });
    const budget = report.checks.find((c) => c.id === 'budget')!;
    expect(budget.ok).toBe(false);
    expect(budget.summary).toContain('BudgetExceeded');
    expect(report.ready).toBe(false);
  });

  it('checks ONE unit type precisely when `unitType` is supplied', async () => {
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '25', currency: 'USD' }],
      activeEntry: [{ version: '3' }],
    });
    const report = await getTenantReadiness(db, {
      org: ORG,
      project: PROJECT,
      role: 'app',
      unitType: 'extract-postits',
    });
    const registry = report.checks.find((c) => c.id === 'registry')!;
    expect(registry.ok).toBe(true);
    expect(registry.summary).toContain('extract-postits');
    expect(registry.detail?.activeVersion).toBe('3');
    // The per-unit-type path must not fall back to the "any prompt at all" query.
    expect(listUnitTypesMock).not.toHaveBeenCalled();
    // …and both reads it DID make were scoped to the caller. Pinned here as
    // well as in the dedicated cases below, because this is the only case in
    // the file that exercises both tenant-scoped queries in one call.
    // EVERY read of each table, not merely one of them: `provision.ts` reads
    // `budget_state` only as `eq(budgetState.org, org)` and `registry_entries`
    // only as `and(org, project, unitType, isActive)`, so there is no
    // legitimately unscoped read of either — which makes "at least one was
    // scoped" strictly weaker than the invariant this module claims to hold.
    wheres.expectEveryQueryScopedTo('budget_state', { org: ORG });
    wheres.expectEveryQueryScopedTo('registry_entries', { org: ORG, project: PROJECT });
  });

  it('names the exact 400 a missing unit type will produce', async () => {
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '25', currency: 'USD' }],
      activeEntry: [],
    });
    const report = await getTenantReadiness(db, {
      org: ORG,
      project: PROJECT,
      role: 'app',
      unitType: 'extract-postits',
    });
    const registry = report.checks.find((c) => c.id === 'registry')!;
    expect(registry.ok).toBe(false);
    expect(registry.summary).toContain(
      "no active registry entry for unitType 'extract-postits'",
    );
  });
});

describe('provisionTenant', () => {
  const ctx = { org: ORG, project: PROJECT, role: 'admin' as const, actorKeyId: 'key-1' };

  it('creates budget + registry entry and always returns the manual API-key step', async () => {
    setOrgBudgetMock.mockResolvedValue({
      org: ORG,
      limitUsd: 25,
      remainingUsd: 25,
      currency: 'USD',
      created: true,
    });
    createVersionMock.mockResolvedValue({ version: '1', isActive: true });
    listUnitTypesMock.mockResolvedValue([
      { unitType: 'summary', activeVersion: '1', versionCount: 1 },
    ]);
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '25', currency: 'USD' }],
      activeEntry: [],
    });

    const result = await provisionTenant(db, ctx, {
      budget: { limitUsd: 25 },
      unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'Do {{x}}' }],
    });

    expect(result.items.find((i) => i.item === 'budget')?.status).toBe('created');
    expect(result.items.find((i) => i.item === 'registry:summary')?.status).toBe('created');
    expect(result.manualSteps).toHaveLength(1);
    expect(result.manualSteps[0]!.item).toBe('api-key');
    expect(result.manualSteps[0]!.message).toContain('API_KEYS');
    expect(result.manualSteps[0]!.message).toContain('recreate');
    expect(result.readiness.ready).toBe(true);
    // Scope is taken from ctx (i.e. from auth), never invented.
    expect(setOrgBudgetMock).toHaveBeenCalledWith(db, { org: ORG, limitUsd: 25 });
    expect(createVersionMock.mock.calls[0]![1]).toBe(ORG);
    expect(createVersionMock.mock.calls[0]![2]).toBe(PROJECT);
    // `provisionTenant` measures readiness AFTER writing, and that read is a
    // real query too — `ready: true` above must be a statement about THIS
    // tenant's budget, not about whichever row came back first.
    wheres.expectEveryQueryScopedTo('budget_state', { org: ORG });
    // Provisioning activates by default.
    expect(createVersionMock.mock.calls[0]![6]).toEqual({ activate: true });
  });

  it('is idempotent: an already-registered version reports `unchanged`, not an error', async () => {
    setOrgBudgetMock.mockResolvedValue({
      org: ORG,
      limitUsd: 25,
      remainingUsd: 20,
      currency: 'USD',
      created: false,
    });
    createVersionMock.mockRejectedValue(
      new RegistryConflictError("version '1' already exists for unitType 'summary'"),
    );
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '20', currency: 'USD' }],
      activeEntry: [],
    });

    const result = await provisionTenant(db, ctx, {
      budget: { limitUsd: 25 },
      unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'Do {{x}}' }],
    });

    expect(result.items.find((i) => i.item === 'budget')?.status).toBe('updated');
    const entry = result.items.find((i) => i.item === 'registry:summary')!;
    expect(entry.status).toBe('unchanged');
    expect(entry.message).toContain('already exists');
  });

  it('reports a per-item failure without discarding the work that succeeded', async () => {
    setOrgBudgetMock.mockResolvedValue({
      org: ORG,
      limitUsd: 25,
      remainingUsd: 25,
      currency: 'USD',
      created: true,
    });
    createVersionMock.mockRejectedValue(new Error('prompt_template violates check'));
    const db = makeDb({ budget: [], activeEntry: [] });

    const result = await provisionTenant(db, ctx, {
      budget: { limitUsd: 25 },
      unitTypes: [{ unitType: 'summary', version: '1', promptTemplate: 'x' }],
    });

    expect(result.items.find((i) => i.item === 'budget')?.status).toBe('created');
    const entry = result.items.find((i) => i.item === 'registry:summary')!;
    expect(entry.status).toBe('failed');
    expect(entry.message).toContain('prompt_template violates check');
  });

  it('says so loudly when no budget was supplied', async () => {
    const db = makeDb({ budget: [], activeEntry: [] });
    const result = await provisionTenant(db, ctx, {});
    const budget = result.items.find((i) => i.item === 'budget')!;
    expect(budget.status).toBe('skipped');
    expect(budget.message).toContain('402');
    expect(setOrgBudgetMock).not.toHaveBeenCalled();
    expect(result.readiness.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant scope — the predicate, not the returned row
// ---------------------------------------------------------------------------
//
// Every case above asserts on rows the stub chose by table identity, which says
// nothing about the WHERE clause. `provision.ts`'s own header states the
// tenancy invariant it is meant to hold — "`org`/`project` are ALWAYS taken
// from the caller's auth scope, never from a request body" — and until these
// cases existed, nothing in the unit lane checked it.

describe('getTenantReadiness — tenant scope of the queries it issues', () => {
  it('🔴 the budget lookup is scoped to the caller org (org-only BY SCHEMA, not by omission)', async () => {
    // ⚠ ORG-ONLY IS CORRECT HERE — do not "fix" it to org+project.
    // `budget_state` has no `project` column at all: `src/db/schema/index.ts`
    // declares `org: text('org').notNull().unique()`, so a budget is a
    // per-ORG ceiling shared by every project in it. Adding a project term
    // would filter on a column that does not exist.
    //
    // Which is exactly why it needs asserting: "scoped to org" and "not
    // scoped at all" are indistinguishable to a stub that discards predicates,
    // and the org term is the ONLY filter this query has.
    const db = makeDb({ budget: [{ limitUsd: '25', remainingUsd: '25', currency: 'USD' }], activeEntry: [] });
    await getTenantReadiness(db, { org: ORG, project: PROJECT, role: 'app' });

    const lookups = wheres.for('budget_state');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    expect(lookup.sql).toContain('"budget_state"."org" =');
    expect(lookup.params).toEqual([ORG]);
    // A real gate now, and in this file it is the one that matters most: the
    // chain is thenable, so before `guard` an unfiltered read left NOTHING in
    // the list this line inspects. It now arrives as `<NO PREDICATE>`.
    wheres.expectNoUnfilteredQuery();
  });

  it('🔴 the per-unitType registry lookup is scoped to (org, project) — not to the unitType alone', async () => {
    const db = makeDb({ budget: [], activeEntry: [{ version: '3' }] });
    await getTenantReadiness(db, {
      org: ORG,
      project: PROJECT,
      role: 'app',
      unitType: 'extract-postits',
    });

    const lookups = wheres.for('registry_entries');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    // Column by column, so dropping any ONE of the three is its own named
    // failure rather than one opaque "the SQL changed".
    expect(lookup.sql).toContain('"registry_entries"."org" =');
    expect(lookup.sql).toContain('"registry_entries"."project" =');
    expect(lookup.sql).toContain('"registry_entries"."unit_type" =');
    // …and the values bound are the CALLER's scope plus the unitType asked
    // for, in that order.
    expect(lookup.params).toEqual([ORG, PROJECT, 'extract-postits']);
  });

  it('🔴 binds the CALLER scope, never the scope of the rows that come back', async () => {
    // The stub returns a budget row and an active registry row no matter who
    // asks — the shape of a cross-tenant read. This is the only case that would
    // notice if the filter were ever sourced from a row or a request body,
    // which is the exact failure `provision.ts`'s tenancy-invariant header
    // warns against.
    const db = makeDb({
      budget: [{ limitUsd: '25', remainingUsd: '25', currency: 'USD' }],
      activeEntry: [{ version: '3' }],
    });
    await getTenantReadiness(db, {
      org: 'other-org',
      project: 'other-project',
      role: 'admin',
      unitType: 'extract-postits',
    });

    wheres.expectEveryQueryScopedTo('budget_state', { org: 'other-org' });
    wheres.expectEveryQueryScopedTo('registry_entries', {
      org: 'other-org',
      project: 'other-project',
    });
  });

  it('🔴 still filters when the tenant is empty (the fully-unprovisioned path)', async () => {
    // The miss path matters as much as the hit path: a bare SELECT that returns
    // nothing on an empty table is still a whole-table read once rows exist.
    const db = makeDb({ budget: [], activeEntry: [] });
    const report = await getTenantReadiness(db, {
      org: ORG,
      project: PROJECT,
      role: 'app',
      unitType: 'extract-postits',
    });
    expect(report.ready).toBe(false);

    expect(wheres.calls.map((c) => c.table)).toEqual(['budget_state', 'registry_entries']);
    wheres.expectEveryQueryScopedTo('budget_state', { org: ORG });
    wheres.expectEveryQueryScopedTo('registry_entries', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();
  });
});
