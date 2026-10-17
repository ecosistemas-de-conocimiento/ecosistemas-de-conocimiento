// Tests for the auth timing posture: `matchConfiguredKey` in
// `src/plugins/auth.ts` must compare the presented bearer token against EVERY
// configured API key, with no early exit — not on a miss, and NOT after a hit.
//
// Why the hit case matters (it is the clause people drop as an "obvious"
// optimisation): a loop that `break`s on the match makes a SUCCESSFUL request's
// time a function of the matched key's position in the map. Timing authenticated
// requests would then reveal WHICH configured key a token corresponds to.
//
// How this is measured: `node:crypto` is wrapped so every `timingSafeEqual`
// call is counted. The count for a hit on the FIRST key, a hit on the LAST key,
// and a total miss must all equal the number of configured keys.
//
// Sabotage check: add `break` after the match in `matchConfiguredKey` (or
// restore the old `Object.hasOwn(env.API_KEYS, token)` lookup) and these go RED.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` because the `vi.mock` factory below runs at module-import time,
// before this file's own top-level bindings would otherwise be initialised.
const counter = vi.hoisted(() => ({ compares: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      counter.compares += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

// Three keys, so "compared them all" is distinguishable from "stopped at the
// first hit" (1) and from "stopped at the last hit" (3 vs a miss's 3 only if
// every key is scanned). Set BEFORE any dynamic import: `config/env.ts` parses
// `process.env` once, at module load.
const FIRST_KEY = 'tok-alpha';
const LAST_KEY = 'tok-charlie';
const KEYS: Record<string, { org: string; project: string; role: 'app' }> = {
  [FIRST_KEY]: { org: 'timing-org', project: 'timing-project', role: 'app' },
  'tok-bravo': { org: 'timing-org', project: 'timing-project', role: 'app' },
  [LAST_KEY]: { org: 'timing-org', project: 'timing-project', role: 'app' },
};
const KEY_COUNT = Object.keys(KEYS).length;
process.env.API_KEYS = JSON.stringify(KEYS);

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

/** Counts the digest comparisons one authenticated request performs. */
async function comparesFor(token: string): Promise<{ status: number; compares: number }> {
  const app = await makeApp();
  try {
    // Reset AFTER boot: server construction may hash for unrelated reasons.
    counter.compares = 0;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, compares: counter.compares };
  } finally {
    await app.close();
  }
}

describe('requireAuth — constant-time key match, no early exit', () => {
  beforeEach(() => {
    counter.compares = 0;
  });

  it('sanity: the wrapper actually observes comparisons', async () => {
    const { compares } = await comparesFor(FIRST_KEY);
    // Guards against a silently ineffective `vi.mock` making every assertion
    // below vacuously true at 0.
    expect(compares).toBeGreaterThan(0);
  });

  it('compares every configured key on a MISS', async () => {
    const { status, compares } = await comparesFor('tok-not-configured');
    expect(status).toBe(401);
    expect(compares).toBe(KEY_COUNT);
  });

  it('compares every configured key on a HIT against the FIRST entry', async () => {
    // A `break` on the match would stop this at 1 comparison.
    const { status, compares } = await comparesFor(FIRST_KEY);
    expect(status).toBe(200);
    expect(compares).toBe(KEY_COUNT);
  });

  it('compares every configured key on a HIT against the LAST entry', async () => {
    const { status, compares } = await comparesFor(LAST_KEY);
    expect(status).toBe(200);
    expect(compares).toBe(KEY_COUNT);
  });

  it('a hit on the first key costs exactly what a hit on the last key costs', async () => {
    // The property the position-leak depends on, asserted directly rather than
    // inferred from the two counts above.
    const first = await comparesFor(FIRST_KEY);
    const last = await comparesFor(LAST_KEY);
    const miss = await comparesFor('tok-not-configured');
    expect(first.compares).toBe(last.compares);
    expect(first.compares).toBe(miss.compares);
  });

  it('a prototype-chain token is compared against every key and still rejected', async () => {
    // `Object.keys` never offers `__proto__` as a candidate, so the match loop
    // cannot return it — and the scan is not short-circuited either.
    const { status, compares } = await comparesFor('__proto__');
    expect(status).toBe(401);
    expect(compares).toBe(KEY_COUNT);
  });
});
