import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PROD_INDEXABLE,
  ROBOTS_TXT_DISALLOW_ALL,
  isNonProdHost,
  robotsTxtFor,
  shouldNoindex,
} from './robots.js';

describe('isNonProdHost', () => {
  it('treats a .dev.example.org host as non-prod', () => {
    expect(isNonProdHost('ai.dev.example.org')).toBe(true);
  });

  it('treats a .stage.example.org host as non-prod', () => {
    expect(isNonProdHost('ai.stage.example.org')).toBe(true);
  });

  it('treats a demo-0 host as non-prod via the .dev suffix, with no special case', () => {
    expect(isNonProdHost('ai-demo-0.dev.example.org')).toBe(true);
  });

  it('treats the production host as prod', () => {
    expect(isNonProdHost('ai.example.org')).toBe(false);
  });

  it('treats localhost and the loopback addresses as non-prod', () => {
    expect(isNonProdHost('localhost')).toBe(true);
    expect(isNonProdHost('127.0.0.1')).toBe(true);
    expect(isNonProdHost('::1')).toBe(true);
    expect(isNonProdHost('[::1]:3000')).toBe(true);
  });

  it('ignores a port', () => {
    expect(isNonProdHost('localhost:3000')).toBe(true);
    expect(isNonProdHost('ai.dev.example.org:443')).toBe(true);
    expect(isNonProdHost('ai.example.org:443')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isNonProdHost('AI.DEV.example.org')).toBe(true);
    expect(isNonProdHost('AI.example.org')).toBe(false);
  });

  it('does not match a lookalike host that merely contains the suffix', () => {
    // `.dev.example.org.evil.example` must NOT read as non-prod, and an
    // unrelated domain must not read as EDC at all.
    expect(isNonProdHost('ai.dev.example.org.evil.example')).toBe(false);
    expect(isNonProdHost('example.org')).toBe(false);
  });
});

describe('noindex policy', () => {
  it('keeps PROD_INDEXABLE false', () => {
    expect(PROD_INDEXABLE).toBe(false);
  });

  it('noindexes every environment, production included — this is a machine API', () => {
    for (const host of [
      'ai.dev.example.org',
      'ai.stage.example.org',
      'ai-demo-0.dev.example.org',
      'ai.example.org',
      'localhost:3000',
    ]) {
      expect(shouldNoindex(host)).toBe(true);
      expect(robotsTxtFor(host)).toBe(ROBOTS_TXT_DISALLOW_ALL);
    }
  });

  // ⚠ REGRESSION GUARD. `shouldNoindex` once ended in `return !PROD_INDEXABLE`,
  // which made that constant a live switch on the production host while its own
  // comment claimed it was inert. This asserts the clamp is structural: the
  // source must not branch on PROD_INDEXABLE at all. Reading the source is the
  // only way to test this — a value-based test cannot tell a clamped `true`
  // from a `!PROD_INDEXABLE` that happens to be `true` today.
  it('does not consult PROD_INDEXABLE — the clamp is structural, not incidental', () => {
    const source = readFileSync(new URL('./robots.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export function shouldNoindex'));
    const impl = body.slice(0, body.indexOf('\n}'));
    const code = impl
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toContain('PROD_INDEXABLE');
  });

  it('serves the exact fleet-wide disallow body', () => {
    expect(ROBOTS_TXT_DISALLOW_ALL).toBe('User-agent: *\nDisallow: /\n');
  });
});

/**
 * THE SIX CANONICAL CASES for `isNonProdHost`.
 */
describe('the six fleet-canonical cases', () => {
  it('1. a dev host is non-prod', () => {
    expect(isNonProdHost('frontend-code.dev.example.org')).toBe(true);
  });

  it('2. a stage host is non-prod', () => {
    expect(isNonProdHost('chat.stage.example.org')).toBe(true);
  });

  it('3. a demo-0 host is covered by the SAME dev suffix — no second rule', () => {
    expect(isNonProdHost('chat-demo-0.dev.example.org')).toBe(true);
  });

  it('4. 🔴 an IPv6 loopback is non-prod, bracketed or bare', () => {
    // The defect this pass fixes: `'::1'.split(':')[0]` is `''`, which matches
    // no suffix and therefore read as PRODUCTION — a fail-open in the one
    // direction that matters.
    expect(isNonProdHost('::1')).toBe(true);
    expect(isNonProdHost('[::1]:8080')).toBe(true);
  });

  it('5. loopback and localhost are non-prod, port and all', () => {
    expect(isNonProdHost('127.0.0.1:5173')).toBe(true);
    expect(isNonProdHost('localhost:3000')).toBe(true);
  });

  it('6. 🔴 production AND its lookalike both read as prod', () => {
    // `evil-dev.example.org` ends in `-dev.example.org`, NOT `.dev.example.org`.
    // If anyone "simplifies" `endsWith` to `includes`, this is what goes red.
    expect(isNonProdHost('chat.example.org')).toBe(false);
    expect(isNonProdHost('evil-dev.example.org')).toBe(false);
  });
});
