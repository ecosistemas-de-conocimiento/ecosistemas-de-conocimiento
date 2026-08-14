import { describe, expect, it } from 'vitest';

import {
  isValidTextSearchConfig,
  NEUTRAL_REGCONFIG,
  resolveTextSearchConfig,
  TEXT_SEARCH_CONFIGS,
} from './language.js';

describe('isValidTextSearchConfig', () => {
  it('accepts installed Postgres regconfig names', () => {
    for (const c of ['simple', 'spanish', 'english', 'french', 'portuguese', 'german']) {
      expect(isValidTextSearchConfig(c)).toBe(true);
    }
  });

  it('rejects ISO locale codes and garbage', () => {
    // The whole point: an unknown name (which would throw at `::regconfig`)
    // must NOT pass. ISO codes like `es`/`en` are no longer the wire contract.
    for (const bad of ['es', 'en', 'es-MX', 'en-US', 'Spanish', 'SPANISH', '', '1234', '¡hola!']) {
      expect(isValidTextSearchConfig(bad)).toBe(false);
    }
  });

  it('whitelist mirrors the stock pg_ts_config set (includes the languages we serve)', () => {
    expect(TEXT_SEARCH_CONFIGS.has('simple')).toBe(true);
    expect(TEXT_SEARCH_CONFIGS.has('spanish')).toBe(true);
    expect(TEXT_SEARCH_CONFIGS.has('english')).toBe(true);
  });
});

describe('resolveTextSearchConfig', () => {
  it('returns a valid regconfig unchanged', () => {
    expect(resolveTextSearchConfig('spanish')).toBe('spanish');
    expect(resolveTextSearchConfig('english')).toBe('english');
    expect(resolveTextSearchConfig('simple')).toBe('simple');
  });

  it('degrades null/undefined/unknown to the neutral regconfig', () => {
    expect(resolveTextSearchConfig(null)).toBe(NEUTRAL_REGCONFIG);
    expect(resolveTextSearchConfig(undefined)).toBe(NEUTRAL_REGCONFIG);
    expect(resolveTextSearchConfig('es')).toBe(NEUTRAL_REGCONFIG);
    expect(NEUTRAL_REGCONFIG).toBe('simple');
  });
});
