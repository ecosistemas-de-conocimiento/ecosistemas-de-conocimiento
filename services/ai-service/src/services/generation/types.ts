// Orchestrator-local errors. `BudgetExceeded` lives in `src/services/budget/errors.ts`
// (the budget enforcer is its source of truth); it's re-exported below so route
// handlers can `import { BudgetExceededError } from '../services/generation/types.js'`
// alongside the rest of the generation surface.

import { AiServiceError } from '../../errors/base.js';
import { BudgetExceeded, BudgetMisconfigured, BudgetNotConfigured } from '../budget/errors.js';

export { BudgetExceeded as BudgetExceededError, BudgetMisconfigured, BudgetNotConfigured };

export const ERR_DEPENDENCY_CYCLE = 'ERR_DEPENDENCY_CYCLE';
export const ERR_DEPENDENCY_OUT_OF_BATCH = 'ERR_DEPENDENCY_OUT_OF_BATCH';

/** A `dependsOn` graph contains a cycle. Detected before any DB write. */
export class DependencyCycleError extends AiServiceError {
  readonly code = ERR_DEPENDENCY_CYCLE;
  readonly status = 400;
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`dependsOn cycle detected: ${cycle.join(' → ')}`);
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
  protected override bodyFields() {
    return { cycle: this.cycle };
  }
}

/** A `dependsOn` slot references a `unitKey` not in the same batch. */
export class CrossBatchDependencyError extends AiServiceError {
  readonly code = ERR_DEPENDENCY_OUT_OF_BATCH;
  readonly status = 400;
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`dependsOn references unitKeys not in batch: ${missing.join(', ')}`);
    this.name = 'CrossBatchDependencyError';
    this.missing = missing;
  }
  protected override bodyFields() {
    return { missing: this.missing };
  }
}
