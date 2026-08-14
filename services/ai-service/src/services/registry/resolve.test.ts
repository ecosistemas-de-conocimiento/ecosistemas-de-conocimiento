// Unit tests for resolveSpec. The drizzle `db` is replaced with a tiny stub
// that returns canned rows for `registry_entries` and `project_configs`
// queries — keyed by which table the chain's `.from(...)` was called against.
// This keeps the tests free of Postgres while still exercising the resolver's
// full precedence pipeline.

import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { projectConfigs, registryEntries } from '../../db/schema/index.js';

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
function makeDb(rows: StubRows): Db {
  // Each `select()` starts a fresh builder so successive resolveSpec calls in
  // the same test don't share state.
  const build = (table: unknown) => {
    let row: unknown = undefined;
    if (table === registryEntries) row = rows.registry;
    if (table === projectConfigs) row = rows.project;
    const result: unknown[] = row ? [row] : [];
    const chain = {
      where: () => chain,
      limit: () => Promise.resolve(result),
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
