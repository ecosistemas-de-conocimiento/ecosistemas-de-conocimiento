/**
 * 🔴 The timeout, and why it has its own module.
 *
 * MEASURED 2026-08-28: one `deep` extraction window took 120 s. The shared
 * `getAppAIClient()` uses `@edc/ai-client`'s 30 s default, so extraction on that
 * client fails 100% of the time. These tests pin the number so a "tidy-up" that
 * folds this back into the shared client fails loudly instead of silently
 * emptying the graph.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { __resetGraphClientForTests, graphRequestTimeoutMs } from './client'

const original = process.env.GRAPH_EXTRACT_TIMEOUT_MS

afterEach(() => {
  if (original === undefined) delete process.env.GRAPH_EXTRACT_TIMEOUT_MS
  else process.env.GRAPH_EXTRACT_TIMEOUT_MS = original
  __resetGraphClientForTests()
})

describe('graphRequestTimeoutMs', () => {
  it('defaults well above ai-service’s own 120 s LLM wall-clock cap', () => {
    delete process.env.GRAPH_EXTRACT_TIMEOUT_MS
    // ⚠ Must exceed `LLM_REQUEST_TIMEOUT_MS` (ai-service default 120_000). If
    // the client aborts first, the server's answer — and the flags saying why
    // it failed — are never seen, and every failure looks like a network fault.
    expect(graphRequestTimeoutMs()).toBeGreaterThan(120_000)
  })

  it('is far above the shared client’s 30 s default', () => {
    delete process.env.GRAPH_EXTRACT_TIMEOUT_MS
    expect(graphRequestTimeoutMs()).toBeGreaterThan(30_000)
  })

  it('takes an override from the environment', () => {
    process.env.GRAPH_EXTRACT_TIMEOUT_MS = '240000'
    expect(graphRequestTimeoutMs()).toBe(240_000)
  })

  it('ignores a nonsense override rather than disabling the timeout', () => {
    for (const bad of ['', '   ', 'abc', '0', '-5']) {
      process.env.GRAPH_EXTRACT_TIMEOUT_MS = bad
      expect(graphRequestTimeoutMs()).toBe(660_000)
    }
  })

  it('🔴 stays ABOVE ai-service’s own generation cap', () => {
    // If the client aborts first, the server's answer — including the flags
    // that say WHY it failed — is never seen, and every failure looks like a
    // network fault. `infra/.env` sets LLM_REQUEST_TIMEOUT_MS=600000 so that
    // extraction can finish at all; 660 s leaves a minute for queueing and the
    // response trip, neither of which the server's generation clock counts.
    delete process.env.GRAPH_EXTRACT_TIMEOUT_MS
    expect(graphRequestTimeoutMs()).toBeGreaterThan(600_000)
  })
})
