// Security-contract tests for audit finding C4 — "Budget &
// token/cost caps fully bypassable via caller-supplied `effortProfile`".
//
// ⚠ THIS FILE IS A TRIPWIRE. Read `plan/open-maxoutputtokens-clamp-not-delete.md`
// before changing it.
//
// The audit's own fix spec (step 4) proposed CLOSING C4 by *dropping*
// caller-supplied `maxOutputTokens` from the overlays in `resolveSpec`. Doing
// that would silently disable the chat product's per-user credit cap: chat
// sends `unit.specOverride.effortProfile.maxOutputTokens`, meters credits from
// the resulting output-token count, and reads `finishReason: 'length'` to know
// the answer was cut short. Delete the overlay and the cap stops applying, the
// truncation signal stops firing at the boundary chat reasoned about, and there
// is no error anywhere — just bigger bills.
//
// So the remediation is a CLAMP, and the two halves are tested together on
// purpose:
//   • "an over-ceiling request is bounded"  → proves the exploit is closed.
//   • "a below-ceiling request survives"    → proves the fix did not become a
//                                             deletion. THIS is the one that
//                                             goes red if someone applies the
//                                             audit's step 4 literally.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { projectConfigs, registryEntries } from '../../db/schema/index.js';
import { WhereRecorder } from '../../test/where-recorder.js';

import {
  clampCallerLimits,
  MAX_MULTI_SAMPLE,
  MAX_OUTPUT_TOKENS,
} from './caller-limits.js';
import { EFFORT_PROFILES, resolveSpec, type EffortProfile } from './resolve.js';

// ---------------------------------------------------------------------------
// Stub db — same shape as the one in `resolve.test.ts`; kept local so this
// security contract stays readable on its own.
//
// 🔴 `where()` TAKES ITS ARGUMENT. This local copy used to read
// `where: () => chain` — no parameter — so the `(org, project)` predicate
// `resolveSpec` builds was thrown away before anything could look at it, and
// every case here agreed with any WHERE clause including none. That matters
// doubly in THIS file: it is a security tripwire for audit finding C4, and a
// tripwire whose db stub cannot see a filter is a tripwire with one wire cut.
// The predicates now go through `WhereRecorder`, which serialises them with
// drizzle's own dialect and keeps the bound parameters.
//
// 🔴 AND BOTH TERMINALS SETTLE THROUGH `WhereRecorder.guard()`.
// Taking the argument only catches the mutation that EMPTIES the predicate.
// `where` returns the chain itself, so deleting the `.where()` call outright
// leaves `.from(projectConfigs).limit(1)` — a legal chain that still resolves
// to the canned row. Measured on this file at HEAD, with
// `.where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))`
// deleted from `resolve.ts`: 12 of 14 cases stayed GREEN, and the 2 reds said
// "no where() was recorded for 'project_configs' at all — the stub was never
// reached", which is not what happened. `guard.settle()` records the
// never-filtered chain as `<NO PREDICATE>` so the deleted call fails by name.
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';

/** Every predicate the stubbed queries built. Cleared in `beforeEach`. */
const wheres = new WhereRecorder();

function makeDb(rows: { registry?: unknown; project?: unknown } = {}): Db {
  const build = (table: unknown) => {
    let row: unknown = undefined;
    // Named as Postgres knows the table, so a failure reads like the schema.
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
    // ONE guard per chain instance — per `from()`, i.e. per query.
    const guard = wheres.guard(name);
    const chain: {
      where: (predicate: unknown) => typeof chain;
      limit: (n?: number) => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void) => void;
    } = {
      where: (predicate: unknown) => {
        guard.where(predicate);
        return chain;
      },
      // 🔴 Both terminals settle through the guard — see the header. Without
      // this the tripwire has a second cut wire: it would watch the predicates
      // that were PASSED and be blind to the `.where()` call being DELETED.
      limit: async () => guard.settle(result),
      then: (resolve) => {
        Promise.resolve(guard.settle(result)).then(resolve);
      },
    };
    return chain;
  };
  return { select: () => ({ from: (t: unknown) => build(t) }) } as unknown as Db;
}

beforeEach(() => {
  wheres.reset();
});

function registryRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    org: ORG,
    project: PROJECT,
    unitType: 'thing',
    version: '1',
    isActive: true,
    promptTemplate: 'registered prompt',
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

const STANDARD = EFFORT_PROFILES.standard;

/** A caller cap well under the ceiling — the shape chat actually sends. */
const CHAT_STYLE_CAP = 120;

// ---------------------------------------------------------------------------
// The pure clamp
// ---------------------------------------------------------------------------

describe('clampCallerLimits — bound direction per field', () => {
  const baseline: EffortProfile = { ...STANDARD };

  function merged(over: Partial<Record<keyof EffortProfile, unknown>>): EffortProfile {
    return { ...baseline, ...over } as EffortProfile;
  }

  it('🔴 keeps a below-ceiling maxOutputTokens EXACTLY as supplied', () => {
    const out = clampCallerLimits(merged({ maxOutputTokens: CHAT_STYLE_CAP }), baseline);
    expect(out.maxOutputTokens).toBe(CHAT_STYLE_CAP);
  });

  it('bounds an over-ceiling maxOutputTokens at MAX_OUTPUT_TOKENS', () => {
    const out = clampCallerLimits(merged({ maxOutputTokens: 200_000 }), baseline);
    expect(out.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('bounds multiSample in BOTH directions (extra samples are extra billed calls)', () => {
    expect(clampCallerLimits(merged({ multiSample: 50 }), baseline).multiSample).toBe(
      MAX_MULTI_SAMPLE,
    );
    // `0` would zero the pre-flight estimate while the router still makes one
    // real call — an under-estimate, so the floor matters as much as the cap.
    expect(clampCallerLimits(merged({ multiSample: 0 }), baseline).multiSample).toBe(1);
    expect(clampCallerLimits(merged({ multiSample: -7 }), baseline).multiSample).toBe(1);
  });

  it('floors validationPasses at 1 but deliberately does NOT cap it', () => {
    // Estimate-only multiplier: `0` slips the advisory budget gate, but a
    // ceiling would make that gate weaker, not stronger.
    expect(clampCallerLimits(merged({ validationPasses: 0 }), baseline).validationPasses).toBe(1);
    expect(
      clampCallerLimits(merged({ validationPasses: 99 }), baseline).validationPasses,
    ).toBe(99);
  });

  it('🔴 floors estimatedCostUsdPerCall at the admin baseline — the reserve cannot be zeroed', () => {
    // This is the field the Critical turns on: it becomes the budget reserve,
    // and `Router.budgetReserve` returns early when `amountUsd <= 0`, skipping
    // the budget check entirely.
    const zeroed = clampCallerLimits(merged({ estimatedCostUsdPerCall: 0 }), baseline);
    expect(zeroed.estimatedCostUsdPerCall).toBe(STANDARD.estimatedCostUsdPerCall);
    expect(zeroed.estimatedCostUsdPerCall).toBeGreaterThan(0);

    expect(
      clampCallerLimits(merged({ estimatedCostUsdPerCall: -100 }), baseline)
        .estimatedCostUsdPerCall,
    ).toBe(STANDARD.estimatedCostUsdPerCall);

    // A caller may still reserve MORE than the admin configured.
    expect(
      clampCallerLimits(merged({ estimatedCostUsdPerCall: 5 }), baseline)
        .estimatedCostUsdPerCall,
    ).toBe(5);
  });

  it('never emits NaN/Infinity from a non-numeric wire value', () => {
    // The wire schema is `z.record(z.string(), z.unknown())`, so these all really arrive.
    for (const junk of ['200000', NaN, Infinity, -Infinity, null, {}, [], true]) {
      const out = clampCallerLimits(
        merged({
          maxOutputTokens: junk,
          multiSample: junk,
          validationPasses: junk,
          estimatedCostUsdPerCall: junk,
        }),
        baseline,
      );
      expect(Number.isFinite(out.maxOutputTokens)).toBe(true);
      expect(Number.isFinite(out.multiSample)).toBe(true);
      expect(Number.isFinite(out.validationPasses)).toBe(true);
      expect(Number.isFinite(out.estimatedCostUsdPerCall)).toBe(true);
      expect(out.maxOutputTokens).toBe(STANDARD.maxOutputTokens);
      expect(out.estimatedCostUsdPerCall).toBe(STANDARD.estimatedCostUsdPerCall);
    }
  });

  it('is pure — neither argument is mutated, and unrelated fields pass through', () => {
    const m = merged({ maxOutputTokens: 200_000, temperature: 0.9, model: 'x/y' });
    const before = { ...m };
    const out = clampCallerLimits(m, baseline);
    expect(m).toEqual(before);
    expect(baseline).toEqual(STANDARD);
    expect(out.temperature).toBe(0.9);
    expect(out.model).toBe('x/y');
  });
});

// ---------------------------------------------------------------------------
// End to end through resolveSpec — the layer the audit wanted to delete
// ---------------------------------------------------------------------------

describe('resolveSpec — C4 clamp, applied after the overlay merge', () => {
  it('🔴 a caller-supplied maxOutputTokens BELOW the ceiling survives untouched (specOverride)', async () => {
    // ⚠ IF THIS TEST GOES RED because `maxOutputTokens` was dropped from the
    // `fromInline` overlay: that is the audit's step 4, and it breaks the chat
    // product's per-user credit cap. Clamp it, don't delete it. See
    // `plan/open-maxoutputtokens-clamp-not-delete.md`.
    const spec = await resolveSpec(makeDb({ registry: registryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specOverride: { effortProfile: { maxOutputTokens: CHAT_STYLE_CAP } },
    });
    expect(spec.effortProfile.maxOutputTokens).toBe(CHAT_STYLE_CAP);
    // A caller-supplied `effortProfile` must not buy the caller anything BUT
    // the clamped numbers — least of all a widened read. The registry row that
    // fed this spec still had to be found under the caller's own tenant scope.
    // EVERY read of the table, not just one: `resolveSpec` reads it once and
    // never legitimately unscoped, so "at least one was scoped" is the wrong
    // question to ask of a security tripwire.
    wheres.expectEveryQueryScopedTo('registry_entries', { org: ORG, project: PROJECT });
  });

  it('🔴 ...and via specDefault and effortOverrides, the other two caller-supplied layers', async () => {
    const viaDefault = await resolveSpec(makeDb({ registry: registryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specDefault: { effortProfile: { maxOutputTokens: CHAT_STYLE_CAP } },
    });
    expect(viaDefault.effortProfile.maxOutputTokens).toBe(CHAT_STYLE_CAP);

    const viaRequest = await resolveSpec(makeDb({ registry: registryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      requestOverrides: {
        effortOverrides: { thing: { maxOutputTokens: CHAT_STYLE_CAP } },
      },
    });
    expect(viaRequest.effortProfile.maxOutputTokens).toBe(CHAT_STYLE_CAP);
  });

  it('bounds the exact exploit payload from the audit', async () => {
    // POST /v1/generate/sync with
    //   unit.specOverride.effortProfile =
    //     { estimatedCostUsdPerCall: 0, maxOutputTokens: 200000, multiSample: 50 }
    const spec = await resolveSpec(makeDb({ registry: registryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
      specOverride: {
        effortProfile: {
          estimatedCostUsdPerCall: 0,
          maxOutputTokens: 200_000,
          multiSample: 50,
        },
      },
    });
    expect(spec.effortProfile.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(spec.effortProfile.multiSample).toBe(MAX_MULTI_SAMPLE);
    // > 0 is the load-bearing assertion: it is what stops `budgetReserve`
    // short-circuiting on `amountUsd <= 0` and skipping the budget entirely.
    expect(spec.effortProfile.estimatedCostUsdPerCall).toBeGreaterThan(0);
  });

  it('leaves a request that overrides nothing byte-identical to the built-in profile', async () => {
    // Zero blast radius for every consumer that does not send these fields.
    const spec = await resolveSpec(makeDb({ registry: registryRow() }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
    });
    expect(spec.effortProfile).toEqual({ ...STANDARD, model: 'registered/model' });
  });

  it('an admin-configured profile is still free to exceed nothing it could before', async () => {
    // A registry row is admin-controlled, but the ceiling is absolute — it is a
    // spend limit on the shared provider key, not a trust check.
    const spec = await resolveSpec(
      makeDb({
        registry: registryRow({
          effortProfiles: { standard: { maxOutputTokens: 50_000, multiSample: 9 } },
        }),
      }),
      { org: ORG, project: PROJECT, unitType: 'thing' },
    );
    expect(spec.effortProfile.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(spec.effortProfile.multiSample).toBe(MAX_MULTI_SAMPLE);
  });
});

// ---------------------------------------------------------------------------
// Tenant scope of the resolve path this file drives
// ---------------------------------------------------------------------------
//
// `resolve.test.ts` owns the precedence pipeline, but this file drives the SAME
// `resolveSpec` through its own local stub. A stub is only as strong as the
// weakest copy of it, so the tenant predicate is re-pinned here: fixing
// `resolve.test.ts` alone would leave this copy able to green-light a
// `resolveSpec` that reads across tenants.

describe('resolveSpec — tenant scope (re-pinned for this file\'s own stub)', () => {
  it('🔴 the registry and project_configs reads are scoped to (org, project), not to the unitType alone', async () => {
    await resolveSpec(makeDb({ registry: registryRow(), project: {} }), {
      org: ORG,
      project: PROJECT,
      unitType: 'thing',
    });

    const registry = wheres.for('registry_entries');
    expect(registry).toHaveLength(1);
    expect(registry[0]!.params).toEqual([ORG, PROJECT, 'thing']);

    const project = wheres.for('project_configs');
    expect(project).toHaveLength(1);
    expect(project[0]!.params).toEqual([ORG, PROJECT]);

    // Column names as well as values: the right string bound to the wrong
    // filter would satisfy the params check on its own.
    expect(registry[0]!.sql).toContain('"registry_entries"."org" =');
    expect(registry[0]!.sql).toContain('"registry_entries"."project" =');
    expect(project[0]!.sql).toContain('"project_configs"."org" =');
    expect(project[0]!.sql).toContain('"project_configs"."project" =');
    // A real gate now: both chains settle through `guard`, so a DELETED
    // `.where()` lands in this list as `<NO PREDICATE>` rather than vanishing.
    wheres.expectNoUnfilteredQuery();
  });

  it('🔴 an exploit-shaped specOverride does not widen the read either', async () => {
    // The audit's payload sets cost to 0 and the token cap to 200k. Whatever it
    // does to the numbers, it must not reach a row it was not entitled to: the
    // caller scope below is a tenant that owns nothing the stub returns.
    await resolveSpec(makeDb({ registry: registryRow() }), {
      org: 'other-org',
      project: 'other-project',
      unitType: 'thing',
      specOverride: {
        effortProfile: {
          estimatedCostUsdPerCall: 0,
          maxOutputTokens: 200_000,
          multiSample: 50,
        },
      },
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
});
