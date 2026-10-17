// Unit tests for `validateRerankCredential` — the boot gate that stops a
// deployment which would silently never rerank.
//
// WHY THIS GATE IS WORTH A FILE OF ITS OWN
// ----------------------------------------
// The rerank rung fails safe: `RetrieveService.applyRerank` catches everything
// and returns the fused order. So a hosted reranker that 401s produces a 200
// that is byte-identical to `rerank: false` minus `rerankScore`. There is no
// field a consumer could read to notice. The ONLY defences are this boot
// refusal and `legs` at query time — which is why both are tested by forcing
// the failure, never by asserting a happy path.
//
// `env` is frozen at module-import time (Zod parses `process.env` once), so
// each test stubs vars and re-imports via `vi.resetModules()`.

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('validateRerankCredential', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let warnSpy: MockInstance<(...args: unknown[]) => unknown>;
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    // Baseline env that lets `envSchema.safeParse` succeed.
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('NODE_ENV', 'development');

    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as unknown as MockInstance<
      (...args: unknown[]) => unknown
    >;
    // Throw on exit so the test can assert it fired AND short-circuit the
    // probe's control flow, matching what real `process.exit` would do.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  /** Put the rerank rung LIVE: enabled, with a URL. */
  function liveRung(): void {
    vi.stubEnv('RERANK_ENABLED', 'true');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
  }

  it('🔴 refuses to boot when a LIVE hosted provider has no key', async () => {
    liveRung();
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_API_KEY', '');

    const { validateRerankCredential } = await import('./env.js');

    expect(() => validateRerankCredential()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/FATAL.*RERANK_API_KEY/s);
  });

  it('refuses in PRODUCTION too — the rule does not vary by environment', async () => {
    // Per-environment divergence is how this shape reaches prod unseen: dev is
    // where the broken config gets written, so dev must be where it stops.
    vi.stubEnv('NODE_ENV', 'production');
    liveRung();
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).toThrow(/process\.exit\(1\)/);
  });

  it('treats a whitespace-only key as missing', async () => {
    liveRung();
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_API_KEY', '   ');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).toThrow(/process\.exit\(1\)/);
  });

  it('boots when the LIVE hosted provider has a key', async () => {
    liveRung();
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_API_KEY', 'di-token');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('WARNS but does not refuse when the rung is dark (seam shipped off)', async () => {
    // `RERANK_ENABLED=false` is the documented "ship the seam dark" posture.
    // Refusing there would break the deploy pattern the whole design rests on;
    // staying silent would hide a half-finished config until the day it is
    // switched on. So: visible, not fatal.
    vi.stubEnv('RERANK_ENABLED', 'false');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/RERANK_API_KEY/);
  });

  it('WARNS but does not refuse when enabled with no RERANK_URL', async () => {
    // Enabled with nothing to call is already a no-op rung; the missing URL is
    // the louder defect and `RERANK_URL` has its own handling.
    vi.stubEnv('RERANK_ENABLED', 'true');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('is SILENT for `cohere` with no key — that value covers the local sibling', async () => {
    // The default posture across the fleet today. If this ever warns, every
    // local boot grows a line nobody can act on, and the warning stops working.
    liveRung();
    vi.stubEnv('RERANK_URL', 'http://localhost:58000/rerank');
    vi.stubEnv('RERANK_PROVIDER', 'cohere');

    const { validateRerankCredential } = await import('./env.js');
    expect(() => validateRerankCredential()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('defaults RERANK_PROVIDER to `rerank-api` when unset', async () => {
    liveRung();
    const { env } = await import('./env.js');
    expect(env.RERANK_PROVIDER).toBe('rerank-api');
  });

  // Ruling: `rerank-api` is the canonical name of the Cohere-style
  // wire; `cohere` stays accepted so deployed envs keep booting. Both must land
  // on the SAME parsed value, because the adapter table and the allowlist key
  // on it — a `cohere` that survived parsing would have no adapter.
  it.each(['rerank-api', 'cohere'])('parses RERANK_PROVIDER=%s to the `rerank-api` adapter key', async (value) => {
    liveRung();
    vi.stubEnv('RERANK_PROVIDER', value);
    const { env } = await import('./env.js');
    expect(env.RERANK_PROVIDER).toBe('rerank-api');
  });

  it('rejects an unknown RERANK_PROVIDER at schema level', async () => {
    // A typo like `deep-infra` must not fall through to the default and
    // quietly send Cohere bodies to a DeepInfra endpoint.
    vi.stubEnv('RERANK_PROVIDER', 'deep-infra');
    await expect(import('./env.js')).rejects.toThrow();
  });
});

describe('🔴 the gate is REACHED from the boot entry point', () => {
  // `src/index.ts` calls only `validateProductionReadiness`. That function
  // RETURNS EARLY when OPENROUTER_API_KEY is absent — legitimate in dev/test —
  // so a rerank check sequenced after it would silently never fire in exactly
  // the environments that run without an LLM key. These tests are the fence on
  // that ordering: they fail if the call is ever moved below the early return.
  let exitSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RERANK_ENABLED', 'true');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never) as unknown as MockInstance<(...args: unknown[]) => unknown>;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fires from validateProductionReadiness even with NO OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const { validateProductionReadiness } = await import('./env.js');
    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fires from validateProductionReadiness when an LLM key IS present', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-abc');
    const { validateProductionReadiness } = await import('./env.js');
    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
  });
});

describe('validateRerankEndpoint — RERANK_URL and RERANK_MODEL must address a real model', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => unknown>;
  let warnSpy: MockInstance<(...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/x');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RERANK_ENABLED', 'true');
    vi.stubEnv('RERANK_API_KEY', 'di-token');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined) as never;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as never;
    // Throws so a test can assert the refusal AND short-circuit control flow,
    // matching what real `process.exit` would do.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('🔴 refuses a FULL inference URL under deepinfra', async () => {
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B');
    vi.stubEnv('RERANK_MODEL', 'Qwen/Qwen3-Reranker-0.6B');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).toThrow(/process\.exit\(1\)/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/API BASE/);
  });

  it('🔴 refuses the self-hosted DEFAULT model under deepinfra — measured 404', async () => {
    // The silent killer of a provider switch: everything else is right, the
    // model simply is not served there, and every call 404s into the fail-safe.
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).toThrow(/process\.exit\(1\)/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/does not host/);
  });

  it('accepts a base URL with a DeepInfra-served model', async () => {
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    vi.stubEnv('RERANK_MODEL', 'Qwen/Qwen3-Reranker-0.6B');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is SILENT for cohere, whatever the URL and model — composition is deepinfra-only', async () => {
    vi.stubEnv('RERANK_PROVIDER', 'cohere');
    vi.stubEnv('RERANK_URL', 'http://localhost:58000/rerank');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('WARNS but does not refuse while the rung is dark', async () => {
    vi.stubEnv('RERANK_ENABLED', 'false');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('🔴 refuses to boot on a LIVE Google/Anthropic model — item 10.3, voids DeepInfra terms', async () => {
    // DeepInfra hosts-by-proxy Google and Anthropic models; its no-training and
    // no-sharing terms stop there. A 200 from such a model is the WORST case:
    // nothing 404s, the rung works, and the pool leaves under another vendor's terms.
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    for (const model of ['google/gemini-2.5-flash', 'anthropic/claude-sonnet-4']) {
      vi.stubEnv('RERANK_MODEL', model);
      vi.resetModules();
      const { validateRerankEndpoint } = await import('./env.js');
      expect(() => validateRerankEndpoint()).toThrow(/process\.exit\(1\)/);
    }
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/allowlist/);
  });

  it('WARNS on a disallowed model while the rung is dark — same rule as the URL check', async () => {
    vi.stubEnv('RERANK_ENABLED', 'false');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    vi.stubEnv('RERANK_MODEL', 'google/gemini-2.5-flash');
    const { validateRerankEndpoint } = await import('./env.js');
    expect(() => validateRerankEndpoint()).not.toThrow();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/allowlist/);
  });

  it('🔴 BOOTS with the allowlisted Qwen model — the allowlist is not empty by accident', async () => {
    // The positive control for the refusals above: remove Qwen from
    // DEEPINFRA_RERANK_MODELS and this goes red, because dev runs exactly this.
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    vi.stubEnv('RERANK_MODEL', 'Qwen/Qwen3-Reranker-0.6B');
    const { validateRerankEndpoint, rerankModelRefusal } = await import('./env.js');
    expect(rerankModelRefusal('deepinfra', 'Qwen/Qwen3-Reranker-0.6B')).toBeUndefined();
    expect(() => validateRerankEndpoint()).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rerankModelRefusal: exact match, deepinfra only', async () => {
    const { rerankModelRefusal } = await import('./env.js');
    // Case matters: DeepInfra model ids are case-sensitive path segments.
    expect(rerankModelRefusal('deepinfra', 'qwen/qwen3-reranker-0.6b')).toMatch(/allowlist/);
    expect(rerankModelRefusal('deepinfra', 'Qwen/Qwen3-Reranker-0.6B/../x')).toMatch(/allowlist/);
    // `cohere` also covers the self-hosted sibling — nothing leaves the perimeter.
    expect(rerankModelRefusal('rerank-api', 'google/gemini-2.5-flash')).toBeUndefined();
  });

  it('🔴 is REACHED from validateProductionReadiness with no OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('RERANK_PROVIDER', 'deepinfra');
    vi.stubEnv('RERANK_URL', 'https://api.deepinfra.com');
    const { validateProductionReadiness } = await import('./env.js');
    expect(() => validateProductionReadiness()).toThrow(/process\.exit\(1\)/);
  });
});
