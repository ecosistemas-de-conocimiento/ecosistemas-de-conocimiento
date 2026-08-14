import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeStreamErrorFrame, logAIWarnings } from './streamErrors';
import { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './messages';

/**
 * The streaming transport is the one users actually hit — chat streams by
 * default. ai-service cannot set an HTTP status after the SSE headers are out,
 * so a budget rejection arrives as a terminal `error` FRAME. Before this suite
 * that frame was proxied to the browser verbatim.
 */

const UPSTREAM_LEAK =
  'Org example-org has exceeded its budget: requested 0.021 USD, remaining 0.004 USD';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('budget error frames are rewritten', () => {
  it('BudgetExceeded → canonical message + ai_unavailable + 503', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = sanitizeStreamErrorFrame({
      type: 'error',
      code: 'BudgetExceeded',
      org: 'example-org',
      message: UPSTREAM_LEAK,
    });

    expect(out).toEqual({
      type: 'error',
      code: AI_UNAVAILABLE_CODE,
      message: AI_UNAVAILABLE_MESSAGE,
      status: 503,
    });
  });

  it('BudgetNotConfigured → canonical message + ai_unavailable + 503', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = sanitizeStreamErrorFrame({
      type: 'error',
      code: 'BudgetNotConfigured',
      org: 'example-org',
      message: 'No budget configured for org example-org',
    });

    expect(out.status).toBe(503);
    expect(out.code).toBe(AI_UNAVAILABLE_CODE);
    expect(out.message).toBe(AI_UNAVAILABLE_MESSAGE);
  });

  it('leaks no org name, no amounts and none of the upstream text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = sanitizeStreamErrorFrame({
      type: 'error',
      code: 'BudgetExceeded',
      org: 'example-org',
      message: UPSTREAM_LEAK,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('example-org');
    expect(serialized).not.toContain('0.021');
    expect(serialized).not.toContain('0.004');
    expect(serialized).not.toContain('budget');
    expect(serialized).not.toContain('Budget');
  });

  it('drops every extra upstream field rather than spreading it through', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = sanitizeStreamErrorFrame({
      type: 'error',
      code: 'BudgetExceeded',
      org: 'example-org',
      message: UPSTREAM_LEAK,
      remaining: 0.004,
      shortfallUsd: 0.017,
      internalTrace: 'stack/frames/here',
    });

    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'status', 'type']);
    expect(out.remaining).toBeUndefined();
    expect(out.internalTrace).toBeUndefined();
  });

  it('logs the real cause once, with the distinguishing operator message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sanitizeStreamErrorFrame({
      type: 'error',
      code: 'BudgetNotConfigured',
      org: 'example-org',
      message: 'nope',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('NO BUDGET CONFIGURED');
    expect(spy.mock.calls[0]![1]).toMatchObject({
      budgetFailure: 'not_configured',
      org: 'example-org',
      surface: 'generate:stream',
    });
  });

  it('an owner still gets the detailed frame (the documented flip point)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = sanitizeStreamErrorFrame(
      { type: 'error', code: 'BudgetExceeded', org: 'example-org', message: UPSTREAM_LEAK },
      { requesterOrgKey: 'example-org' },
    );
    expect(out.status).toBe(402);
    expect(out.message).toBe(UPSTREAM_LEAK);
  });
});

describe('non-budget frames are left alone', () => {
  it('passes a ProviderTimeout frame through untouched', () => {
    const frame = {
      type: 'error',
      code: 'ProviderTimeout',
      message: 'The upstream LLM provider exceeded the request timeout.',
    };
    // Reference equality: genuine diagnostics must keep reaching developers.
    expect(sanitizeStreamErrorFrame(frame)).toBe(frame);
  });

  it('passes an INTERNAL frame through untouched', () => {
    const frame = { type: 'error', code: 'INTERNAL', message: 'generation failed' };
    expect(sanitizeStreamErrorFrame(frame)).toBe(frame);
  });

  it('passes a frame with no code through untouched', () => {
    const frame = { type: 'error', message: 'something else' };
    expect(sanitizeStreamErrorFrame(frame)).toBe(frame);
  });

  it('does not log for a non-budget frame', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sanitizeStreamErrorFrame({ type: 'error', code: 'RenderError', message: 'x' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('logAIWarnings', () => {
  it('logs BUDGET_SOFT_CAP once per warning at warn level', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logAIWarnings(
      [{ code: 'BUDGET_SOFT_CAP', message: 'Budget is below 10% remaining for org=example-org' }],
      'generate:sync',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual({
      aiWarningCode: 'BUDGET_SOFT_CAP',
      aiWarningMessage: 'Budget is below 10% remaining for org=example-org',
      surface: 'generate:sync',
    });
  });

  it('is a no-op when there are no warnings', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logAIWarnings(undefined, 's');
    logAIWarnings([], 's');
    logAIWarnings('not an array', 's');
    expect(spy).not.toHaveBeenCalled();
  });
});
