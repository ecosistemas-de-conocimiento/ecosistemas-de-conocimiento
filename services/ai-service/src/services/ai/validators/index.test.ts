import { describe, expect, it } from 'vitest';

import { runValidators } from './index.js';
import type { Validator, ValidatorContext } from './types.js';

const stringSchema = { type: 'string', minLength: 1 } as const;

describe('runValidators', () => {
  it('returns no flags when there are no checks', () => {
    expect(runValidators([], 'anything')).toEqual([]);
  });

  it('dispatches to json-schema with an inline schema param', () => {
    const checks: Validator[] = [{ type: 'json-schema', schema: stringSchema }];
    expect(runValidators(checks, 'hello')).toEqual([]);
    const flags = runValidators(checks, 123);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('json-schema-mismatch');
  });

  it('bare-string json-schema falls back to context.responseSchema', () => {
    const checks: Validator[] = ['json-schema'];
    const ctx: ValidatorContext = { responseSchema: stringSchema };
    expect(runValidators(checks, 'hello', ctx)).toEqual([]);
    const flags = runValidators(checks, 42, ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('json-schema-mismatch');
  });

  it('emits a blocker when json-schema has no schema (neither inline nor on context)', () => {
    const flags = runValidators(['json-schema'], 'hello');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('json-schema-missing');
    expect(flags[0]?.severity).toBe('blocker');
  });

  it('dispatches to regex with pattern + optional flags', () => {
    const checks: Validator[] = [{ type: 'regex', pattern: '^hello', flags: 'i' }];
    expect(runValidators(checks, 'HELLO world')).toEqual([]);
    const flags = runValidators(checks, 'goodbye');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('regex-mismatch');
  });

  it('emits a blocker when regex has no pattern param', () => {
    const flags = runValidators([{ type: 'regex' }], 'x');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('regex-missing-pattern');
  });

  it('skips unknown validator types silently', () => {
    const checks: Validator[] = [
      { type: 'similarity-score', threshold: 0.8 },
      'nlp-tokens',
      { type: 'regex', pattern: 'ok' },
    ];
    const flags = runValidators(checks, 'ok then');
    expect(flags).toEqual([]);
  });

  it('aggregates flags across multiple checks in order', () => {
    const checks: Validator[] = [
      { type: 'json-schema', schema: stringSchema },
      { type: 'regex', pattern: '^foo' },
    ];
    const flags = runValidators(checks, 'bar');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('regex-mismatch');
    const flags2 = runValidators(checks, 123 as unknown);
    expect(flags2).toHaveLength(2);
    expect(flags2.map((f) => f.code)).toEqual(['json-schema-mismatch', 'regex-mismatch']);
  });
});
