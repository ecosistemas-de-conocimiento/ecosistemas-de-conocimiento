/**
 * The registry flip is an OPERATIONAL switch, so its DEFAULT matters more than
 * its on-state: an environment that has not yet seeded the `chat` registry row
 * must keep sending the inline override, or ai-service returns HTTP 400 on
 * every chat turn (`resolve.ts` throws with no override, no row and no
 * `project_configs` row — and `project_configs` is empty on dev/stage/prod).
 *
 * `$env/dynamic/private` resolves once and cannot be mutated from a test, so
 * the decision lives in the pure `isRegistrySource` and is asserted there; the
 * env-reading wrapper is covered separately with the module mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import { isRegistrySource, PROMPT_SOURCE_REGISTRY, useRegistryPrompt } from './promptSource';

describe('isRegistrySource', () => {
  it('is ON only for the exact opt-in value', () => {
    expect(PROMPT_SOURCE_REGISTRY).toBe('registry');
    expect(isRegistrySource('registry')).toBe(true);
  });

  it('is OFF when unset — an unseeded environment keeps working', () => {
    expect(isRegistrySource(undefined)).toBe(false);
  });

  it('fails CLOSED on near-misses and truthy junk', () => {
    // Wrongly OFF is just today's behaviour; wrongly ON is a 400 on every turn.
    for (const v of ['Registry', 'REGISTRY', 'registry ', ' registry', 'true', '1', 'yes', 'inline', '']) {
      expect(isRegistrySource(v), `${JSON.stringify(v)} must not enable the registry`).toBe(false);
    }
  });
});

describe('useRegistryPrompt', () => {
  it('defaults to OFF in an environment that sets nothing', () => {
    expect(useRegistryPrompt()).toBe(false);
  });

  it('reads PROMPT_SOURCE from the server env', async () => {
    vi.resetModules();
    vi.doMock('$env/dynamic/private', () => ({ env: { PROMPT_SOURCE: 'registry' } }));
    const mod = await import('./promptSource');
    expect(mod.useRegistryPrompt()).toBe(true);
    vi.doUnmock('$env/dynamic/private');
    vi.resetModules();
  });
});
