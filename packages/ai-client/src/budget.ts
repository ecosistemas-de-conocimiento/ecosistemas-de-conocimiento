// Budget sub-API.

import type { HttpClient } from './http.js';
import type { SetBudgetResult } from './tenant.js';
import type { BudgetSnapshot } from './types.js';

export class BudgetAPI {
  constructor(private readonly http: HttpClient) {}

  async get(org: string): Promise<BudgetSnapshot> {
    return this.http.json<BudgetSnapshot>({
      method: 'GET',
      path: `/v1/budget/${encodeURIComponent(org)}`,
    });
  }

  /**
   * Set the org's hard spending cap. **Admin role required**, and `org` must be
   * the caller's own scope (a mismatch is 403 — the path can never widen
   * tenancy).
   *
   * This is the only thing that lifts the fail-closed gate: an org with no
   * budget row is refused with 402 `BudgetNotConfigured` on every generation.
   * Idempotent. `remaining` is clamped down to the new cap but never raised
   * unless `refill: true`.
   */
  async set(
    org: string,
    opts: { limitUsd: number; refill?: boolean },
  ): Promise<SetBudgetResult> {
    return this.http.json<SetBudgetResult>({
      method: 'PUT',
      path: `/v1/budget/${encodeURIComponent(org)}`,
      body: { limitUsd: opts.limitUsd, refill: opts.refill ?? false },
    });
  }
}
