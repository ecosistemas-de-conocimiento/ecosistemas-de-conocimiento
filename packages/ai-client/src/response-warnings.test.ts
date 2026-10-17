// `logResponseWarnings` — log every advisory `warnings[]` entry once, at warn.

import { describe, expect, it, vi } from 'vitest';

import { RESPONSE_WARNING_LOG_MESSAGE, logResponseWarnings } from './index.js';

describe('logResponseWarnings', () => {
  it('logs each warning once with the fields all three consumers used', () => {
    const warn = vi.fn();
    logResponseWarnings(
      { warn },
      [
        { code: 'BUDGET_SOFT_CAP', message: 'low' },
        { code: 'OTHER', message: 'x' },
      ],
      'chat',
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      { aiWarningCode: 'BUDGET_SOFT_CAP', aiWarningMessage: 'low', surface: 'chat' },
      RESPONSE_WARNING_LOG_MESSAGE,
    );
    expect(RESPONSE_WARNING_LOG_MESSAGE).toBe('ai-service warning');
  });

  it('is a no-op for absent or empty warnings, and for a missing logger', () => {
    const warn = vi.fn();
    logResponseWarnings({ warn }, undefined, 's');
    logResponseWarnings({ warn }, null, 's');
    logResponseWarnings({ warn }, [], 's');
    expect(warn).not.toHaveBeenCalled();
    expect(() => logResponseWarnings(undefined, [{ code: 'A', message: 'b' }], 's')).not.toThrow();
    expect(() => logResponseWarnings(null, [{ code: 'A', message: 'b' }], 's')).not.toThrow();
  });

  it('tolerates an untrusted shape: non-array, null entries, missing fields', () => {
    const warn = vi.fn();
    logResponseWarnings({ warn }, 'nope' as never, 's');
    expect(warn).not.toHaveBeenCalled();
    logResponseWarnings({ warn }, [null, { code: 7 }, { message: 'm' }] as never, 's');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toEqual({ aiWarningCode: '', aiWarningMessage: '', surface: 's' });
    expect(warn.mock.calls[1]![0]).toEqual({ aiWarningCode: '', aiWarningMessage: 'm', surface: 's' });
  });
});
