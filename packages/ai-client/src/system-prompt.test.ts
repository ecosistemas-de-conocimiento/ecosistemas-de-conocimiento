// `assertSystemPromptApplied` — the fail-loud guard three consumers hand-rolled.

import { describe, expect, it, vi } from 'vitest';

import { SystemPromptNotAppliedError, assertSystemPromptApplied } from './index.js';

describe('assertSystemPromptApplied', () => {
  it('is a no-op when no system prompt was sent', () => {
    for (const sent of [undefined, null, '']) {
      expect(() =>
        assertSystemPromptApplied({ sentSystemPrompt: sent, applied: undefined, surface: 's' }),
      ).not.toThrow();
    }
  });

  it('passes only on an explicit `true`', () => {
    expect(() =>
      assertSystemPromptApplied({ sentSystemPrompt: 'rules', applied: true, surface: 's' }),
    ).not.toThrow();
  });

  it('throws on `false`, on an ABSENT flag (old deployment) and on a truthy non-boolean', () => {
    for (const applied of [false, undefined, null, 'true', 1]) {
      expect(() =>
        assertSystemPromptApplied({ sentSystemPrompt: 'rules', applied, surface: 's' }),
      ).toThrow(SystemPromptNotAppliedError);
    }
  });

  it('carries surface, endpoint and the observed value on the error', () => {
    let caught: unknown;
    try {
      assertSystemPromptApplied({
        sentSystemPrompt: 'rules',
        applied: undefined,
        surface: 'extraction',
        endpoint: '/v1/generate/sync',
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as SystemPromptNotAppliedError;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SystemPromptNotAppliedError');
    expect(err.surface).toBe('extraction');
    expect(err.endpoint).toBe('/v1/generate/sync');
    expect(err.applied).toBeUndefined();
    expect(err.message).toContain('"extraction"');
    expect(err.message).toContain('/v1/generate/sync');
    expect(err.message).toContain('systemPromptApplied=undefined');
  });

  it('logs at error BEFORE throwing when given a logger (call sites that swallow errors)', () => {
    const error = vi.fn();
    expect(() =>
      assertSystemPromptApplied({
        sentSystemPrompt: 'rules',
        applied: false,
        surface: 'summary',
        logger: { error },
      }),
    ).toThrow(SystemPromptNotAppliedError);
    expect(error).toHaveBeenCalledTimes(1);
    const [fields, msg] = error.mock.calls[0]!;
    expect(fields).toMatchObject({ surface: 'summary', systemPromptApplied: false });
    expect(msg).toBe('ai-service did not apply the system prompt');
  });

  it('does not log when the prompt was applied', () => {
    const error = vi.fn();
    assertSystemPromptApplied({ sentSystemPrompt: 'r', applied: true, surface: 's', logger: { error } });
    expect(error).not.toHaveBeenCalled();
  });
});
