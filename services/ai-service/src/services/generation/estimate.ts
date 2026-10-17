// Pure cost estimation for a resolved batch.
//
// Each `ResolvedUnit` already carries its own `EffortProfile` (the registry
// resolver attaches it during `resolveSpec`): every unit costs exactly one rollup of
// `perCall × validationPasses × multiSample`, summed across the batch.
//
// Side-effect free — no DB, no queue. Called from:
//   • `/v1/generate` for the orchestrator's budget gate.
//   • `/v1/generate/estimate` (M3.6) for UI pre-flight previews.

import type { EffortLevel, ResolvedUnit } from '../../types/generation.js';

export interface CostEstimate {
  totalJobs: number;
  estimatedCostUsd: number;
  perUnit: Array<{
    unitKey: string;
    unitType?: string;
    effortLevel: EffortLevel;
    estimatedCostUsd: number;
  }>;
  budgetRemainingUsd: number | null;
  overBudget: boolean;
}

/** Single-unit cost: `perCall × validationPasses × multiSample`. */
function unitCost(unit: ResolvedUnit): number {
  const { effortProfile } = unit.spec;
  const passes = effortProfile.validationPasses;
  const samples = effortProfile.multiSample;
  return effortProfile.estimatedCostUsdPerCall * passes * samples;
}

/**
 * Estimate the total cost of running every unit in `units`. If a unit already
 * has `estimatedCostUsd` populated (the orchestrator stamps this during
 * resolution), reuse it instead of recomputing — avoids drift between the
 * stamped per-unit number and the batch total.
 */
export function estimateBatch(
  units: ResolvedUnit[],
  budgetRemainingUsd: number | null = null,
): CostEstimate {
  const perUnit: CostEstimate['perUnit'] = [];
  let total = 0;

  for (const u of units) {
    const cost = u.estimatedCostUsd > 0 ? u.estimatedCostUsd : unitCost(u);
    total += cost;
    perUnit.push({
      unitKey: u.unit.unitKey,
      unitType: u.unit.unitType,
      effortLevel: u.spec.effortLevel,
      estimatedCostUsd: round6(cost),
    });
  }

  const estimatedCostUsd = round6(total);
  const overBudget =
    budgetRemainingUsd != null && estimatedCostUsd > budgetRemainingUsd;

  return {
    totalJobs: units.length,
    estimatedCostUsd,
    perUnit,
    budgetRemainingUsd,
    overBudget,
  };
}

/** Round to 6 decimals — matches USD micro-cent precision. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
