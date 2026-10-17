/**
 * Give a new ecosistema its own ai-service org.
 *
 * Every ecosistema is ai-service org `edc-eco-<id>` (see `lib/aiClient.ts`).
 * ai-service refuses every generation for an org with no budget row (HTTP 402
 * `BudgetNotConfigured`), so a new ecosistema needs one before its first chat.
 * `POST /v1/tenant/provision`, sent with that org's `X-AI-Org` header, creates
 * it. The call is idempotent, so a retry is safe.
 *
 * ⚠ ADMIN key: provisioning is an admin-only route.
 * ⚠ NEVER THROWS. Creating the ecosistema already succeeded; a failed
 *   provision is logged and an operator can re-run it
 *   (`pnpm --filter @edc/ai-service set-budget -- --org edc-eco-<id> --limit <usd>`).
 * ⚠ Only the budget is provisioned. Registry rows are not: chat sends its
 *   prompt inline unless `PROMPT_SOURCE=registry`, and with that setting each
 *   ecosistema org would need its own `chat` registry row.
 */

/**
 * Starting monthly cap for a new ecosistema, in USD.
 * Default 5: quoted from `infra/fleet/edc-1.md` §6, the cap set for the shared
 * `demo` org on dev and staging. An owner decision, not a measured need.
 */
export function ecosystemBudgetUsd(): number {
  const raw = process.env.AI_ECOSYSTEM_BUDGET_USD
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 5
}

/** The slice of `@edc/ai-client` this uses. */
export interface TenantProvisioner {
  tenant: {
    provision(req: { budget?: { limitUsd: number; refill?: boolean } }): Promise<unknown>
  }
}

type Logger = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

export async function provisionEcosystemOrg(
  organizationId: number | string,
  deps: {
    logger: Logger
    /** Test seam. Default: the admin client of this ecosistema's org. */
    client?: () => Promise<TenantProvisioner>
  },
): Promise<'provisioned' | 'skipped' | 'failed'> {
  let client: TenantProvisioner
  try {
    client = deps.client
      ? await deps.client()
      : ((await import('@/lib/aiClient')).getAdminAIClient(organizationId) as unknown as TenantProvisioner)
  } catch (err) {
    // No ai-service configured — a normal state for a bare local run.
    deps.logger.warn(
      { organizationId: String(organizationId), err: String(err) },
      '[ecosistema] ai-service not configured; its org was NOT provisioned.',
    )
    return 'skipped'
  }

  try {
    await client.tenant.provision({ budget: { limitUsd: ecosystemBudgetUsd() } })
    deps.logger.info(
      { organizationId: String(organizationId) },
      '[ecosistema] ai-service org provisioned.',
    )
    return 'provisioned'
  } catch (err) {
    deps.logger.warn(
      { organizationId: String(organizationId), err: String(err) },
      '[ecosistema] could not provision its ai-service org; its chat will get HTTP 402 until it is.',
    )
    return 'failed'
  }
}
