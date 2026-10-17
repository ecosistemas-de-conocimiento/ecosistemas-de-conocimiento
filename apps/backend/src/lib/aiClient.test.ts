/**
 * One ai-service org per ecosistema.
 *
 * The client for an organization sends `X-AI-Org: eco-<id>`, so ai-service
 * (with `delegateOrgPrefix: "edc-"` on our key) books that ecosistema's budget,
 * usage and corpora under `edc-eco-<id>`. The base client sends no header and
 * stays in the key's own org — only for calls with no ecosistema in hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen: Array<{ url: string; headers: Record<string, string> }> = []

beforeEach(() => {
  seen.length = 0
  vi.stubEnv('AI_SERVICE_URL', 'http://ai.test/')
  vi.stubEnv('AI_SERVICE_API_KEY', 'app-key')
  vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'admin-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify({ capabilities: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const load = async () => {
  const mod = await import('./aiClient')
  mod._resetAIClientsForTests()
  return mod
}

describe('aiOrgSuffix', () => {
  it('is eco-<organizationId>, the same stem as the corpus names', async () => {
    const { aiOrgSuffix } = await load()
    expect(aiOrgSuffix(7)).toBe('eco-7')
    expect(aiOrgSuffix('42')).toBe('eco-42')
  })

  it('refuses an id that would not be a valid X-AI-Org suffix', async () => {
    const { aiOrgSuffix } = await load()
    expect(() => aiOrgSuffix('Eco_7')).toThrow(/organization id/)
    expect(() => aiOrgSuffix('')).toThrow(/organization id/)
  })
})

describe('getAppAIClient', () => {
  it('sends X-AI-Org for an organization', async () => {
    const { getAppAIClient } = await load()
    await getAppAIClient(7).capabilities.get()
    expect(seen[0]!.headers['X-AI-Org']).toBe('eco-7')
    expect(seen[0]!.headers.Authorization).toBe('Bearer app-key')
  })

  it('sends no header without an organization (the base client)', async () => {
    const { getAppAIClient } = await load()
    await getAppAIClient().capabilities.get()
    expect(seen[0]!.headers['X-AI-Org']).toBeUndefined()
  })

  it('keeps one client per org', async () => {
    const { getAppAIClient } = await load()
    expect(getAppAIClient(7)).toBe(getAppAIClient('7'))
    expect(getAppAIClient(7)).not.toBe(getAppAIClient(8))
    expect(getAppAIClient()).toBe(getAppAIClient())
    expect(getAppAIClient()).not.toBe(getAppAIClient(7))
  })

  it('refuses null rather than silently falling back to the shared org', async () => {
    const { getAppAIClient } = await load()
    expect(() => getAppAIClient(null as never)).toThrow(/organization/)
  })

  it('throws when the key is not set', async () => {
    vi.stubEnv('AI_SERVICE_API_KEY', '')
    const { getAppAIClient } = await load()
    expect(() => getAppAIClient(7)).toThrow(/AI_SERVICE_API_KEY/)
  })
})

describe('getAdminAIClient', () => {
  it('uses the admin key and the same per-org header', async () => {
    const { getAdminAIClient, getAppAIClient } = await load()
    await getAdminAIClient(7).capabilities.get()
    expect(seen[0]!.headers.Authorization).toBe('Bearer admin-key')
    expect(seen[0]!.headers['X-AI-Org']).toBe('eco-7')
    expect(getAdminAIClient(7)).not.toBe(getAppAIClient(7))
  })
})
