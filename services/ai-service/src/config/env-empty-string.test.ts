// An environment variable that a deploy platform hands over as `""` is not
// "absent". Before `preprocessEnv` this file exists to cover, `""` split into
// two silent wrong answers:
//
//   · `RERANK_TIMEOUT_MS=`  →  `Number('') === 0`  →  `.nonnegative()` PASSES
//     →  every rerank call times out instantly, forever, and nothing logs it.
//   · `DATABASE_URL=`       →  exits 1 with `Invalid url` buried in a
//     `fieldErrors` dump that never says the var was blank.
//
// The two describes below are those two classes. `env.ts` computes both lists
// FROM THE SCHEMA (see `acceptsUnset` / `isScalarKnob`), so a var added later
// is classified without anyone remembering to update a list — the
// "classification is derived" test at the bottom is what keeps that honest.

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preprocessEnv } from './env.js';

/** The minimum that lets `envSchema.safeParse` succeed. */
const BASE = {
  DATABASE_URL: 'postgres://localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  API_KEYS: '{}',
  LOG_LEVEL: 'silent',
} as const;

describe('preprocessEnv — numeric/boolean vars WITH a default', () => {
  it('reads an empty numeric knob as UNSET so its default applies', () => {
    const { values, fatals } = preprocessEnv({ ...BASE, RERANK_TIMEOUT_MS: '' });
    // Deleted, not blanked: the key must be ABSENT or Zod parses it again.
    expect('RERANK_TIMEOUT_MS' in values).toBe(false);
    expect(fatals).toEqual([]);
  });

  it('emits exactly ONE warning, and it NAMES the variable', () => {
    const { warnings } = preprocessEnv({ ...BASE, RERANK_TIMEOUT_MS: '' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/RERANK_TIMEOUT_MS/);
  });

  it('names each blank var separately when several are blank', () => {
    const { warnings } = preprocessEnv({
      ...BASE,
      RERANK_TIMEOUT_MS: '',
      CONDENSE_TIMEOUT_MS: '',
      PORT: '',
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/RERANK_TIMEOUT_MS/);
    expect(warnings.join('\n')).toMatch(/CONDENSE_TIMEOUT_MS/);
    expect(warnings.join('\n')).toMatch(/PORT/);
  });

  it('covers the BOOLEAN flags too, not only the numbers', () => {
    // These are `z.enum(['true','false','0','1']).transform(...)`, so `''`
    // fails the enum outright today — a boot refused with `Invalid option`
    // rather than the documented default. Same class, same fix.
    const { values, warnings } = preprocessEnv({ ...BASE, RERANK_ENABLED: '', SPARSE_ENABLED: '' });
    expect('RERANK_ENABLED' in values).toBe(false);
    expect('SPARSE_ENABLED' in values).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it('covers an OPTIONAL numeric knob with no default', () => {
    // `WORKER_LOCK_DURATION_MS` is `.positive().optional()`. Absent means
    // "derive the window from LLM_REQUEST_TIMEOUT_MS"; `''` must mean the same.
    const { values, warnings } = preprocessEnv({ ...BASE, WORKER_LOCK_DURATION_MS: '' });
    expect('WORKER_LOCK_DURATION_MS' in values).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('leaves a NON-empty value completely alone', () => {
    const { values, warnings, fatals } = preprocessEnv({ ...BASE, RERANK_TIMEOUT_MS: '250' });
    expect(values['RERANK_TIMEOUT_MS']).toBe('250');
    expect(warnings).toEqual([]);
    expect(fatals).toEqual([]);
  });

  it('🔴 leaves an empty STRING var alone — this layer is scoped to the coercion class', () => {
    // `HOST` and `OPENROUTER_API_KEY` keep parsing to `''` exactly as before.
    // `validateProductionReadiness` already reads the empty key as missing;
    // widening this layer to strings would change what other read sites see.
    const { values, warnings } = preprocessEnv({ ...BASE, HOST: '', OPENROUTER_API_KEY: '' });
    expect(values['HOST']).toBe('');
    expect(values['OPENROUTER_API_KEY']).toBe('');
    expect(warnings).toEqual([]);
  });
});

describe('preprocessEnv — REQUIRED vars (no default, not optional)', () => {
  it.each(['DATABASE_URL', 'REDIS_URL'])('refuses a blank %s, naming it', (name) => {
    const { fatals } = preprocessEnv({ ...BASE, [name]: '' });
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toMatch(new RegExp(name));
    expect(fatals[0]).toMatch(/EMPTY/);
  });

  it('names EVERY blank required var, not just the first', () => {
    const { fatals } = preprocessEnv({ ...BASE, DATABASE_URL: '', REDIS_URL: '' });
    expect(fatals).toHaveLength(2);
  });

  it('is silent when the required vars are present', () => {
    expect(preprocessEnv({ ...BASE }).fatals).toEqual([]);
  });

  it('🔴 a required var is never demoted to the warn class', () => {
    // The two classes must not overlap: if `DATABASE_URL` were classified as
    // "empty means unset" it would be DELETED and the boot would proceed on a
    // Zod error instead of a message naming the var.
    const { values, warnings, fatals } = preprocessEnv({ ...BASE, DATABASE_URL: '' });
    expect(values['DATABASE_URL']).toBe('');
    expect(warnings).toEqual([]);
    expect(fatals).toHaveLength(1);
  });
});

// The classification is DERIVED from the schema, so this asserts the derivation
// rather than a list. Any numeric/boolean field that accepts being unset must
// land in the warn class; every other field must be left untouched.
describe('preprocessEnv — the classification is derived, not declared', () => {
  it('handles every knob that coerces a value to a number or a boolean', () => {
    const knobs = [
      'PORT',
      'EMBEDDING_DIM',
      'RERANK_TIMEOUT_MS',
      'SPARSE_DIM',
      'SPARSE_TIMEOUT_MS',
      'CONDENSE_TIMEOUT_MS',
      'LLM_REQUEST_TIMEOUT_MS',
      'LLM_ASYNC_REQUEST_TIMEOUT_MS',
      'WORKER_LOCK_DURATION_MS',
      'LLM_STREAM_STALL_TIMEOUT_MS',
      'RERANK_ENABLED',
      'SPARSE_ENABLED',
      'CALLBACK_ALLOW_PRIVATE',
      'SHUTDOWN_GRACE_MS',
    ];
    const blank = Object.fromEntries(knobs.map((k) => [k, '']));
    const { values, warnings } = preprocessEnv({ ...BASE, ...blank });
    // Named in the assertion so a failure says WHICH knob was left behind.
    const stillPresent = knobs.filter((k) => k in values);
    expect(stillPresent).toEqual([]);
    expect(warnings).toHaveLength(knobs.length);
  });

  it('does NOT touch the enum/url/string fields', () => {
    const others = { NODE_ENV: '', LOG_LEVEL: '', HOST: '', EMBEDDINGS_URL: '', EMBEDDING_MODEL: '' };
    const { values, warnings } = preprocessEnv({ ...BASE, ...others });
    for (const k of Object.keys(others)) expect(values[k]).toBe('');
    expect(warnings).toEqual([]);
  });
});

// End-to-end through the boot IIFE: what an operator actually gets.
describe('boot behaviour with a blank variable', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let warnSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as never;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('🔴 a blank timeout boots on its DEFAULT, not on 0', async () => {
    // The regression in one line. `Number('') === 0` and `.nonnegative()`
    // accepts it, so before the fix this read back as 0 and every rerank call
    // aborted before it was made.
    vi.stubEnv('RERANK_TIMEOUT_MS', '');
    const { env } = await import('./env.js');
    expect(env.RERANK_TIMEOUT_MS).toBe(5_000);
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/RERANK_TIMEOUT_MS/);
  });

  it('a blank required var refuses the boot with a message naming it', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expect(import('./env.js')).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/DATABASE_URL/);
  });

  it('a clean environment boots silently, on the documented defaults', async () => {
    const { env } = await import('./env.js');
    expect(env.RERANK_TIMEOUT_MS).toBe(5_000);
    expect(env.PORT).toBe(3000);
    expect(env.LLM_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
