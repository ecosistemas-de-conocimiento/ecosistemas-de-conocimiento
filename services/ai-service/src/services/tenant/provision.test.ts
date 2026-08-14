// Unit tests for tenant readiness + provisioning.
//
// `db/registry.js` (createVersion / listUnitTypes) and `budget/provision.js`
// (setOrgBudget) are mocked at the module boundary — they have their own
// coverage — so these tests pin the logic this module actually owns: the
// plain-language diagnosis, the per-item statuses, idempotency, and the
// never-omitted manual API-key step.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { budgetState, registryEntries } from '../../db/schema/index.js';
import type { Db } from '../../db/client.js';

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
        const chain: Record<string, unknown> = {
          where: () => chain,
          limit: () => Promise.resolve(result),
          then: (resolve: (v: unknown[]) => void) => resolve(result),
        };
        return chain;
      },
    }),
  } as unknown as Db;
}

beforeEach(() => {
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
