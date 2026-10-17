/**
 * One ecosistema's ai-service budget, for the admin "Uso del chat" panel
 * (audit C-6). `GET /v1/budget/:org` through the ECOSISTEMA's client.
 *
 * ⚠ TWO ORG NAMES, AND BOTH MUST BE RIGHT. The client sends `X-AI-Org:
 * eco-<id>`; the backend's key has `delegateOrgPrefix: "edc-"`, so ai-service
 * acts as `edc-eco-<id>` (quoted: `apps/backend/src/lib/aiClient.ts`,
 * `aiOrgSuffix`). The budget route answers 403 unless the PATH names that same
 * effective org, so the path carries the prefix and the header does not. A
 * wrong prefix shows as "no pudimos leer el presupuesto", never as wrong numbers.
 *
 * `spentUsd` is ai-service's own sum over every call the org paid for —
 * answers, condense, query expansion, embeddings — so it is the complete
 * figure the per-message cost in the panel is not.
 */

import { aiOrgFor, getAIClient, type AIServiceClient, type BudgetResponse } from '$lib/server/aiService';
import type { BudgetView } from '$lib/components/admin/summary';

/** ai-service's `delegateOrgPrefix` for EDC's key. Quoted, not read from config. */
export const AI_ORG_PREFIX = 'edc-';

/** The effective ai-service org for an ecosistema: `edc-eco-<id>`. */
export function budgetOrgFor(organizationId: number | string): string {
  return `${AI_ORG_PREFIX}${aiOrgFor(organizationId)}`;
}

export type EcosystemBudget = BudgetView;

/** Never throws: a failed read is `{ ok: false }`, logged once. */
export async function fetchEcosystemBudget(
  organizationId: number | string,
  client?: Pick<AIServiceClient, 'getBudget'>,
): Promise<EcosystemBudget> {
  try {
    const c = client ?? getAIClient(organizationId);
    const b: BudgetResponse = await c.getBudget(budgetOrgFor(organizationId));
    return {
      ok: true,
      limitUsd: b.limitUsd,
      spentUsd: b.spentUsd,
      remainingUsd: b.remainingUsd,
      currency: b.currency,
    };
  } catch (err) {
    console.warn(
      `[budget] could not read the budget for ecosistema ${organizationId} ` +
        `(${(err as Error)?.name ?? 'Error'}).`,
    );
    return { ok: false };
  }
}
