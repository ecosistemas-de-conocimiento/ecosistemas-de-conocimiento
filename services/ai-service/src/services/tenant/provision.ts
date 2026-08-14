// Tenant provisioning + readiness.
//
// ── The problem this solves ───────────────────────────────────────────────
// Standing up a new consuming project needs THREE things, and a missing one
// fails in three unrelated-looking ways:
//
//   1. an API key in the `API_KEYS` env map        → missing ⇒ 401 unauthorized
//   2. an active `registry_entries` row per        → missing ⇒ 400
//      unitType the consumer generates                "no active registry entry
//                                                      for unitType 'X'"
//   3. a `budget_state` row for the org            → missing ⇒ 402
//                                                      BudgetNotConfigured
//
// Three diagnoses for one root cause ("this tenant was never provisioned").
// `getTenantReadiness` collapses them into one answer in plain words, and
// `provisionTenant` does 2 + 3 in a single idempotent call.
//
// ── What CANNOT be automated ──────────────────────────────────────────────
// Item 1. API keys live in the `API_KEYS` environment variable, parsed once at
// boot by `src/config/env.ts`. There is no key table; adding a key means
// editing the environment and recreating the container. Every provisioning
// response says so explicitly rather than reporting success on 2 + 3 and
// leaving the operator to discover the 401 later.
//
// ── Tenancy invariant ─────────────────────────────────────────────────────
// `org` / `project` are ALWAYS taken from the caller's auth scope, never from a
// request body. These functions take them as explicit arguments and the route
// layer is the only thing that fills them in — from `req.auth`. An admin key
// provisions ITS OWN (org, project); it cannot reach across tenants. Widening
// that would require a deliberate new design, not a body field.

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { budgetState, registryEntries } from '../../db/schema/index.js';
import {
  createVersion,
  listUnitTypes,
  RegistryConflictError,
  type RegistryEntryCreate,
} from '../../db/registry.js';
import { setOrgBudget, type SetOrgBudgetInput } from '../budget/provision.js';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface TenantScope {
  org: string;
  project: string;
}

/** The three things a tenant needs, as stable machine ids. */
export type ReadinessCheckId = 'api-key' | 'budget' | 'registry';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  ok: boolean;
  /** Plain-language statement of what is (or isn't) in place. */
  summary: string;
  /** Plain-language next action. Present only when `ok` is false. */
  fix?: string;
  /** Machine-readable extras (counts, amounts) for tooling. */
  detail?: Record<string, unknown>;
}

export interface ReadinessReport {
  org: string;
  project: string;
  /** True only when every check passed. */
  ready: boolean;
  checks: ReadinessCheck[];
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadinessArgs extends TenantScope {
  /** Role of the calling key — reported back so a 403 later isn't a surprise. */
  role: 'app' | 'admin';
  /**
   * Optional: check that ONE specific unitType is generate-ready, instead of
   * "does this tenant have any registered prompt at all". This is the check
   * that pre-empts the `no active registry entry for unitType 'X'` 400.
   */
  unitType?: string | undefined;
}

export async function getTenantReadiness(
  db: Db,
  args: ReadinessArgs,
): Promise<ReadinessReport> {
  const { org, project, role, unitType } = args;
  const checks: ReadinessCheck[] = [];

  // 1. API key — reaching this code at all means the bearer token resolved.
  checks.push({
    id: 'api-key',
    ok: true,
    summary:
      `Your API key works. It is scoped to org "${org}", project "${project}", ` +
      `with the "${role}" role.`,
    detail: { org, project, role },
  });

  // 2. Budget.
  const budgetRows = await db
    .select({
      limitUsd: budgetState.limitUsd,
      remainingUsd: budgetState.remainingUsd,
      currency: budgetState.currency,
    })
    .from(budgetState)
    .where(eq(budgetState.org, org))
    .limit(1);
  const budgetRow = budgetRows[0];
  if (!budgetRow) {
    checks.push({
      id: 'budget',
      ok: false,
      summary:
        `No spending budget is configured for org "${org}", so every ` +
        'generation call will be refused with HTTP 402 "BudgetNotConfigured". ' +
        'This service refuses to spend money it was never given a ceiling for.',
      fix:
        `Ask an admin to call PUT /v1/budget/${org} with {"limitUsd": 25} ` +
        '(or POST /v1/tenant/provision), or run ' +
        `\`pnpm --filter @edc/ai-service set-budget -- --org ${org} --limit 25\` against the target environment.`,
      detail: { configured: false },
    });
  } else {
    const remaining = Number(budgetRow.remainingUsd);
    const limit = Number(budgetRow.limitUsd);
    const exhausted = remaining <= 0;
    checks.push({
      id: 'budget',
      ok: !exhausted,
      summary: exhausted
        ? `Org "${org}" has a budget of ${limit} ${budgetRow.currency} but has spent all of it. ` +
          'Generation calls will be refused with HTTP 402 "BudgetExceeded".'
        : `Org "${org}" has ${remaining} of ${limit} ${budgetRow.currency} left to spend.`,
      ...(exhausted
        ? {
            fix:
              `Ask an admin to raise or refill the cap: PUT /v1/budget/${org} ` +
              'with {"limitUsd": 25, "refill": true}.',
          }
        : {}),
      detail: {
        configured: true,
        limitUsd: limit,
        remainingUsd: remaining,
        currency: budgetRow.currency,
      },
    });
  }

  // 3. Registry.
  if (unitType) {
    const activeRows = await db
      .select({ version: registryEntries.version })
      .from(registryEntries)
      .where(
        and(
          eq(registryEntries.org, org),
          eq(registryEntries.project, project),
          eq(registryEntries.unitType, unitType),
          sql`${registryEntries.isActive}`,
        ),
      )
      .limit(1);
    const active = activeRows[0];
    checks.push({
      id: 'registry',
      ok: Boolean(active),
      summary: active
        ? `Unit type "${unitType}" has an active prompt registered (version ${active.version}).`
        : `Unit type "${unitType}" has no active prompt registered for ` +
          `project "${project}", so generating it will fail with ` +
          `"no active registry entry for unitType '${unitType}'".`,
      ...(active
        ? {}
        : {
            fix:
              `Ask an admin to register one: POST /v1/registry/unit-types/${unitType}/versions ` +
              'with {"version":"1","promptTemplate":"…","activate":true} — or POST /v1/tenant/provision.',
          }),
      detail: { unitType, activeVersion: active?.version ?? null },
    });
  } else {
    const summaries = await listUnitTypes(db, org, project);
    const active = summaries.filter((s) => s.activeVersion !== null);
    checks.push({
      id: 'registry',
      ok: active.length > 0,
      summary:
        active.length > 0
          ? `Project "${project}" has ${active.length} unit type(s) with an active prompt: ` +
            `${active.map((s) => s.unitType).join(', ')}.`
          : `Project "${project}" has no registered prompts at all, so any generate call ` +
            'that names a unitType will fail with "no active registry entry for unitType".',
      ...(active.length > 0
        ? {}
        : {
            fix:
              'Ask an admin to register one per unit type you generate: ' +
              'POST /v1/registry/unit-types/{unitType}/versions with ' +
              '{"version":"1","promptTemplate":"…","activate":true} — or POST /v1/tenant/provision.',
          }),
      detail: {
        activeUnitTypes: active.map((s) => s.unitType),
        allUnitTypes: summaries.map((s) => s.unitType),
      },
    });
    // Pass a `unitType` query param to turn this into a precise per-type check.
  }

  return {
    org,
    project,
    ready: checks.every((c) => c.ok),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionItemStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped'
  | 'failed';

export interface ProvisionItemResult {
  /** `budget` or `registry:<unitType>`. */
  item: string;
  status: ProvisionItemStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ProvisionUnitTypeInput extends RegistryEntryCreate {
  unitType: string;
  /** Make this version the active one. Defaults to true for provisioning. */
  activate?: boolean;
}

export interface ProvisionTenantInput {
  budget?: Omit<SetOrgBudgetInput, 'org'>;
  unitTypes?: ProvisionUnitTypeInput[];
}

export interface ProvisionTenantResult {
  org: string;
  project: string;
  items: ProvisionItemResult[];
  /** Steps a human still has to perform. Never empty — see the API-key note. */
  manualSteps: Array<{ item: string; message: string }>;
  /** Readiness measured AFTER the provisioning writes landed. */
  readiness: ReadinessReport;
}

const API_KEY_MANUAL_STEP = {
  item: 'api-key',
  message:
    'API keys cannot be provisioned over HTTP. They live in the API_KEYS environment ' +
    'variable, which ai-service parses once at boot. To add a consumer key you must (1) add ' +
    'an entry `{"<token>":{"org":"…","project":"…","role":"app","callbackSecret":"…"}}` to ' +
    'API_KEYS in the target environment, and (2) recreate the container so the new value is ' +
    'read. Until both happen the consumer gets HTTP 401 "Unknown API key" no matter what this ' +
    'endpoint reports.',
} as const;

/**
 * Provision the two things that CAN be provisioned over HTTP — the org's budget
 * and its registry entries — in one idempotent call, scoped to the caller's own
 * tenant.
 *
 * Idempotent: re-running with the same input reports `unchanged` for registry
 * versions that already exist (never an error), and re-applies the same budget
 * cap as a no-op. Partial failure is reported per item rather than aborting —
 * a bad prompt template for one unitType must not silently roll back the budget
 * that already landed.
 */
export async function provisionTenant(
  db: Db,
  ctx: TenantScope & { role: 'app' | 'admin'; actorKeyId: string },
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const { org, project, actorKeyId } = ctx;
  const items: ProvisionItemResult[] = [];

  // ── Budget ──
  if (input.budget) {
    try {
      const result = await setOrgBudget(db, { org, ...input.budget });
      items.push({
        item: 'budget',
        status: result.created ? 'created' : 'updated',
        message: result.created
          ? `Budget created for org "${org}": ${result.limitUsd} ${result.currency} cap, ` +
            `${result.remainingUsd} remaining. This org can now spend.`
          : `Budget updated for org "${org}": ${result.limitUsd} ${result.currency} cap, ` +
            `${result.remainingUsd} remaining.`,
        detail: {
          limitUsd: result.limitUsd,
          remainingUsd: result.remainingUsd,
          currency: result.currency,
        },
      });
    } catch (err) {
      items.push({
        item: 'budget',
        status: 'failed',
        message: `Could not set the budget: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    items.push({
      item: 'budget',
      status: 'skipped',
      message:
        'No `budget` supplied, so the org budget was left as-is. Without a budget every ' +
        'generation call is refused with HTTP 402 "BudgetNotConfigured".',
    });
  }

  // ── Registry entries ──
  for (const entry of input.unitTypes ?? []) {
    const { unitType, activate = true, ...payload } = entry;
    try {
      const created = await createVersion(db, org, project, unitType, payload, actorKeyId, {
        activate,
      });
      items.push({
        item: `registry:${unitType}`,
        status: 'created',
        message: activate
          ? `Registered version "${created.version}" for unit type "${unitType}" and made it active.`
          : `Registered version "${created.version}" for unit type "${unitType}" (not activated).`,
        detail: { unitType, version: created.version, isActive: created.isActive },
      });
    } catch (err) {
      if (err instanceof RegistryConflictError) {
        // Idempotency: this exact version is already registered. Report it as a
        // no-op rather than an error so re-running provisioning is safe.
        items.push({
          item: `registry:${unitType}`,
          status: 'unchanged',
          message:
            `Version "${payload.version}" of unit type "${unitType}" already exists — left ` +
            'untouched. Publish a new version number to change the prompt.',
          detail: { unitType, version: payload.version },
        });
        continue;
      }
      items.push({
        item: `registry:${unitType}`,
        status: 'failed',
        message: `Could not register unit type "${unitType}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        detail: { unitType },
      });
    }
  }

  const readiness = await getTenantReadiness(db, { org, project, role: ctx.role });

  return {
    org,
    project,
    items,
    manualSteps: [API_KEY_MANUAL_STEP],
    readiness,
  };
}
