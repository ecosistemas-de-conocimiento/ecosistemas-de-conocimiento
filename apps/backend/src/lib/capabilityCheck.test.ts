/**
 * Boot-time ai-service capability check (ADR-0004).
 *
 * Two properties matter here. First the asymmetry: a reachable ai-service that
 * lacks something chat requires must stop the boot, while one we merely
 * couldn't reach must not — a deploy blocked by a restarting dependency would
 * be a worse failure than the mis-promotion the check exists to catch. Second,
 * chat's requirement is CONDITIONAL: without a public callback URL there is
 * nothing to require, and the check must not spend a request finding that out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIClient } from '@edc/ai-client'

let fetchImpl: typeof fetch

vi.mock('./aiClient', () => ({
  getAppAIClient: () =>
    new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl }),
}))

const capabilityDoc = (capabilities: Record<string, boolean>) => () =>
  Promise.resolve(
    new Response(JSON.stringify({ capabilities }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

const load = async () => {
  const mod = await import('./capabilityCheck')
  mod._resetCapabilityCheckForTests()
  return mod
}

const logger = { warn: vi.fn(), info: vi.fn() }

beforeEach(() => {
  vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
  vi.stubEnv('AI_SERVICE_API_KEY', 'k')
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://chat.test')
  vi.stubEnv('AI_CAPABILITY_MODE', 'strict')
  logger.warn.mockReset()
  logger.info.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requiredAICapabilities', () => {
  it('requires the ingest callback when chat advertises a callback URL', async () => {
    const { requiredAICapabilities } = await load()
    expect(requiredAICapabilities()).toEqual(['orgDelegation', 'ingestChunkCallback'])
  })

  it('always requires org delegation — an older ai-service ignores X-AI-Org', async () => {
    vi.stubEnv('PUBLIC_BACKEND_URL', '')
    const { requiredAICapabilities } = await load()
    expect(requiredAICapabilities()).toEqual(['orgDelegation'])
  })
})

describe('checkAIServiceCapabilities', () => {
  it('passes when ai-service delivers ingest callbacks', async () => {
    fetchImpl = vi.fn(
      capabilityDoc({ ingestChunkCallback: true, orgDelegation: true }),
    ) as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).resolves.toBeUndefined()
  })

  it('refuses to boot when ai-service would ignore X-AI-Org — every ecosistema would share one org', async () => {
    vi.stubEnv('PUBLIC_BACKEND_URL', '')
    fetchImpl = vi.fn(capabilityDoc({ ingestChunkCallback: true })) as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).rejects.toThrow(/orgDelegation/)
  })

  it('refuses to boot when ai-service will not call back — documents would hang in `embedding`', async () => {
    fetchImpl = vi.fn(capabilityDoc({ orgDelegation: true })) as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).rejects.toThrow(/ingestChunkCallback/)
  })

  it('skips when ai-service is not configured — AI is optional', async () => {
    vi.stubEnv('AI_SERVICE_URL', '')
    const spy = vi.fn(capabilityDoc({}))
    fetchImpl = spy as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('never blocks the boot when ai-service is merely unreachable', async () => {
    fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).resolves.toBeUndefined()
    expect(logger.warn.mock.calls[0]?.[0]).toContain('could not reach')
  })

  it('warn mode logs and lets chat start', async () => {
    vi.stubEnv('AI_CAPABILITY_MODE', 'warn')
    fetchImpl = vi.fn(capabilityDoc({})) as unknown as typeof fetch

    const { checkAIServiceCapabilities } = await load()
    await expect(checkAIServiceCapabilities(logger)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
