/**
 * Two properties carry the weight here.
 *
 * First, the two budget failures must stay APART. `BudgetNotConfigured` and
 * `BudgetExceeded` look alike on the wire (both 402) but mean opposite operator
 * actions — create a budget row vs top up an existing one. A collapse would send
 * whoever is on call to fix the wrong thing, so it is asserted explicitly.
 *
 * Second, amounts must NOT leak. The failing budget can belong to an org the
 * requester has nothing to do with; showing them its numbers is a disclosure
 * bug, not a nicety. The default (unknown requester) must be the closed one.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  AI_UNAVAILABLE_CODE,
  AI_UNAVAILABLE_MESSAGE,
  AI_UNAVAILABLE_STATUS,
  BUDGET_EXCEEDED_LOG,
  BUDGET_NOT_CONFIGURED_LOG,
  aiUnavailableBody,
  classifyAIBudgetFailure,
  isRequesterBudgetOwner,
  logAIBudgetFailure,
  logAIWarnings,
} from './aiBudgetFailure'

/** Shape `@edc/ai-client` throws: message + HTTP status + raw body. */
const aiError = (status: number, body: Record<string, unknown>): Error => {
  const err = new Error(String(body.message ?? 'ai-service request failed')) as Error & {
    status: number
    body: Record<string, unknown>
  }
  err.status = status
  err.body = body
  return err
}

const notConfigured = () =>
  aiError(402, {
    error: 'BudgetNotConfigured',
    org: 'acme.example',
    message: 'No budget configured for org acme.example',
  })

const exceeded = () =>
  aiError(402, {
    error: 'BudgetExceeded',
    org: 'acme.example',
    requested: 0.42,
    remaining: 0.1,
    shortfallUsd: 0.32,
    message: 'Budget exceeded for org acme.example',
  })

const makeLogger = () => ({ error: vi.fn(), warn: vi.fn() })

describe('canonical wording', () => {
  it('is the exact canonical sentence, byte for byte', () => {
    // One sentence, one place. If this ever
    // needs to change, it changes in all four at once — that is the whole point
    // of pinning it in a test.
    expect(AI_UNAVAILABLE_MESSAGE).toBe(
      'El servicio de IA no está disponible. Contacta a la persona que administra el sistema.',
    )
  })

  it('answers 503 with the ai_unavailable code and no Retry-After hint', () => {
    // 402 would blame the user for an operator's billing problem; a Retry-After
    // we cannot honestly compute would just make clients hammer the service.
    expect(AI_UNAVAILABLE_STATUS).toBe(503)
    expect(AI_UNAVAILABLE_CODE).toBe('ai_unavailable')
  })
})

describe('classifyAIBudgetFailure', () => {
  it('decodes BudgetNotConfigured without inventing amounts', () => {
    expect(classifyAIBudgetFailure(notConfigured())).toEqual({
      kind: 'not_configured',
      org: 'acme.example',
    })
  })

  it('decodes BudgetExceeded with every amount from the wire', () => {
    expect(classifyAIBudgetFailure(exceeded())).toEqual({
      kind: 'exceeded',
      org: 'acme.example',
      requestedUsd: 0.42,
      remainingUsd: 0.1,
      shortfallUsd: 0.32,
    })
  })

  it('🔴 never collapses BudgetNotConfigured into BudgetExceeded', () => {
    // The regression this whole module exists to prevent.
    expect(classifyAIBudgetFailure(notConfigured())?.kind).toBe('not_configured')
    expect(classifyAIBudgetFailure(exceeded())?.kind).toBe('exceeded')
  })

  it('reads amounts off the error instance when the body omits them', () => {
    // `BudgetExceededError` copies org/requested/remaining/shortfallUsd onto the
    // instance; a rethrow can arrive with a thin body.
    const err = Object.assign(new Error('budget'), {
      status: 402,
      body: { error: 'BudgetExceeded' },
      org: 'otra.example',
      requested: 2,
      remaining: 0,
      shortfallUsd: 2,
    })
    expect(classifyAIBudgetFailure(err)).toEqual({
      kind: 'exceeded',
      org: 'otra.example',
      requestedUsd: 2,
      remainingUsd: 0,
      shortfallUsd: 2,
    })
  })

  it('classifies on the discriminator alone when no status survived the rethrow', () => {
    expect(classifyAIBudgetFailure({ body: { error: 'BudgetNotConfigured', org: 'x' } })).toEqual({
      kind: 'not_configured',
      org: 'x',
    })
  })

  it('returns null for non-budget errors so the caller keeps its own catch-all', () => {
    expect(classifyAIBudgetFailure(aiError(404, { error: 'CorpusNotFound' }))).toBeNull()
    expect(classifyAIBudgetFailure(aiError(500, { message: 'boom' }))).toBeNull()
    expect(classifyAIBudgetFailure(new Error('network down'))).toBeNull()
    expect(classifyAIBudgetFailure(undefined)).toBeNull()
    expect(classifyAIBudgetFailure('BudgetExceeded')).toBeNull()
  })

  it('refuses to guess a 402 whose discriminator it does not know', () => {
    // Guessing would name a cause the operator then chases for nothing.
    expect(classifyAIBudgetFailure(aiError(402, { error: 'SomethingNew', org: 'a' }))).toBeNull()
  })

  it('ignores a stray budget discriminator on a non-402 error', () => {
    expect(classifyAIBudgetFailure(aiError(400, { error: 'BudgetExceeded' }))).toBeNull()
  })
})

describe('isRequesterBudgetOwner', () => {
  it('is true only when both keys are present and equal', () => {
    expect(isRequesterBudgetOwner('acme.example', 'acme.example')).toBe(true)
    expect(isRequesterBudgetOwner(' acme.example ', 'acme.example')).toBe(true)
  })

  it('🔴 is false for an unknown requester — absence is not permission', () => {
    // this backend passes null today (see the note on isRequesterBudgetOwner), so
    // is the branch that actually runs in production.
    expect(isRequesterBudgetOwner('acme.example', null)).toBe(false)
    expect(isRequesterBudgetOwner('acme.example', undefined)).toBe(false)
    expect(isRequesterBudgetOwner('acme.example', '')).toBe(false)
    expect(isRequesterBudgetOwner('acme.example', '   ')).toBe(false)
  })

  it('is false across different orgs, and when the failure names no org', () => {
    expect(isRequesterBudgetOwner('otra.example', 'acme.example')).toBe(false)
    expect(isRequesterBudgetOwner('', 'acme.example')).toBe(false)
    expect(isRequesterBudgetOwner(null, null)).toBe(false)
  })
})

describe('aiUnavailableBody', () => {
  it('🔴 hides amounts, limits and org from a requester who does not own the budget', () => {
    const body = aiUnavailableBody(classifyAIBudgetFailure(exceeded()), null)
    expect(body).toEqual({
      ok: false,
      code: 'ai_unavailable',
      message: AI_UNAVAILABLE_MESSAGE,
    })
    // Belt and braces: no number or org name anywhere in the serialised body.
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('acme.example')
    expect(wire).not.toContain('0.32')
  })

  it('shows the diagnostics only to the org that owns the failing budget', () => {
    const body = aiUnavailableBody(classifyAIBudgetFailure(exceeded()), 'acme.example')
    expect(body.budget).toEqual({
      kind: 'exceeded',
      org: 'acme.example',
      requestedUsd: 0.42,
      remainingUsd: 0.1,
      shortfallUsd: 0.32,
    })
  })

  it('keeps the user-facing sentence canonical even for the budget owner', () => {
    // Ownership adds a diagnostics field; it never rewrites the message.
    const owner = aiUnavailableBody(classifyAIBudgetFailure(exceeded()), 'acme.example')
    const stranger = aiUnavailableBody(classifyAIBudgetFailure(exceeded()), null)
    expect(owner.message).toBe(AI_UNAVAILABLE_MESSAGE)
    expect(stranger.message).toBe(AI_UNAVAILABLE_MESSAGE)
  })

  it('still answers the canonical body when the cause could not be decoded', () => {
    expect(aiUnavailableBody(null, 'acme.example')).toEqual({
      ok: false,
      code: 'ai_unavailable',
      message: AI_UNAVAILABLE_MESSAGE,
    })
  })
})

describe('logAIBudgetFailure', () => {
  it('🔴 logs two distinguishable causes, so on-call fixes the right thing', () => {
    const logger = makeLogger()
    logAIBudgetFailure(notConfigured(), 'tabular_query', logger)
    logAIBudgetFailure(exceeded(), 'tabular_query', logger)

    expect(logger.error.mock.calls[0][0]).toBe(BUDGET_NOT_CONFIGURED_LOG)
    expect(logger.error.mock.calls[1][0]).toBe(BUDGET_EXCEEDED_LOG)
    expect(BUDGET_NOT_CONFIGURED_LOG).not.toBe(BUDGET_EXCEEDED_LOG)
  })

  it('logs the real cause IN FULL — the err object, the org and every amount', () => {
    const logger = makeLogger()
    const err = exceeded()
    const failure = logAIBudgetFailure(err, 'tabular_query', logger)

    expect(failure?.kind).toBe('exceeded')
    expect(logger.error).toHaveBeenCalledWith(BUDGET_EXCEEDED_LOG, {
      err,
      budgetFailure: 'exceeded',
      org: 'acme.example',
      surface: 'tabular_query',
      requestedUsd: 0.42,
      remainingUsd: 0.1,
      shortfallUsd: 0.32,
    })
  })

  it('omits amounts a not-configured failure genuinely does not have', () => {
    const logger = makeLogger()
    const err = notConfigured()
    logAIBudgetFailure(err, 'tabular_query', logger)

    expect(logger.error).toHaveBeenCalledWith(BUDGET_NOT_CONFIGURED_LOG, {
      err,
      budgetFailure: 'not_configured',
      org: 'acme.example',
      surface: 'tabular_query',
    })
  })

  it('stays silent and returns null for a non-budget error', () => {
    const logger = makeLogger()
    expect(logAIBudgetFailure(new Error('socket hang up'), 'tabular_query', logger)).toBeNull()
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('logAIWarnings', () => {
  it('logs each advisory once at warn with its code, message and surface', () => {
    const logger = makeLogger()
    logAIWarnings(
      [{ code: 'BUDGET_SOFT_CAP', message: '80% of the monthly cap is spent' }],
      'tabular_query',
      logger,
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('ai-service warning', {
      aiWarningCode: 'BUDGET_SOFT_CAP',
      aiWarningMessage: '80% of the monthly cap is spent',
      surface: 'tabular_query',
    })
  })

  it('tolerates absent, empty and malformed warning lists', () => {
    const logger = makeLogger()
    logAIWarnings(undefined, 'tabular_query', logger)
    logAIWarnings(null, 'tabular_query', logger)
    logAIWarnings([], 'tabular_query', logger)
    logAIWarnings([{ code: '', message: 'no code' }] as never, 'tabular_query', logger)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
