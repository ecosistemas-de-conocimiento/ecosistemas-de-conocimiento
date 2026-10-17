// Unit tests for resolveSpec. The drizzle `db` is replaced with a tiny stub
// that returns canned rows for `registry_entries` and `project_configs`
// queries — keyed by which table the chain's `.from(...)` was called against.
// This keeps the tests free of Postgres while still exercising the resolver's
// full precedence pipeline.
//
// 🔴 WHY THE STUB'S `where()` TAKES ITS ARGUMENT NOW.
// It used to read `where: () => chain` — a function with NO parameter. The
// `(org, project)` predicate `resolveSpec` builds was therefore DISCARDED at
// the door, so every case below agreed with any WHERE clause at all,
// INCLUDING NONE. Delete `eq(registryEntries.org, org)` from `resolve.ts` and
// this file stayed green while one tenant resolved another tenant's registered
// prompt. That prompt is what decides what the model is told and what shape it
// must answer in, so a leak there hands a consumer's product logic to whoever
// asked for the same unitType.
//
// Every `where()` now records its predicate through `WhereRecorder`, which
// serialises it with drizzle's OWN dialect — the same code path that talks to
// Postgres — and keeps the bound parameters. The dedicated cases at the bottom
// then assert the tenant COLUMNS and the tenant VALUES are really in there.
//
// 🔴 …AND WHY BOTH TERMINALS NOW SETTLE THROUGH `WhereRecorder.guard()`.
// Taking the argument catches the mutation that EMPTIES the predicate. It is
// blind to the one that DELETES the `.where()` call outright, because this
// stub's `where` returns the chain itself — strip the call and
// `.from(registryEntries).limit(1)` is still a legal chain that still resolves
// to the canned row. Measured on this file at HEAD, with the whole
// `.where(and(eq(org), eq(project), eq(unitType), isActive))` deleted from
// `resolve.ts`: 23 of 27 cases stayed GREEN over what is a whole-table read of
// every tenant's registered prompts, and the 4 reds blamed the wrong thing —
// "no where() was recorded for 'registry_entries' at all — the stub was never
// reached". The stub was reached on every call; the PREDICATE was gone.
//
// `guard.settle()` on `limit` and on `then` records a never-filtered chain as
// `<NO PREDICATE>`, which puts the deleted call into the same list as the
// emptied one and makes `expectNoUnfilteredQuery()` below a real gate instead
// of a statement about predicates the stub happened to see.
//
// ⚠ This is the cheap complement, not the proof. A mock can only show which
// predicate was BUILT, never that Postgres honoured it. The full-strength
// proof — seed a row owned by tenant B, act as A, read B's rows back — lives
// in `src/routes/tenant-isolation.integration.test.ts`.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { projectConfigs, registryEntries } from '../../db/schema/index.js';
import { WhereRecorder } from '../../test/where-recorder.js';

import {
  EFFORT_PROFILES,
  resolveSpec,
  SpecResolutionError,
  type EffortProfile,
  type InlineSpecOverride,
  type RequestOverrides,
} from './resolve.js';

// ---------------------------------------------------------------------------
// Stub db
// ---------------------------------------------------------------------------

interface StubRows {
  registry?: unknown;
  project?: unknown;
}

/**
 * Returns a `Db`-shaped object whose `select().from(table).where(...).limit(n)`
 * call resolves to the canned row(s) for that table. Only the surface the
 * resolver actually uses is implemented.
 */
/**
 * Every predicate every stubbed query built, in call order.
 *
 * Module-level rather than per-`makeDb` because several cases construct more
 * than one db; `beforeEach` clears it so a case only ever sees its own queries.
 */
const wheres = new WhereRecorder();

function makeDb(rows: StubRows): Db {
  // Each `select()` starts a fresh builder so successive resolveSpec calls in
  // the same test don't share state.
  const build = (table: unknown) => {
    let row: unknown = undefined;
    // Name the table as Postgres knows it, so a failure message reads like the
    // schema instead of like a JS object identity.
    let name = 'unknown';
    if (table === registryEntries) {
      row = rows.registry;
      name = 'registry_entries';
    }
    if (table === projectConfigs) {
      row = rows.project;
      name = 'project_configs';
    }
    const result: unknown[] = row ? [row] : [];
    // ONE guard per chain instance — per `from()`, i.e. per query. `resolveSpec`
    // issues two (registry_entries, project_configs) and each gets its own, so
    // "was this chain ever filtered?" is answered per query rather than per
    // resolve.
    const guard = wheres.guard(name);
    const chain: {
      where: (predicate: unknown) => typeof chain;
      limit: (n?: number) => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void) => void;
    } = {
      // 🔴 TAKES its argument. A parameterless `where()` here is precisely what
      // let a dropped tenant filter pass green — see the header.
      where: (predicate: unknown) => {
        guard.where(predicate);
        return chain;
      },
      // 🔴 …and both terminals SETTLE through the guard — see the header.
      // `limit` is the terminal `resolveSpec` uses; `then` covers the chain
      // being awaited directly, which is what a `.limit(1)` deletion produces.
      limit: async () => guard.settle(result),
      then: (resolve) => {
        Promise.resolve(guard.settle(result)).then(resolve);
      },
    };
    return chain;
  };
  const db = {
    select: () => ({ from: (t: unknown) => build(t) }),
  };
  return db as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';

function makeRegistryRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    org: ORG,
    project: PROJECT,
    unitType: 'thing',
    version: '1',
    isActive: true,
    promptTemplate: 'registered prompt {{x}}',
    metaPromptTemplate: null,
    model: 'registered/model',
    defaultEffort: 'standard',
    effortProfiles: null,
    responseSchema: null,
    validators: [],
    renderer: null,
    contentKind: null,
    createdBy: null,
    metadata: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeProjectRow(over: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    org: ORG,
    project: PROJECT,
    defaultModel: 'project/default-model',
    defaultEffort: 'quick',
    effortProfiles: null,
    contextRules: null,
    callbackUrl: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  wheres.reset();
});

describe('resolveSpec', () => {
  it('returns the active registry row when nothing overrides it', async () => {
    const db = makeDb({ registry: makeRegistryRow(), project: makeProjectRow() });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
    });
    expect(spec.promptTemplate).toBe('registered prompt {{x}}');
    expect(spec.model).toBe('registered/model');
    expect(spec.effortLevel).toBe('standard'); // registry default beats project default
    expect(spec.registryEntryId).toBe('11111111-1111-1111-1111-111111111111');
    // Base effort profile flows through from the built-in EFFORT_PROFILES map
    // because neither project nor registry supplied an override.
    expect(spec.effortProfile.maxOutputTokens).toBe(EFFORT_PROFILES.standard.maxOutputTokens);
    expect(spec.effortProfile.model).toBe('registered/model');
    // The same call had to build a tenant-scoped predicate to reach that row at
    // all. Pinned here as well as in the dedicated cases below, so the file's
    // happiest path cannot drift away from the scope it depends on.
    // EVERY query on each table, not merely one: `resolveSpec` reads each table
    // exactly once and neither read is ever legitimately unscoped, so a second
    // tenant-blind read appearing alongside a good one is a defect — and that
    // is the case `expectScopedTo` passes.
    wheres.expectEveryQueryScopedTo('registry_entries', { org: ORG, project: PROJECT });
    wheres.expectEveryQueryScopedTo('project_configs', { org: ORG, project: PROJECT });
  });

  it('inline specOverride beats the registered row', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const specOverride: InlineSpecOverride = {
      promptTemplate: 'inline prompt',
      model: 'inline/model',
      effortLevel: 'maximum',
      validators: [{ type: 'json-schema' }],
    };
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specOverride,
    });
    expect(spec.promptTemplate).toBe('inline prompt');
    expect(spec.model).toBe('inline/model');
    expect(spec.effortLevel).toBe('maximum');
    expect(spec.validators).toEqual([{ type: 'json-schema' }]);
    // Inline override means we did not resolve from a registry row.
    expect(spec.registryEntryId).toBeUndefined();
  });

  it('request-level modelOverride applies', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const requestOverrides: RequestOverrides = { modelOverride: 'request/override-model' };
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      requestOverrides,
    });
    expect(spec.model).toBe('request/override-model');
    // Prompt still comes from registry.
    expect(spec.promptTemplate).toBe('registered prompt {{x}}');
    // Registry id is still recorded because the entry contributed the prompt.
    expect(spec.registryEntryId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('request-level promptOverride and effortLevel apply', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const requestOverrides: RequestOverrides = {
      promptOverride: 'override prompt {{x}}',
      effortLevel: 'deep',
    };
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      requestOverrides,
    });
    expect(spec.promptTemplate).toBe('override prompt {{x}}');
    expect(spec.effortLevel).toBe('deep');
    expect(spec.effortProfile.maxOutputTokens).toBe(EFFORT_PROFILES.deep.maxOutputTokens);
  });

  it('layers effortOverrides[unitType] on top of resolved profile', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const requestOverrides: RequestOverrides = {
      effortOverrides: {
        thing: { maxOutputTokens: 4242, temperature: 0.9 } as Partial<EffortProfile>,
      },
    };
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      requestOverrides,
    });
    expect(spec.effortProfile.maxOutputTokens).toBe(4242);
    expect(spec.effortProfile.temperature).toBe(0.9);
  });

  it('throws SpecResolutionError when there is neither entry nor defaults', async () => {
    const db = makeDb({});
    await expect(
      resolveSpec(db, { org: ORG, project: PROJECT, unitType: 'unknown' }),
    ).rejects.toBeInstanceOf(SpecResolutionError);
    try {
      await resolveSpec(db, { org: ORG, project: PROJECT, unitType: 'unknown' });
    } catch (err) {
      expect((err as SpecResolutionError).cause).toBe('no spec for unitType');
    }
  });

  it('throws SpecResolutionError when no model is resolvable anywhere', async () => {
    // Registry entry exists but lacks a model, and the resolved effort
    // profile is overridden to also lack a model — and project has no default
    // either.
    const db = makeDb({
      registry: makeRegistryRow({ model: null, defaultEffort: null }),
      project: makeProjectRow({ defaultModel: null, defaultEffort: null }),
    });
    await expect(
      resolveSpec(db, {
        org: ORG,
        project: PROJECT,
        unitType: 'thing',
        defaultEffortProfiles: {
          // Strip the model field out of the standard built-in so nothing in
          // the chain has one.
          standard: {
            model: undefined,
            maxOutputTokens: 100,
            validationPasses: 1,
            multiSample: 1,
            temperature: 0.3,
            estimatedCostUsdPerCall: 0,
          } as Partial<EffortProfile>,
        },
      }),
    ).rejects.toThrow(SpecResolutionError);
  });

  it('falls back to project_configs.defaultModel when registry lacks model', async () => {
    const db = makeDb({
      registry: makeRegistryRow({ model: null }),
      project: makeProjectRow({ defaultModel: 'project/fallback' }),
    });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      // Force a level whose built-in profile we'll strip the model from so the
      // project default actually gets used instead of the built-in.
      requestOverrides: { effortLevel: 'standard' },
      defaultEffortProfiles: {
        standard: { model: undefined } as Partial<EffortProfile>,
      },
    });
    expect(spec.model).toBe('project/fallback');
  });
});

// ---------------------------------------------------------------------------
// metaPromptTemplate (the registry-level system prompt)
// ---------------------------------------------------------------------------
//
// The column has existed since migration 0002 and was resolved into the spec but
// consumed by nothing. `metaPromptSource` is the provenance tag the generation
// path needs to place it correctly in the precedence ladder.

describe('resolveSpec — metaPromptTemplate provenance', () => {
  it('is absent when neither the registry row nor an inline override sets one', async () => {
    const db = makeDb({ registry: makeRegistryRow(), project: makeProjectRow() });
    const spec = await resolveSpec(db, { org: ORG, project: PROJECT, unitType: 'thing' });
    expect(spec.metaPromptTemplate).toBeUndefined();
    expect(spec.metaPromptSource).toBeUndefined();
  });

  it('tags a registry-sourced template as `registry`', async () => {
    const db = makeDb({
      registry: makeRegistryRow({ metaPromptTemplate: 'standing rules' }),
      project: makeProjectRow(),
    });
    const spec = await resolveSpec(db, { org: ORG, project: PROJECT, unitType: 'thing' });
    expect(spec.metaPromptTemplate).toBe('standing rules');
    expect(spec.metaPromptSource).toBe('registry');
  });

  it('tags an inline specOverride template as `inline` and lets it win', async () => {
    const db = makeDb({
      registry: makeRegistryRow({ metaPromptTemplate: 'registry rules' }),
      project: makeProjectRow(),
    });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specOverride: { metaPromptTemplate: 'inline rules' },
    });
    expect(spec.metaPromptTemplate).toBe('inline rules');
    expect(spec.metaPromptSource).toBe('inline');
  });
});

// ---------------------------------------------------------------------------
// specDefault — the FLOOR slot.
//
// `specOverride` is a ceiling (wins over everything); `specDefault` is its
// mirror image (loses to the registry row). The distinction is not cosmetic:
// `/v1/route` shipped its built-in prompt in the ceiling slot, so every
// registered `capability-router` entry was resolved and then discarded. These
// tests pin the direction of the precedence in both states.
// ---------------------------------------------------------------------------

describe('resolveSpec — specDefault (floor)', () => {
  it('supplies the prompt when there is no registered row', async () => {
    const db = makeDb({});
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in {{x}}', effortLevel: 'quick' },
    });
    expect(spec.promptTemplate).toBe('built-in {{x}}');
    expect(spec.effortLevel).toBe('quick');
    expect(spec.registryEntryId).toBeUndefined();
  });

  it('satisfies the hard precondition on its own (no registry row, no project row)', async () => {
    // `project_configs` is empty on every deployed environment, so an endpoint
    // that ships a floor must not need a project row to avoid throwing.
    const db = makeDb({});
    await expect(
      resolveSpec(db, {
        org: ORG,
        project: PROJECT,
        unitType: 'thing',
        specDefault: { promptTemplate: 'built-in' },
      }),
    ).resolves.toMatchObject({ promptTemplate: 'built-in' });
  });

  it('🔴 a registered row BEATS the floor', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', effortLevel: 'quick' },
    });
    expect(spec.promptTemplate).toBe('registered prompt {{x}}');
    expect(spec.model).toBe('registered/model');
    expect(spec.effortLevel).toBe('standard');
  });

  it('keeps registry provenance intact (unlike specOverride, which suppresses it)', async () => {
    const db = makeDb({ registry: makeRegistryRow() });
    const withFloor = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in' },
    });
    expect(withFloor.registryEntryId).toBe('11111111-1111-1111-1111-111111111111');
    expect(withFloor.registryEntryVersion).toBe('1');

    const withCeiling = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specOverride: { promptTemplate: 'inline' },
    });
    expect(withCeiling.registryEntryId).toBeUndefined();
  });

  it('falls through per FIELD: registry prompt + floor responseSchema', async () => {
    const db = makeDb({ registry: makeRegistryRow({ responseSchema: null }) });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', responseSchema: { type: 'object' } },
    });
    expect(spec.promptTemplate).toBe('registered prompt {{x}}');
    // `response_schema` is a NULLABLE column, so "unset" is representable and
    // the floor fills the gap.
    expect(spec.responseSchema).toEqual({ type: 'object' });
  });

  it('⚠ a registered row shadows floor validators even when its list is empty', async () => {
    // `registry_entries.validators` is NOT NULL DEFAULT '[]', so "unset" is NOT
    // representable: every row states a validator list, and `[]` is a real
    // statement of "none". Registering a unit-type therefore drops a floor's
    // validators. Pinned deliberately — a caller that needs validators to
    // survive registration must put them in `specOverride`, not `specDefault`.
    const withRow = await resolveSpec(makeDb({ registry: makeRegistryRow({ validators: [] }) }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', validators: ['json-schema'] },
    });
    expect(withRow.validators).toEqual([]);

    // With no row at all, the floor's validators do apply.
    const noRow = await resolveSpec(makeDb({}), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', validators: ['json-schema'] },
    });
    expect(noRow.validators).toEqual(['json-schema']);
  });

  it('request-level overrides still beat the floor', async () => {
    const db = makeDb({});
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', effortLevel: 'quick', model: 'floor/model' },
      requestOverrides: { effortLevel: 'deep', modelOverride: 'req/model' },
    });
    expect(spec.effortLevel).toBe('deep');
    expect(spec.model).toBe('req/model');
  });

  it('specOverride still beats the floor', async () => {
    const db = makeDb({});
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', effortLevel: 'quick' },
      specOverride: { promptTemplate: 'inline', effortLevel: 'maximum' },
    });
    expect(spec.promptTemplate).toBe('inline');
    expect(spec.effortLevel).toBe('maximum');
  });

  it('the floor outranks project_configs (unit-type default beats project-wide)', async () => {
    const db = makeDb({ project: makeProjectRow({ defaultEffort: 'deep', defaultModel: 'p/m' }) });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'built-in', effortLevel: 'quick', model: 'floor/model' },
    });
    expect(spec.effortLevel).toBe('quick');
    expect(spec.model).toBe('floor/model');
  });

  it('a floor effortProfile is the lowest overlay — registry wins over it', async () => {
    const db = makeDb({
      registry: makeRegistryRow({ effortProfiles: { standard: { maxOutputTokens: 999 } } }),
    });
    const spec = await resolveSpec(db, {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: {
        promptTemplate: 'built-in',
        effortProfile: { maxOutputTokens: 111, temperature: 0.9 },
      },
    });
    expect(spec.effortProfile.maxOutputTokens).toBe(999); // registry overlay wins
    expect(spec.effortProfile.temperature).toBe(0.9); // floor still fills the gap
  });

  it('tags a floor-sourced metaPromptTemplate as `default`, and the registry beats it', async () => {
    const floorOnly = await resolveSpec(makeDb({}), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { promptTemplate: 'p', metaPromptTemplate: 'floor rules' },
    });
    expect(floorOnly.metaPromptTemplate).toBe('floor rules');
    expect(floorOnly.metaPromptSource).toBe('default');

    const withRow = await resolveSpec(
      makeDb({ registry: makeRegistryRow({ metaPromptTemplate: 'registry rules' }) }),
      {
        org: ORG,
        project: PROJECT,
        unitType: 'thing',
        specDefault: { promptTemplate: 'p', metaPromptTemplate: 'floor rules' },
      },
    );
    expect(withRow.metaPromptTemplate).toBe('registry rules');
    expect(withRow.metaPromptSource).toBe('registry');
  });

  it('is a no-op for every existing caller (no specDefault passed)', async () => {
    const db = makeDb({ registry: makeRegistryRow(), project: makeProjectRow() });
    const spec = await resolveSpec(db, { org: ORG, project: PROJECT, unitType: 'thing' });
    expect(spec).toMatchObject({
      promptTemplate: 'registered prompt {{x}}',
      model: 'registered/model',
      effortLevel: 'standard',
      validators: [],
    });
    expect(spec.metaPromptSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tenant scope — the predicate, not the row
// ---------------------------------------------------------------------------
//
// Every case above asserts on the ROW the stub handed back, and the stub picks
// that row by table identity alone. That says nothing whatsoever about the
// WHERE clause — and the WHERE clause is the only thing standing between two
// consumers' registered prompts. These cases read the predicate itself.

describe('resolveSpec — tenant scope of the queries it issues', () => {
  it('🔴 scopes the registry lookup to (org, project) AND unitType — not to unitType alone', async () => {
    await resolveSpec(makeDb({ registry: makeRegistryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
    });

    const lookups = wheres.for('registry_entries');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    // Column by column, so dropping any ONE of the three is its own named
    // failure rather than one opaque "the SQL changed".
    expect(lookup.sql).toContain('"registry_entries"."org" =');
    expect(lookup.sql).toContain('"registry_entries"."project" =');
    expect(lookup.sql).toContain('"registry_entries"."unit_type" =');
    // …and the values bound are the CALLER's scope, in that order. A predicate
    // that named the right columns but bound a constant, or compared `org`
    // against another column, would sail past the check above.
    expect(lookup.params).toEqual([ORG, PROJECT, 'thing']);
  });

  it('🔴 scopes the project_configs lookup to (org, project) — it has no other filter at all', async () => {
    // `project_configs` is read on EVERY resolve, with or without a unitType,
    // and (org, project) is its whole predicate. There is no id or name to fall
    // back on here: lose either term and the query returns some other tenant's
    // default model and callback URL.
    await resolveSpec(makeDb({ project: makeProjectRow() }), {
      org: ORG,
      project: PROJECT,
      specDefault: { promptTemplate: 'built-in' },
    });

    const lookups = wheres.for('project_configs');
    expect(lookups).toHaveLength(1);
    const lookup = lookups[0]!;
    expect(lookup.sql).toContain('"project_configs"."org" =');
    expect(lookup.sql).toContain('"project_configs"."project" =');
    expect(lookup.params).toEqual([ORG, PROJECT]);
  });

  it('🔴 binds the CALLER scope, never the scope of the row that comes back', async () => {
    // The stub returns a row stamped ORG/PROJECT no matter who asks — exactly
    // the shape of a cross-tenant read. If `resolveSpec` ever sourced its
    // filter from the row (or from a cached spec) instead of its arguments,
    // this is the only case in the file that would notice.
    await resolveSpec(makeDb({ registry: makeRegistryRow(), project: makeProjectRow() }), {
      org: 'other-org',
      project: 'other-project',
      unitType: 'thing',
    });

    wheres.expectEveryQueryScopedTo('registry_entries', {
      org: 'other-org',
      project: 'other-project',
    });
    wheres.expectEveryQueryScopedTo('project_configs', {
      org: 'other-org',
      project: 'other-project',
    });
  });

  it('🔴 issues no unfiltered query, including on the throw-nothing-resolvable path', async () => {
    // Both reads happen BEFORE the precondition throws, so the error path is a
    // real query path and gets the same guarantee. `and()` with every `eq(...)`
    // stripped out collapses to `undefined`, which the recorder stores as the
    // `<NO PREDICATE>` marker — a full-table read, caught here by name.
    await expect(
      resolveSpec(makeDb({}), { org: ORG, project: PROJECT, unitType: 'unknown' }),
    ).rejects.toBeInstanceOf(SpecResolutionError);

    expect(wheres.calls.map((c) => c.table)).toEqual(['registry_entries', 'project_configs']);
    // A real gate now, not a restatement of the line above: both chains settle
    // through `guard`, so a DELETED `.where()` arrives here as `<NO PREDICATE>`
    // — present in the list, and rejected by name — rather than leaving the
    // list short and being reported as "the stub was never reached".
    wheres.expectNoUnfilteredQuery();
  });
});

describe('resolveSpec — responseSchemaStrict (strict schema-constrained output)', () => {
  const strictSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };

  async function resolveWith(
    spec: { specOverride?: InlineSpecOverride; specDefault?: InlineSpecOverride },
    registry?: unknown,
  ) {
    return resolveSpec(makeDb({ project: makeProjectRow(), ...(registry ? { registry } : {}) }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      ...spec,
    });
  }

  async function causeOf(p: Promise<unknown>): Promise<{ cause: string; message: string }> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(SpecResolutionError);
      const e = err as SpecResolutionError;
      return { cause: e.cause, message: e.message };
    }
    throw new Error('expected resolveSpec to throw');
  }

  it('absent ⇒ the spec carries no strict flag (JSON mode, unchanged)', async () => {
    const spec = await resolveWith({
      specOverride: { promptTemplate: 'p', model: 'openai/gpt-4o-mini', responseSchema: strictSchema },
    });
    expect(spec.responseSchemaStrict).toBeUndefined();
  });

  it('specOverride sets it on a supported model and a strict-ready schema', async () => {
    const spec = await resolveWith({
      specOverride: {
        promptTemplate: 'p',
        model: 'openai/gpt-4o-mini',
        responseSchema: strictSchema,
        responseSchemaStrict: true,
      },
    });
    expect(spec.responseSchemaStrict).toBe(true);
    expect(spec.responseSchema).toEqual(strictSchema);
  });

  it('specDefault (floor) can set it too, and specOverride: false beats it', async () => {
    const floor = { promptTemplate: 'p', model: 'openai/gpt-4o-mini', responseSchema: strictSchema, responseSchemaStrict: true };
    expect((await resolveWith({ specDefault: floor })).responseSchemaStrict).toBe(true);
    expect(
      (await resolveWith({ specDefault: floor, specOverride: { responseSchemaStrict: false } }))
        .responseSchemaStrict,
    ).toBeUndefined();
  });

  it('applies strict mode to a registry-supplied responseSchema', async () => {
    const spec = await resolveWith(
      { specDefault: { responseSchemaStrict: true } },
      makeRegistryRow({ model: 'openai/gpt-4o', responseSchema: strictSchema }),
    );
    expect(spec.responseSchemaStrict).toBe(true);
    expect(spec.model).toBe('openai/gpt-4o');
  });

  it('🔴 refuses an unsupported model with a 400 — never downgrades to JSON mode', async () => {
    const { cause, message } = await causeOf(
      resolveWith({
        specOverride: {
          promptTemplate: 'p',
          model: 'deepseek/deepseek-r1',
          responseSchema: strictSchema,
          responseSchemaStrict: true,
        },
      }),
    );
    expect(cause).toBe('strict schema unsupported model');
    expect(message).toContain("'deepseek/deepseek-r1'");
    expect(message).toContain('GET /v1/capabilities');
    expect(new SpecResolutionError({ cause: 'strict schema unsupported model' }).status).toBe(400);
  });

  it('refuses strict mode with no responseSchema to enforce', async () => {
    const { cause } = await causeOf(
      resolveWith({
        specOverride: { promptTemplate: 'p', model: 'openai/gpt-4o-mini', responseSchemaStrict: true },
      }),
    );
    expect(cause).toBe('strict schema invalid');
  });

  it('refuses a schema outside the strict subset, listing every offending path', async () => {
    const { cause, message } = await causeOf(
      resolveWith({
        specOverride: {
          promptTemplate: 'p',
          model: 'openai/gpt-4o-mini',
          responseSchema: { type: 'object', properties: { a: { type: 'string', minLength: 1 } } },
          responseSchemaStrict: true,
        },
      }),
    );
    expect(cause).toBe('strict schema invalid');
    expect(message).toContain('#: an object needs `additionalProperties: false`');
    expect(message).toContain('missing "a"');
    expect(message).toContain('#/properties/a: keyword `minLength` is not supported');
  });
});
