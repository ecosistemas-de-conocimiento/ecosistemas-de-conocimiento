// Tenant sub-API — provisioning (admin) + readiness self-diagnosis (any role).
//
// Standing up a consuming project needs three things, and a missing one fails
// three unrelated-looking ways: no API key ⇒ 401, no registry entry ⇒ 400 "no
// active registry entry for unitType 'X'", no budget ⇒ 402 BudgetNotConfigured.
// `readiness()` reports all three at once, in plain words.

import type { HttpClient } from './http.js';
import type { Validator } from './types.js';

export type ReadinessCheckId = 'api-key' | 'budget' | 'registry';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  ok: boolean;
  /** Plain-language statement of what is (or isn't) in place. */
  summary: string;
  /** Plain-language next action; present only when `ok` is false. */
  fix?: string;
  detail?: Record<string, unknown>;
}

export interface ReadinessReport {
  org: string;
  project: string;
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface SetBudgetResult {
  org: string;
  limitUsd: number;
  remainingUsd: number;
  currency: string;
  /** True when this call created the budget row (the fail-closed gate lifted). */
  created: boolean;
}

export interface ProvisionUnitType {
  unitType: string;
  version: string;
  promptTemplate: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  defaultEffort?: 'quick' | 'standard' | 'deep' | 'maximum' | null;
  effortProfiles?: Record<string, unknown> | null;
  responseSchema?: Record<string, unknown> | null;
  validators?: Validator[];
  renderer?: string | null;
  contentKind?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Defaults to true — an inactive entry provisions nothing. */
  activate?: boolean;
}

export interface ProvisionTenantRequest {
  budget?: { limitUsd: number; refill?: boolean };
  unitTypes?: ProvisionUnitType[];
}

export interface ProvisionItemResult {
  /** `budget` or `registry:<unitType>`. */
  item: string;
  status: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  message: string;
  detail?: Record<string, unknown>;
}

export interface ProvisionTenantResult {
  org: string;
  project: string;
  items: ProvisionItemResult[];
  /** Never empty: API keys cannot be provisioned over HTTP. */
  manualSteps: Array<{ item: string; message: string }>;
  readiness: ReadinessReport;
}

export class TenantAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * What is this tenant missing? Callable with any role — the consumer hitting
   * the 401/400/402 can self-diagnose without an operator.
   *
   * Pass `unitType` to check ONE unit type precisely instead of "is any prompt
   * registered at all".
   */
  async readiness(opts: { unitType?: string } = {}): Promise<ReadinessReport> {
    const qs = opts.unitType
      ? `?unitType=${encodeURIComponent(opts.unitType)}`
      : '';
    return this.http.json<ReadinessReport>({
      method: 'GET',
      path: `/v1/tenant/readiness${qs}`,
    });
  }

  /**
   * Provision budget + registry entries for the calling tenant in one
   * idempotent call. Admin role required; `org`/`project` come from the bearer
   * token, never from the body.
   */
  async provision(req: ProvisionTenantRequest = {}): Promise<ProvisionTenantResult> {
    return this.http.json<ProvisionTenantResult>({
      method: 'POST',
      path: '/v1/tenant/provision',
      body: req,
    });
  }
}
