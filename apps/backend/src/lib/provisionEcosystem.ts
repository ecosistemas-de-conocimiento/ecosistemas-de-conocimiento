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

/** The slice of `@edc/ai-client` the boot pass uses: readiness, then provision. */
export interface TenantReadinessReader extends TenantProvisioner {
  tenant: TenantProvisioner['tenant'] & {
    readiness(): Promise<{
      checks?: Array<{ id?: string; detail?: Record<string, unknown> }>
    }>
  }
}

export interface EnsureBudgetsResult {
  /** Ecosistemas ai-service answered a readiness read for. */
  checked: number
  provisioned: number
  alreadyConfigured: number
  /** Readiness or provision failed; the next boot tries again. */
  failed: number
  /** ai-service not configured in this process. */
  skipped: number
}

/**
 * 🔴 THE BOOT PASS. Every ecosistema gets a budget row if it has none.
 *
 * The create hook in `collections/Organizations.ts` provisions once,
 * fire-and-forget, and a failure there is only a log line — after which every
 * chat in that ecosistema gets HTTP 402 `BudgetNotConfigured` from ai-service
 * with nothing to fix it. This runs at every backend boot and closes that gap.
 *
 * ⚠ IT READS READINESS FIRST AND PROVISIONS ONLY `configured: false`. Calling
 * provision on an org that already has a budget is not a no-op: ai-service
 * re-applies `limitUsd` (`services/ai-service/src/services/budget/provision.ts`,
 * "UPDATE: limit := cap"), which would reset a cap an operator raised back to
 * {@link ecosystemBudgetUsd} on every deploy.
 *
 * ⚠ Sequential: one readiness GET per ecosistema against a `/v1` bucket shared
 * by every consumer. NEVER THROWS — gating boot on ai-service would crash-loop
 * the admin panel you would use to fix it.
 */
export async function ensureEcosystemBudgets(
  payload: { find(args: Record<string, unknown>): Promise<unknown> },
  deps: {
    logger: Logger
    /** Test seam. Default: the admin client of that ecosistema's org. */
    client?: (organizationId: number | string) => Promise<TenantReadinessReader>
  },
): Promise<EnsureBudgetsResult> {
  const result: EnsureBudgetsResult = {
    checked: 0,
    provisioned: 0,
    alreadyConfigured: 0,
    failed: 0,
    skipped: 0,
  }

  let ids: Array<number | string>
  try {
    const page = (await payload.find({
      collection: 'organizations',
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })) as { docs?: Array<{ id?: number | string }> }
    ids = (page?.docs ?? []).map((d) => d.id).filter((id): id is number | string => id != null)
  } catch (err) {
    deps.logger.warn({ err: String(err) }, '[ecosistema] could not list ecosistemas to check their budgets')
    return result
  }

  for (const [index, id] of ids.entries()) {
    let client: TenantReadinessReader
    try {
      client = deps.client
        ? await deps.client(id)
        : ((await import('@/lib/aiClient')).getAdminAIClient(id) as unknown as TenantReadinessReader)
    } catch {
      // No admin key: every remaining ecosistema would say the same.
      result.skipped = ids.length - index
      deps.logger.warn({}, '[ecosistema] ai-service not configured; ecosistema budgets were NOT checked.')
      return result
    }

    let configured: unknown
    try {
      const report = await client.tenant.readiness()
      configured = report.checks?.find((c) => c.id === 'budget')?.detail?.configured
    } catch (err) {
      result.failed += 1
      deps.logger.warn(
        { organizationId: String(id), err: String(err) },
        '[ecosistema] could not read its ai-service readiness; its budget was not checked.',
      )
      continue
    }
    result.checked += 1

    if (configured !== false) {
      result.alreadyConfigured += 1
      continue
    }
    const outcome = await provisionEcosystemOrg(id, { logger: deps.logger, client: async () => client })
    if (outcome === 'provisioned') result.provisioned += 1
    else result.failed += 1
  }

  if (result.provisioned > 0 || result.failed > 0) {
    deps.logger.info({ ...result }, '[ecosistema] boot budget check finished')
  }
  return result
}
