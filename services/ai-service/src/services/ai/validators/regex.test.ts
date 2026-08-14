import { describe, expect, it } from 'vitest';

import { validateRegex } from './regex.js';

describe('validateRegex', () => {
  it('emits no flags when the output matches the pattern', () => {
    expect(validateRegex('hello world', { pattern: 'hello' })).toEqual([]);
  });

  it('emits a blocker on miss with a descriptive message', () => {
    const flags = validateRegex('hello world', { pattern: '^bye' });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('blocker');
    expect(flags[0]?.code).toBe('regex-mismatch');
    expect(flags[0]?.message).toContain('/^bye/');
  });

  it('honors regex flags', () => {
    expect(validateRegex('HELLO', { pattern: 'hello', flags: 'i' })).toEqual([]);
    expect(validateRegex('HELLO', { pattern: 'hello' })).toHaveLength(1);
  });

  it('coerces non-string output to JSON before matching', () => {
    const flags = validateRegex({ foo: 'bar' }, { pattern: '"foo"' });
    expect(flags).toEqual([]);
  });

  it('treats null/undefined as empty string', () => {
    expect(validateRegex(null, { pattern: '^$' })).toEqual([]);
    expect(validateRegex(undefined, { pattern: '^$' })).toEqual([]);
  });

  it('emits a blocker on invalid pattern instead of throwing', () => {
    const flags = validateRegex('x', { pattern: '(' });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('regex-invalid');
    expect(flags[0]?.severity).toBe('blocker');
  });

  it('includes flags in the mismatch message when provided', () => {
    const flags = validateRegex('abc', { pattern: 'z', flags: 'i' });
    expect(flags[0]?.message).toContain('/z/i');
  });
});
