import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetAIClientsForTests } from './aiClient'
import { ecosystemBudgetUsd, provisionEcosystemOrg } from './provisionEcosystem'

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
