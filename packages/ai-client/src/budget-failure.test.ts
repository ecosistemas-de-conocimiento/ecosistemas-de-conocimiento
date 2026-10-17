/**
 * Every case here is a DRIFT one of the three product forks actually shipped.
 * If a case goes green after being red, a fork's bug is fixed for all of them;
 * if one goes red, the shared helper has re-acquired that fork's bug.
 */

import { describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  BudgetMisconfiguredError,
  BudgetNotConfiguredError,
} from './errors.js';
import {
  budgetFailureFromFrame,
  budgetFailureFromWire,
  budgetFailureLogFields,
  classifyBudgetFailure,
  isRequesterBudgetOwner,
  mayDiscloseBudgetAmounts,
} from './budget-failure.js';

describe('classifyBudgetFailure', () => {
  it('classifies each of the three ai-client error classes', () => {
    expect(classifyBudgetFailure(new BudgetNotConfiguredError('m', 'org-1'))?.kind).toBe(
      'not_configured',
    );
    expect(classifyBudgetFailure(new BudgetMisconfiguredError('m', 'org-1', 0))?.kind).toBe(
      'misconfigured',
    );
    expect(
      classifyBudgetFailure(
        new BudgetExceededError('m', { org: 'o', requested: 1, remaining: 0, shortfallUsd: 1 }),
      )?.kind,
    ).toBe('exceeded');
  });

  it('returns null for anything that is not a budget failure', () => {
    expect(classifyBudgetFailure(new Error('boom'))).toBeNull();
    expect(classifyBudgetFailure(null)).toBeNull();
    expect(classifyBudgetFailure('402')).toBeNull();
  });

  // Without walking `cause`, a wrapped budget error falls into generic handling.
  it('unwraps a budget error nested behind `cause`', () => {
    const wrapped = new Error('extraction failed', {
      cause: new Error('generate failed', { cause: new BudgetNotConfiguredError('m', 'org-9') }),
    });
    const f = classifyBudgetFailure(wrapped);
    expect(f?.kind).toBe('not_configured');
    expect(f?.org).toBe('org-9');
  });

  it('survives a self-referential cause chain', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(classifyBudgetFailure(e)).toBeNull();
  });

  // The name fallback covers the two-hoisted-
  // copies case, faked here with a plain object carrying the right name.
  it('classifies by `name` when the class identity does not match', () => {
    const foreign = Object.assign(new Error('nope'), {
      name: 'BudgetExceededError',
      org: 'org-2',
      requested: 3,
      remaining: 1,
      shortfallUsd: 2,
    });
    expect(classifyBudgetFailure(foreign)).toMatchObject({
      kind: 'exceeded',
      org: 'org-2',
      shortfallUsd: 2,
    });
  });

  // ai-client's numbers cannot pass straight through:
  // `errorFromResponse` coerces a missing field with `Number(undefined)` = NaN,
  // which serialises to `null` in a JSON response body.
  it('never produces NaN from a malformed wire number', () => {
    const bad = Object.assign(new Error('m'), {
      name: 'BudgetExceededError',
      org: 'o',
      requested: Number.NaN,
      remaining: undefined,
      shortfallUsd: 'lots',
    });
    expect(classifyBudgetFailure(bad)).toMatchObject({
      requestedUsd: 0,
      remainingUsd: 0,
      shortfallUsd: 0,
    });
  });
});

describe('budgetFailureFromWire', () => {
  it('reads all three discriminators off a 402 body', () => {
    const at = (error: string) => budgetFailureFromWire(402, JSON.stringify({ error, org: 'o' }));
    expect(at('BudgetNotConfigured')?.kind).toBe('not_configured');
    expect(at('BudgetExceeded')?.kind).toBe('exceeded');
    // ⚠ A switch with no case for this falls through to
    // `default: return null`, so a real budget failure arrives as a generic
    // opaque Error and the endpoint loses the branch.
    expect(at('BudgetMisconfigured')?.kind).toBe('misconfigured');
  });

  it('keeps a zero `estimatedCostUsdPerCall` rather than coercing it away', () => {
    // 0 is the whole CAUSE of a misconfigured profile — a `num()`-style coerce
    // would make it indistinguishable from "field absent".
    const f = budgetFailureFromWire(
      402,
      JSON.stringify({ error: 'BudgetMisconfigured', org: 'o', estimatedCostUsdPerCall: 0 }),
    );
    expect(f?.estimatedCostUsdPerCall).toBe(0);
  });

  it('reports null when the value was NaN/Infinity and JSON dropped it', () => {
    const f = budgetFailureFromWire(402, JSON.stringify({ error: 'BudgetMisconfigured', org: 'o' }));
    expect(f?.estimatedCostUsdPerCall).toBeNull();
  });

  it.each([
    ['a non-402 status', 500, '{"error":"BudgetExceeded"}'],
    ['an unparseable body', 402, 'not json'],
    ['a non-object body', 402, '"BudgetExceeded"'],
    ['an unknown discriminator', 402, '{"error":"SomethingElse"}'],
  ])('returns null for %s', (_why, status, body) => {
    expect(budgetFailureFromWire(status, body)).toBeNull();
  });

  it('reads an SSE frame by `code`', () => {
    expect(budgetFailureFromFrame({ code: 'BudgetExceeded', org: 'o' })?.kind).toBe('exceeded');
    expect(budgetFailureFromFrame({ code: 'nope' })).toBeNull();
  });
});

describe('disclosure', () => {
  // ⚠ A predicate that does not trim sees two whitespace-only org
  // keys as truthy AND equal.
  it('fails closed on whitespace-only org keys', () => {
    expect(isRequesterBudgetOwner('  ', '  ')).toBe(false);
    expect(isRequesterBudgetOwner('', '')).toBe(false);
    expect(isRequesterBudgetOwner(null, undefined)).toBe(false);
  });

  it('matches ignoring surrounding whitespace', () => {
    expect(isRequesterBudgetOwner(' org-1 ', 'org-1')).toBe(true);
    expect(isRequesterBudgetOwner('org-1', 'org-2')).toBe(false);
  });

  it('never discloses amounts for a platform fault, even to the owner', () => {
    const notConfigured = classifyBudgetFailure(new BudgetNotConfiguredError('m', 'org-1'))!;
    const misconfigured = classifyBudgetFailure(new BudgetMisconfiguredError('m', 'org-1', 0))!;
    expect(mayDiscloseBudgetAmounts(notConfigured, 'org-1')).toBe(false);
    expect(mayDiscloseBudgetAmounts(misconfigured, 'org-1')).toBe(false);
  });

  it('discloses an exceeded cap to its own org only', () => {
    const f = classifyBudgetFailure(
      new BudgetExceededError('m', { org: 'org-1', requested: 2, remaining: 1, shortfallUsd: 1 }),
    )!;
    expect(mayDiscloseBudgetAmounts(f, 'org-1')).toBe(true);
    expect(mayDiscloseBudgetAmounts(f, 'org-2')).toBe(false);
    expect(mayDiscloseBudgetAmounts(f, undefined)).toBe(false);
  });
});

describe('budgetFailureLogFields', () => {
  it('emits amounts only for exceeded, and the estimate only for misconfigured', () => {
    const exceeded = classifyBudgetFailure(
      new BudgetExceededError('m', { org: 'o', requested: 2, remaining: 1, shortfallUsd: 1 }),
    )!;
    expect(budgetFailureLogFields(exceeded, 'generate')).toEqual({
      budgetFailure: 'exceeded',
      org: 'o',
      upstreamMessage: 'm',
      surface: 'generate',
      requestedUsd: 2,
      remainingUsd: 1,
      shortfallUsd: 1,
    });

    const mis = classifyBudgetFailure(new BudgetMisconfiguredError('m', 'o', 0))!;
    expect(budgetFailureLogFields(mis)).toEqual({
      budgetFailure: 'misconfigured',
      org: 'o',
      upstreamMessage: 'm',
      estimatedCostUsdPerCall: 0,
    });
  });
});
