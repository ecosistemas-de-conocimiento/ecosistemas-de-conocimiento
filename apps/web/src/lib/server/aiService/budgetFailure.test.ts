import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AIServiceError,
  BudgetExceededError,
  BudgetNotConfiguredError,
  httpStatusFor,
  isRequesterBudgetOwner,
  logBudgetFailure,
} from './errors';
import { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './messages';
import { generateSyncResponseSchema, generateResponseSchema } from './schemas';

/**
 * How a budget failure must reach a user.
 *
 * The upstream English text names the org and its budget state
 * ("Org example-org has exceeded its budget: requested $0.02, remaining
 * $0.00"). Before this suite that string was rendered verbatim into the chat
 * bubble. These tests pin the two things that stop it: the canonical Spanish
 * message on the way out, and the full cause on the way to the log.
 */

// A realistic upstream message — every assertion below checks this LEAKS NOWHERE.
const UPSTREAM_LEAK =
  'Org example-org has exceeded its budget: requested 0.021 USD, remaining 0.004 USD (shortfall 0.017 USD)';

const exceeded = () =>
  new BudgetExceededError(UPSTREAM_LEAK, {
    status: 402,
    bodyError: 'BudgetExceeded',
    org: 'example-org',
    requested: 0.021,
    remaining: 0.004,
    shortfallUsd: 0.017,
  });

const notConfigured = () =>
  new BudgetNotConfiguredError('No budget configured for org example-org', {
    status: 402,
    bodyError: 'BudgetNotConfigured',
    org: 'example-org',
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BudgetNotConfigured is its own error, not overspend', () => {
  it('does NOT collapse into BudgetExceededError', () => {
    const err = notConfigured();
    // The regression this guards: a bare-402 fallback used to label every 402
    // `BudgetExceededError`, sending operators to raise a cap that never existed.
    expect(err).toBeInstanceOf(BudgetNotConfiguredError);
    expect(err).not.toBeInstanceOf(BudgetExceededError);
    expect(err.name).toBe('BudgetNotConfiguredError');
  });

  it('maps to 503 + the canonical message + ai_unavailable', () => {
    expect(httpStatusFor(notConfigured())).toEqual({
      status: 503,
      message: AI_UNAVAILABLE_MESSAGE,
      code: AI_UNAVAILABLE_CODE,
    });
  });

  it('bypasses the ownership predicate — even a matching org gets the generic message', () => {
    // There are no amounts to leak, and a missing row is a deployment fault a
    // user can neither see nor fix. Ownership is irrelevant here by design.
    const mapped = httpStatusFor(notConfigured(), { requesterOrgKey: 'example-org' });
    expect(mapped.status).toBe(503);
    expect(mapped.message).toBe(AI_UNAVAILABLE_MESSAGE);
  });

  it('leaks no org name and no amounts', () => {
    const { message } = httpStatusFor(notConfigured());
    expect(message).not.toMatch(/example-org/);
    expect(message).not.toMatch(/budget/i);
    expect(message).not.toMatch(/\d/);
  });
});

describe('BudgetExceeded, non-owner (every chat user today)', () => {
  it('maps to 503 + the canonical message + ai_unavailable', () => {
    expect(httpStatusFor(exceeded(), { requesterOrgKey: null })).toEqual({
      status: 503,
      message: AI_UNAVAILABLE_MESSAGE,
      code: AI_UNAVAILABLE_CODE,
    });
  });

  it('leaks neither the org name nor any amount', () => {
    const { message } = httpStatusFor(exceeded(), { requesterOrgKey: null });
    expect(message).toBe(AI_UNAVAILABLE_MESSAGE);
    expect(message).not.toContain('example-org');
    expect(message).not.toContain('0.021');
    expect(message).not.toContain('0.004');
    expect(message).not.toContain('0.017');
    expect(message).not.toContain(UPSTREAM_LEAK);
  });

  it('defaults to non-owner when no requester key is supplied at all', () => {
    // The safe default matters: a caller that forgets the option must not
    // accidentally take the owner path.
    expect(httpStatusFor(exceeded()).message).toBe(AI_UNAVAILABLE_MESSAGE);
  });
});

describe('isRequesterBudgetOwner', () => {
  it('is true only when both sides are non-empty and equal', () => {
    expect(isRequesterBudgetOwner('example-org', 'example-org')).toBe(true);
  });

  it('is false for a different org', () => {
    expect(isRequesterBudgetOwner('example-org', 'otra-org')).toBe(false);
  });

  it('is false whenever either side is missing or empty', () => {
    // chat passes `null` for every user today (single-org, no per-user org key),
    // so this is the branch that actually runs in production.
    expect(isRequesterBudgetOwner('example-org', null)).toBe(false);
    expect(isRequesterBudgetOwner('example-org', undefined)).toBe(false);
    expect(isRequesterBudgetOwner('example-org', '')).toBe(false);
    expect(isRequesterBudgetOwner(null, 'example-org')).toBe(false);
    expect(isRequesterBudgetOwner(undefined, undefined)).toBe(false);
    expect(isRequesterBudgetOwner('', '')).toBe(false);
  });

  it('lets a verified owner see the real message (the documented flip point)', () => {
    const mapped = httpStatusFor(exceeded(), { requesterOrgKey: 'example-org' });
    expect(mapped.status).toBe(402);
    expect(mapped.message).toBe(UPSTREAM_LEAK);
    expect(mapped.code).toBeUndefined();
  });
});

describe('the real cause is logged server-side, in full', () => {
  it('logs NO BUDGET CONFIGURED for a missing budget row', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kind = logBudgetFailure(notConfigured(), 'generate:sync');

    expect(kind).toBe('not_configured');
    expect(spy).toHaveBeenCalledTimes(1);
    const [msg, fields] = spy.mock.calls[0]!;
    expect(msg).toContain(
      'ai-service budget failure: NO BUDGET CONFIGURED for org — provision a budget row',
    );
    expect(fields).toMatchObject({
      budgetFailure: 'not_configured',
      org: 'example-org',
      surface: 'generate:sync',
    });
    // The error's type, not its text (P-07): the fields above carry the detail.
    expect((fields as { err: unknown }).err).toBe('BudgetNotConfiguredError');
  });

  it('logs BUDGET EXHAUSTED, with the amounts, for an exhausted cap', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kind = logBudgetFailure(exceeded(), 'generate:stream');

    expect(kind).toBe('exceeded');
    expect(spy).toHaveBeenCalledTimes(1);
    const [msg, fields] = spy.mock.calls[0]!;
    expect(msg).toContain(
      'ai-service budget failure: BUDGET EXHAUSTED for org — top up the cap',
    );
    // The operator gets exactly what the user is denied.
    expect(fields).toMatchObject({
      budgetFailure: 'exceeded',
      org: 'example-org',
      requestedUsd: 0.021,
      remainingUsd: 0.004,
      shortfallUsd: 0.017,
      surface: 'generate:stream',
    });
  });

  it('the two log messages are distinguishable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logBudgetFailure(notConfigured(), 's');
    logBudgetFailure(exceeded(), 's');

    const [first, second] = spy.mock.calls.map((c) => String(c[0]));
    expect(first).not.toBe(second);
    expect(first).toContain('NO BUDGET CONFIGURED');
    expect(first).not.toContain('EXHAUSTED');
    expect(second).toContain('BUDGET EXHAUSTED');
    expect(second).not.toContain('NO BUDGET CONFIGURED');
  });

  it('stays silent for a non-budget error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(logBudgetFailure(new AIServiceError('kaboom'), 's')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('warnings survive the response schemas', () => {
  it('generateSyncResponseSchema keeps BUDGET_SOFT_CAP', () => {
    // The regression: zod v4 strips unknown keys from a bare `z.object`, so an
    // undeclared `warnings` was deleted at the parse boundary and the run-up to
    // an outage was invisible.
    const parsed = generateSyncResponseSchema.parse({
      text: 'hola',
      warnings: [{ code: 'BUDGET_SOFT_CAP', message: 'Budget is below 10% remaining' }],
    });
    expect(parsed.warnings).toEqual([
      { code: 'BUDGET_SOFT_CAP', message: 'Budget is below 10% remaining' },
    ]);
  });

  it('generateResponseSchema keeps them too', () => {
    const parsed = generateResponseSchema.parse({
      requestId: 'r1',
      channel: 'c1',
      totalJobs: 1,
      estimatedCostUsd: 0.01,
      warnings: [{ code: 'BUDGET_SOFT_CAP', message: 'low' }],
    });
    expect(parsed.warnings).toHaveLength(1);
  });

  it('tolerates an unknown future warning code', () => {
    const parsed = generateSyncResponseSchema.parse({
      text: 'hola',
      warnings: [{ code: 'SOME_FUTURE_CODE', message: 'x' }],
    });
    expect(parsed.warnings?.[0]?.code).toBe('SOME_FUTURE_CODE');
  });

  it('stays optional — a response with no warnings still parses', () => {
    expect(generateSyncResponseSchema.parse({ text: 'hola' }).warnings).toBeUndefined();
  });
});
