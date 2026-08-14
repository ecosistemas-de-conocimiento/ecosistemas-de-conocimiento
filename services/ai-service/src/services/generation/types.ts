// Orchestrator-local errors. `BudgetExceeded` lives in `src/services/budget/errors.ts`
// (the budget enforcer is its source of truth); it's re-exported below so route
// handlers can `import { BudgetExceededError } from '../services/generation/types.js'`
// alongside the rest of the generation surface.

import { BudgetExceeded, BudgetNotConfigured } from '../budget/errors.js';

export { BudgetExceeded as BudgetExceededError, BudgetNotConfigured };

export const ERR_DEPENDENCY_CYCLE = 'ERR_DEPENDENCY_CYCLE';
export const ERR_DEPENDENCY_OUT_OF_BATCH = 'ERR_DEPENDENCY_OUT_OF_BATCH';

/** A `dependsOn` graph contains a cycle. Detected before any DB write. */
export class DependencyCycleError extends Error {
  readonly code = ERR_DEPENDENCY_CYCLE;
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`dependsOn cycle detected: ${cycle.join(' → ')}`);
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
}

/** A `dependsOn` slot references a `unitKey` not in the same batch. */
export class CrossBatchDependencyError extends Error {
  readonly code = ERR_DEPENDENCY_OUT_OF_BATCH;
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`dependsOn references unitKeys not in batch: ${missing.join(', ')}`);
    this.name = 'CrossBatchDependencyError';
    this.missing = missing;
  }
}
