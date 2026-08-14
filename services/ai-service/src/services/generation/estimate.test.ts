// Pure unit tests for `estimateBatch` — no DB, no queue, no registry.

import { describe, expect, it } from 'vitest';

import type {
  EffortLevel,
  EffortProfile,
  ResolvedSpec,
  ResolvedUnit,
} from '../../types/generation.js';
import { estimateBatch } from './estimate.js';

function makeProfile(over: Partial<EffortProfile> = {}): EffortProfile {
  return {
    maxOutputTokens: 800,
    validationPasses: 1,
    multiSample: 1,
    temperature: 0.4,
    estimatedCostUsdPerCall: 0.001,
    ...over,
  };
}

function makeUnit(opts: {
  unitKey: string;
  unitType?: string;
  effortLevel?: EffortLevel;
  profile?: Partial<EffortProfile>;
  estimatedCostUsd?: number;
}): ResolvedUnit {
  const spec: ResolvedSpec = {
    promptTemplate: 'noop',
    model: 'm',
    effortLevel: opts.effortLevel ?? 'standard',
    effortProfile: makeProfile(opts.profile),
    validators: [],
  };
  return {
    unit: { unitKey: opts.unitKey, unitType: opts.unitType },
    spec,
    estimatedCostUsd: opts.estimatedCostUsd ?? 0,
    renderedPromptOrTemplate: '',
    rendered: true,
  };
}

describe('estimateBatch', () => {
  it('single unit at validationPasses=1, multiSample=1, perCall=0.001 → 0.001', () => {
    const out = estimateBatch([makeUnit({ unitKey: 'u1' })]);
    expect(out.totalJobs).toBe(1);
    expect(out.estimatedCostUsd).toBeCloseTo(0.001, 9);
    expect(out.perUnit).toHaveLength(1);
    expect(out.perUnit[0]!.estimatedCostUsd).toBeCloseTo(0.001, 9);
  });

  it('validationPasses=2, multiSample=3 → perCall × 6', () => {
    const out = estimateBatch([
      makeUnit({
        unitKey: 'u1',
        profile: {
          estimatedCostUsdPerCall: 0.01,
          validationPasses: 2,
          multiSample: 3,
        },
      }),
    ]);
    expect(out.estimatedCostUsd).toBeCloseTo(0.06, 9);
    expect(out.perUnit[0]!.estimatedCostUsd).toBeCloseTo(0.06, 9);
  });

  it('sums correctly across multiple units', () => {
    const out = estimateBatch([
      makeUnit({ unitKey: 'a', profile: { estimatedCostUsdPerCall: 0.001 } }),
      makeUnit({
        unitKey: 'b',
        profile: {
          estimatedCostUsdPerCall: 0.005,
          validationPasses: 2,
        },
      }),
      makeUnit({
        unitKey: 'c',
        profile: {
          estimatedCostUsdPerCall: 0.008,
          validationPasses: 2,
          multiSample: 3,
        },
      }),
    ]);
    // 0.001 + 0.01 + 0.048 = 0.059
    expect(out.totalJobs).toBe(3);
    expect(out.estimatedCostUsd).toBeCloseTo(0.059, 9);
  });

  it('reuses a pre-populated unit.estimatedCostUsd', () => {
    const out = estimateBatch([
      makeUnit({
        unitKey: 'pinned',
        // profile would compute 0.001, but the stamped value wins.
        estimatedCostUsd: 0.123456,
      }),
    ]);
    expect(out.estimatedCostUsd).toBeCloseTo(0.123456, 9);
    expect(out.perUnit[0]!.estimatedCostUsd).toBeCloseTo(0.123456, 9);
  });

  it('overBudget=true when budget < total', () => {
    const out = estimateBatch(
      [makeUnit({ unitKey: 'u1', profile: { estimatedCostUsdPerCall: 0.5 } })],
      0.1,
    );
    expect(out.overBudget).toBe(true);
    expect(out.budgetRemainingUsd).toBe(0.1);
  });

  it('overBudget=false when budget >= total', () => {
    const out = estimateBatch([makeUnit({ unitKey: 'u1' })], 1);
    expect(out.overBudget).toBe(false);
    expect(out.budgetRemainingUsd).toBe(1);
  });

  it('overBudget=false at exact-equal budget', () => {
    const out = estimateBatch([makeUnit({ unitKey: 'u1' })], 0.001);
    expect(out.overBudget).toBe(false);
  });

  it('budgetRemainingUsd=null (omitted) → overBudget=false', () => {
    const out = estimateBatch([
      makeUnit({ unitKey: 'u1', profile: { estimatedCostUsdPerCall: 999 } }),
    ]);
    expect(out.budgetRemainingUsd).toBeNull();
    expect(out.overBudget).toBe(false);
  });

  it('echoes unitKey / unitType / effortLevel on perUnit rows', () => {
    const out = estimateBatch([
      makeUnit({ unitKey: 'k1', unitType: 't1', effortLevel: 'deep' }),
      makeUnit({ unitKey: 'k2', effortLevel: 'quick' }),
    ]);
    expect(out.perUnit[0]).toMatchObject({
      unitKey: 'k1',
      unitType: 't1',
      effortLevel: 'deep',
    });
    expect(out.perUnit[1]).toMatchObject({
      unitKey: 'k2',
      effortLevel: 'quick',
    });
    expect(out.perUnit[1]!.unitType).toBeUndefined();
  });
});
