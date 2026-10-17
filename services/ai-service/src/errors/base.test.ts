import { describe, expect, it } from 'vitest';

import { AiServiceError, isAiServiceError, NestedEnvelopeError } from './base.js';

class Flat extends AiServiceError {
  readonly code = 'ERR_FLAT';
  readonly status = 418;
  constructor(readonly detail: string) {
    super('flat failed');
    this.name = 'FlatError';
  }
  protected override bodyFields() {
    return { detail: this.detail };
  }
}

class Renamed extends AiServiceError {
  readonly code = 'ERR_RENAMED';
  readonly status = 409;
  override get wireError() {
    return 'RenamedOnTheWire';
  }
  constructor() {
    super('renamed');
    this.name = 'RenamedError';
  }
}

class Nested extends NestedEnvelopeError {
  readonly code = 'ERR_NESTED_THING';
  readonly status = 404;
  constructor() {
    super('nested failed');
    this.name = 'NestedError';
  }
}

describe('AiServiceError', () => {
  it('defaults to exposed, non-retryable, not mid-stream', () => {
    const e = new Flat('d');
    expect(e.expose).toBe(true);
    expect(e.retryable).toBe(false);
    expect(e.midStream).toBe(false);
    expect(e.headers).toBeUndefined();
  });

  it('is a real Error with a usable stack and name', () => {
    const e = new Flat('d');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('FlatError');
    expect(e.stack).toContain('FlatError');
  });

  it('builds a flat body: discriminator, class fields, then message', () => {
    expect(new Flat('why').toBody()).toEqual({
      error: 'FlatError',
      detail: 'why',
      message: 'flat failed',
    });
  });

  it('uses the class name as the wire discriminator unless overridden', () => {
    expect(new Renamed().toBody()).toEqual({
      error: 'RenamedOnTheWire',
      message: 'renamed',
    });
  });

  it('NestedEnvelopeError keeps the legacy `{error:{code,message}}` envelope', () => {
    expect(new Nested().toBody()).toEqual({
      error: { code: 'NESTED_THING', message: 'nested failed' },
    });
  });

  it("NestedEnvelopeError's wire code is its ERR_ string minus the prefix", () => {
    expect(new Nested().wireError).toBe('NESTED_THING');
    expect(new Nested().code).toBe('ERR_NESTED_THING');
  });
});

describe('isAiServiceError', () => {
  it('accepts our errors', () => {
    expect(isAiServiceError(new Flat('d'))).toBe(true);
    expect(isAiServiceError(new Nested())).toBe(true);
  });

  it('rejects anything else, including near misses', () => {
    expect(isAiServiceError(new Error('plain'))).toBe(false);
    expect(isAiServiceError(null)).toBe(false);
    expect(isAiServiceError(undefined)).toBe(false);
    expect(isAiServiceError('BudgetExceeded')).toBe(false);
    expect(isAiServiceError({ isAiServiceError: 'yes' })).toBe(false);
  });

  it('matches a DUPLICATE class identity, which `instanceof` would miss', () => {
    // Simulates the same file resolved twice: a structurally identical class
    // object that fails `instanceof` against the one we imported.
    const twin = Object.assign(new Error('twin'), { isAiServiceError: true });
    expect(twin instanceof Flat).toBe(false);
    expect(isAiServiceError(twin)).toBe(true);
  });
});
