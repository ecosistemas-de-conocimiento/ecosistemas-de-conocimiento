import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetAIClientsForTests } from './aiClient'
import { ecosystemBudgetUsd, ensureEcosystemBudgets, provisionEcosystemOrg } from './provisionEcosystem'

const logger = { info: vi.fn(), warn: vi.fn() }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  _resetAIClientsForTests()
})

describe('provisionEcosystemOrg', () => {
  beforeEach(() => {
    logger.info.mockReset()
    logger.warn.mockReset()
  })

  it('POSTs /v1/tenant/provision with the ecosistema header, on the admin key', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'admin-key')
    const seen: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), init })
        return new Response(JSON.stringify({ org: 'edc-eco-7', items: [], manualSteps: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    await expect(provisionEcosystemOrg(7, { logger })).resolves.toBe('provisioned')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://ai.test/v1/tenant/provision')
    expect(seen[0]!.init.method).toBe('POST')
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers['X-AI-Org']).toBe('eco-7')
    expect(headers.Authorization).toBe('Bearer admin-key')
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ budget: { limitUsd: 5 } })
  })

  it('never throws when ai-service answers an error', async () => {
    const provision = vi.fn(async () => {
      throw new Error('503')
    })
    await expect(
      provisionEcosystemOrg(7, { logger, client: async () => ({ tenant: { provision } }) }),
    ).resolves.toBe('failed')
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('skips quietly when ai-service is not configured', async () => {
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', '')
    await expect(provisionEcosystemOrg(7, { logger })).resolves.toBe('skipped')
  })
})

describe('ecosystemBudgetUsd', () => {
  it('defaults to 5 and reads AI_ECOSYSTEM_BUDGET_USD', () => {
    vi.stubEnv('AI_ECOSYSTEM_BUDGET_USD', '')
    expect(ecosystemBudgetUsd()).toBe(5)
    vi.stubEnv('AI_ECOSYSTEM_BUDGET_USD', '12.5')
    expect(ecosystemBudgetUsd()).toBe(12.5)
    vi.stubEnv('AI_ECOSYSTEM_BUDGET_USD', 'nope')
    expect(ecosystemBudgetUsd()).toBe(5)
  })
})

describe('ensureEcosystemBudgets — the boot pass', () => {
  /** ai-service at the fetch boundary: which orgs already have a budget row. */
  const withBudget = new Set<string>()
  const seen: Array<{ method: string; path: string; org: string }> = []
  const readinessFails = new Set<string>()

  beforeEach(() => {
    logger.info.mockReset()
    logger.warn.mockReset()
    withBudget.clear()
    readinessFails.clear()
    seen.length = 0
    vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'admin-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const org = (init.headers as Record<string, string>)['X-AI-Org']!
        const path = new URL(String(url)).pathname
        const method = init.method ?? 'GET'
        seen.push({ method, path, org })
        if (path === '/v1/tenant/readiness') {
          if (readinessFails.has(org)) return new Response('boom', { status: 503 })
          const configured = withBudget.has(org)
          return Response.json({
            org: `edc-${org}`,
            project: 'edc',
            ready: configured,
            checks: [
              {
                id: 'budget',
                ok: configured,
                summary: '',
                detail: configured
                  ? { configured: true, limitUsd: 40, remainingUsd: 12, currency: 'USD' }
                  : { configured: false },
              },
            ],
          })
        }
        if (path === '/v1/tenant/provision') {
          withBudget.add(org)
          return Response.json({ org: `edc-${org}`, project: 'edc', items: [], manualSteps: [] })
        }
        return new Response('not stubbed', { status: 599 })
      }),
    )
  })

  const payloadWith = (ids: number[]) => ({
    find: vi.fn(async () => ({ docs: ids.map((id) => ({ id })) })),
  })

  it('🔴 provisions only the ecosistemas with NO budget row, and never re-sets an existing cap', async () => {
    // Re-provisioning an org that has a budget re-applies `limitUsd` and would
    // overwrite a cap an operator raised (ai-service `budget/provision.ts`).
    withBudget.add('eco-1')
    const result = await ensureEcosystemBudgets(payloadWith([1, 2]), { logger })

    expect(result).toEqual({ checked: 2, provisioned: 1, alreadyConfigured: 1, failed: 0, skipped: 0 })
    const provisions = seen.filter((c) => c.path === '/v1/tenant/provision')
    expect(provisions).toEqual([{ method: 'POST', path: '/v1/tenant/provision', org: 'eco-2' }])
  })

  it('is idempotent: a second boot provisions nothing', async () => {
    const payload = payloadWith([1, 2])
    await ensureEcosystemBudgets(payload, { logger })
    seen.length = 0
    const again = await ensureEcosystemBudgets(payload, { logger })
    expect(again.provisioned).toBe(0)
    expect(seen.filter((c) => c.path === '/v1/tenant/provision')).toHaveLength(0)
  })

  it('one ecosistema ai-service cannot answer for does not stop the others', async () => {
    readinessFails.add('eco-1')
    const result = await ensureEcosystemBudgets(payloadWith([1, 2]), { logger })
    expect(result).toMatchObject({ checked: 1, provisioned: 1, failed: 1 })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips every ecosistema when ai-service is not configured, and never throws', async () => {
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', '')
    const result = await ensureEcosystemBudgets(payloadWith([1, 2]), { logger })
    expect(result).toMatchObject({ checked: 0, skipped: 2 })
    expect(seen).toHaveLength(0)
  })

  it('never throws when the organizations cannot be listed', async () => {
    const payload = { find: vi.fn(async () => { throw new Error('db down') }) }
    await expect(ensureEcosystemBudgets(payload, { logger })).resolves.toMatchObject({ checked: 0 })
  })
})
