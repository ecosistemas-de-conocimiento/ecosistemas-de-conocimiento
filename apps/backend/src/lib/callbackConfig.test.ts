/**
 * The property under test is NOT "does the URL string get built correctly".
 * It is: a half-configured environment must be LOUD, and it must still boot.
 *
 * chat has no `AI_SERVICE_CALLBACK_ENABLED` switch, so there is no "off" state
 * an operator chose. Every incomplete config is an accident, and the accident is
 * invisible at runtime — documents are enqueued, ai-service embeds them, and the
 * row sits at `embedding` forever because nothing calls back and chat never
 * polls. The boot log is the only place that failure can surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CALLBACK_BASE_URL_VAR,
  CALLBACK_PATH,
  CALLBACK_SECRET_VAR,
  callbackBaseUrlIsValid,
  callbacksFullyConfigured,
  checkCallbackConfig,
  ingestCallbackUrl,
  missingCallbackConfig,
} from './callbackConfig'

const SECRET = 'a'.repeat(64)

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }

beforeEach(() => {
  logger.error.mockReset()
  logger.warn.mockReset()
  logger.info.mockReset()
  vi.stubEnv(CALLBACK_SECRET_VAR, SECRET)
  vi.stubEnv(CALLBACK_BASE_URL_VAR, 'https://chat.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ingestCallbackUrl', () => {
  it('builds the receiver URL when secret + base URL are both present', () => {
    expect(ingestCallbackUrl()).toBe(`https://chat.test${CALLBACK_PATH}`)
    expect(callbacksFullyConfigured()).toBe(true)
    expect(missingCallbackConfig()).toEqual([])
  })

  it('strips trailing slashes so the path is never doubled', () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, 'https://chat.test///')
    expect(ingestCallbackUrl()).toBe(`https://chat.test${CALLBACK_PATH}`)
  })

  it('returns null with no base URL — nothing to be called back on', () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    expect(ingestCallbackUrl()).toBeNull()
    expect(missingCallbackConfig()).toEqual([CALLBACK_BASE_URL_VAR])
  })

  it('returns null with no secret — a callback we cannot verify is worse than none', () => {
    // Without the secret every inbound POST 401s, so ai-service burns its whole
    // retry schedule and the row is stuck either way. Don't advertise the URL.
    vi.stubEnv(CALLBACK_SECRET_VAR, '')
    expect(ingestCallbackUrl()).toBeNull()
    expect(missingCallbackConfig()).toEqual([CALLBACK_SECRET_VAR])
  })

  it('treats a whitespace-only secret as absent', () => {
    vi.stubEnv(CALLBACK_SECRET_VAR, '   ')
    expect(ingestCallbackUrl()).toBeNull()
  })

  // ⚠ ai-service validates `callbackUrl` with `z.string().url()`. A malformed
  // value is a 400 on the INGEST call, which kills ingestion outright — a much
  // worse outcome than losing the callback. So malformed must degrade to "no
  // callback", never propagate.
  it.each([
    ['bare host', 'chat.test'],
    ['no scheme, leading slashes', '//chat.test'],
    ['relative path', '/api'],
    ['wrong scheme', 'ftp://chat.test'],
    ['placeholder', 'unset'],
    ['scheme only', 'https://'],
  ])('degrades to no-callback on a malformed base URL (%s)', (_label, value) => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, value)
    expect(callbackBaseUrlIsValid()).toBe(false)
    expect(ingestCallbackUrl()).toBeNull()
  })

  it('names a malformed base URL distinctly from an unset one', () => {
    // An operator chasing "missing PUBLIC_BACKEND_URL" when the var is in
    // fact set to garbage will check the dashboard, see a value, and move on.
    vi.stubEnv(CALLBACK_BASE_URL_VAR, 'chat.test')
    expect(missingCallbackConfig()).toEqual([
      `${CALLBACK_BASE_URL_VAR} (set, but not an absolute http(s):// URL)`,
    ])
  })

  it('accepts http:// for local/compose origins', () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, 'http://backend:3002')
    expect(ingestCallbackUrl()).toBe(`http://backend:3002${CALLBACK_PATH}`)
  })
})

describe('checkCallbackConfig on a deployed env (NODE_ENV=production)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
  })

  it('logs ERROR naming the missing var, and does NOT throw', () => {
    // The no-throw half is the load-bearing half. Gating boot on this would
    // crash-loop every replica over a problem that leaves login, chat and
    // markdown documents entirely functional.
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')

    expect(() => checkCallbackConfig(logger)).not.toThrow()

    expect(logger.error).toHaveBeenCalledOnce()
    const msg = logger.error.mock.calls[0]![0] as string
    expect(msg).toContain(CALLBACK_BASE_URL_VAR)
    expect(msg).toMatch(/embedding/)
  })

  it('names BOTH vars when both are missing', () => {
    vi.stubEnv(CALLBACK_SECRET_VAR, '')
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')

    checkCallbackConfig(logger)

    const msg = logger.error.mock.calls[0]![0] as string
    expect(msg).toContain(CALLBACK_SECRET_VAR)
    expect(msg).toContain(CALLBACK_BASE_URL_VAR)
  })

  it('errors on a malformed base URL too — ingestion silently loses its callback', () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, 'chat.test')
    checkCallbackConfig(logger)
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('NEVER logs the secret value', () => {
    // The error line is written for an operator to paste into a ticket.
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    checkCallbackConfig(logger)
    const everything = [
      ...logger.error.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.info.mock.calls,
    ]
      .flat()
      .join(' ')
    expect(everything).not.toContain(SECRET)
  })

  it('stays quiet (info only) when fully configured', () => {
    checkCallbackConfig(logger)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledOnce()
  })
})

describe('checkCallbackConfig below production', () => {
  it('warns rather than errors — a local dev with no public origin is normal', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')

    expect(() => checkCallbackConfig(logger)).not.toThrow()

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.warn.mock.calls[0]![0]).toContain(CALLBACK_BASE_URL_VAR)
  })

  it('uses NODE_ENV === "production" as the deployed signal, matching capabilityModeFromEnv', () => {
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    vi.stubEnv('NODE_ENV', 'test')
    checkCallbackConfig(logger)
    expect(logger.error).not.toHaveBeenCalled()

    logger.error.mockReset()
    logger.warn.mockReset()
    vi.stubEnv('NODE_ENV', 'production')
    checkCallbackConfig(logger)
    expect(logger.error).toHaveBeenCalledOnce()
  })
})
