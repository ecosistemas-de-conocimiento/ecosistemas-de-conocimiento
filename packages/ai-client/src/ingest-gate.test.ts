// Tests for the process-wide ingest gate.
//
// Real timers, tiny numbers. Every assertion below corresponds to a protection
// that was verified by BREAKING it first (red), restoring, and re-running
// (green) — the numbers live in the branch's commit message.
//
// Timing margins are deliberately loose: this box runs many concurrent
// sessions, so a wait asserted as ">= 130ms" against a 150ms window has room
// to be late without being wrong.

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { BudgetExceededError, RateLimitError, errorFromResponse } from './errors.js';
import {
  DEFAULT_INGEST_GATE_CONFIG,
  IngestGate,
  IngestRateLimitExhaustedError,
  MAX_DOCS_PER_INGEST_REQUEST,
  chunkDocuments,
  configureIngestGate,
  getIngestGate,
  ingestGateScopeFor,
  rateLimitRetryAfterMs,
  _resetIngestGatesForTests,
  type IngestGateConfig,
  type IngestGateEvent,
} from './ingest-gate.js';

const META = { corpus: 'c1', documentIds: ['a', 'b'] };

function tiny(over: Partial<IngestGateConfig> = {}): Partial<IngestGateConfig> {
  return {
    maxConcurrent: 4,
    maxPerWindow: 3,
    windowMs: 150,
    maxAttempts: 3,
    deadlineMs: { interactive: 600, bulk: 3_000 },
    queueDeadlineMs: { interactive: 300, bulk: 8_000 },
    maxRetryAfterMs: 800,
    retryAfterPaddingMs: 0,
    fallbackRetryAfterMs: 20,
    ...over,
  };
}

/** A 429 shaped exactly like ai-service's `errorResponseBuilder` output. */
function serverRateLimit(retryAfterMs: number): RateLimitError {
  return new RateLimitError(`Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs, {
    error: 'RateLimitExceeded',
    message: 'Rate limit exceeded.',
    retryAfterMs,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The sliding-window invariant, stated so it survives a loaded machine.
 *
 * "At most `max` admissions in any `windowMs` interval" is equivalent to
 * "admission k and admission k+max are at least `windowMs` apart". The second
 * form tolerates the few ms between a gate admitting a call and the task
 * actually recording a timestamp; anchoring intervals on measured times does
 * not, and produces false failures under load.
 *
 * A FIXED window fails this: it resets its counter on a boundary and lets a
 * later burst through, which shows up as a too-small gap. See the staggered
 * test below.
 */
function assertSlidingWindow(stamps: number[], max: number, windowMs: number, tolMs = 20): void {
  const s = [...stamps].sort((a, b) => a - b);
  for (let i = 0; i + max < s.length; i += 1) {
    expect(s[i + max]! - s[i]!).toBeGreaterThanOrEqual(windowMs - tolMs);
  }
}

beforeEach(() => {
  _resetIngestGatesForTests();
});

// ---------------------------------------------------------------------------
// 1. RATE — sliding window
// ---------------------------------------------------------------------------

describe('rate: sliding window bounds admissions', () => {
  it('admits at most maxPerWindow inside any windowMs interval', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 10, maxPerWindow: 3, windowMs: 150 }));
    const t0 = Date.now();
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          stamps.push(Date.now() - t0);
        }, { ...META, lane: 'bulk' }),
      ),
    );
    stamps.sort((a, b) => a - b);
    expect(stamps).toHaveLength(6);
    // First window: 3 admissions, effectively immediate.
    expect(stamps.slice(0, 3).every((t) => t < 100)).toBe(true);
    // Second window: the remaining 3 wait for slots to age out.
    expect(stamps.slice(3).every((t) => t >= 130)).toBe(true);
    assertSlidingWindow(stamps, 3, 150);
  });

  it('is SLIDING, not fixed — a burst cannot straddle a boundary', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 10, maxPerWindow: 3, windowMs: 200 }));
    const t0 = Date.now();
    const stamps: number[] = [];
    const run = () =>
      gate.run(async () => {
        stamps.push(Date.now() - t0);
      }, { ...META, lane: 'bulk' });
    // Two admissions now, then four more 150ms later. A FIXED window resetting
    // at t=200 would admit all four at once (2 + 4 = 6 inside [0,350]);
    // a sliding window must not.
    const first = [run(), run()];
    await sleep(150);
    const second = [run(), run(), run(), run()];
    await Promise.all([...first, ...second]);
    assertSlidingWindow(stamps, 3, 200);
  });
});

// ---------------------------------------------------------------------------
// 2. CONCURRENCY
// ---------------------------------------------------------------------------

describe('concurrency: semaphore bounds in-flight calls', () => {
  it('never exceeds maxConcurrent', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 2, maxPerWindow: 100, windowMs: 60_000 }));
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await sleep(20);
          live -= 1;
        }, { ...META, lane: 'bulk' }),
      ),
    );
    expect(peak).toBe(2);
    expect(live).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 429 — honour the server's OWN stated wait
// ---------------------------------------------------------------------------

describe('429: honours the server-stated wait', () => {
  it('waits retryAfterMs from the body, then succeeds', async () => {
    const gate = new IngestGate(tiny({ maxPerWindow: 100, windowMs: 60_000 }));
    let calls = 0;
    const t0 = Date.now();
    const out = await gate.run(async () => {
      calls += 1;
      if (calls === 1) throw serverRateLimit(200);
      return 'ok';
    }, META);
    expect(out).toBe('ok');
    expect(calls).toBe(2);
    // The historical bug: a fixed 1-2-4-8 ladder gave up long before the
    // server's stated wait. Anything under the stated wait means we ignored it.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  it('shares the cooldown process-wide — one 429 parks every other caller', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 8, maxPerWindow: 100, windowMs: 60_000 }));
    const t0 = Date.now();
    let aCalls = 0;
    const a = gate.run(async () => {
      aCalls += 1;
      if (aCalls === 1) throw serverRateLimit(250);
      return 'a';
    }, META);
    // Let A's first attempt land and set the cooldown.
    await sleep(20);
    let bStartedAt = -1;
    const b = gate.run(async () => {
      bStartedAt = Date.now() - t0;
      return 'b';
    }, META);
    await Promise.all([a, b]);
    // B never saw a 429 itself; it was parked on A's cooldown.
    expect(bStartedAt).toBeGreaterThanOrEqual(230);
  });

  it('reads the wait from every shape a refusal can arrive in', () => {
    const cfg = { maxRetryAfterMs: 60_000, retryAfterPaddingMs: 0, fallbackRetryAfterMs: 5_000 };
    // 1. typed RateLimitError from this package
    expect(rateLimitRetryAfterMs(serverRateLimit(58_420), cfg)).toBe(58_420);
    // 2. parsed body only
    expect(
      rateLimitRetryAfterMs({ status: 429, body: { retryAfterMs: 1_234 } }, cfg),
    ).toBe(1_234);
    // 3. JSON embedded in a re-thrown plain Error's message
    expect(
      rateLimitRetryAfterMs(
        new Error('ai-service /v1/ingest -> HTTP 429: {"error":"RateLimitExceeded","retryAfterMs":7000}'),
        cfg,
      ),
    ).toBe(7_000);
    // 4. ai-service's own wording
    expect(rateLimitRetryAfterMs(new Error('Rate limit exceeded. Retry after 59s.'), cfg)).toBe(59_000);
    // 5. no usable hint
    expect(rateLimitRetryAfterMs({ status: 429, body: {} }, cfg)).toBe(5_000);
    // not a rate limit at all
    expect(rateLimitRetryAfterMs(new Error('boom'), cfg)).toBeNull();
    expect(rateLimitRetryAfterMs({ status: 400, body: { error: 'BadRequest' } }, cfg)).toBeNull();
  });

  it('clamps a hostile hint to maxRetryAfterMs', () => {
    const cfg = { maxRetryAfterMs: 1_000, retryAfterPaddingMs: 0, fallbackRetryAfterMs: 20 };
    expect(rateLimitRetryAfterMs(serverRateLimit(999_999), cfg)).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// 4. ATTEMPTS + WALL CLOCK, and the two SEPARATE budgets
// ---------------------------------------------------------------------------

describe('budgets: attempts and wall clock are both bounded', () => {
  it('gives up after maxAttempts and says so', async () => {
    const gate = new IngestGate(tiny({ maxAttempts: 3, maxPerWindow: 100, windowMs: 60_000 }));
    let calls = 0;
    const err = await gate
      .run(async () => {
        calls += 1;
        throw serverRateLimit(10);
      }, META)
      .catch((e) => e);
    expect(err).toBeInstanceOf(IngestRateLimitExhaustedError);
    expect(err.reason).toBe('attempts');
    expect(err.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('refuses to burn an attempt on a wait it cannot afford', async () => {
    const gate = new IngestGate(
      tiny({ maxAttempts: 9, maxPerWindow: 100, windowMs: 60_000, deadlineMs: { interactive: 120, bulk: 120 } }),
    );
    let calls = 0;
    const err = await gate
      .run(async () => {
        calls += 1;
        throw serverRateLimit(600); // longer than the whole retry budget
      }, META)
      .catch((e) => e);
    expect(err).toBeInstanceOf(IngestRateLimitExhaustedError);
    expect(err.reason).toBe('deadline');
    expect(calls).toBe(1);
  });

  it('🔴 queue budget is SEPARATE from the retry budget — the last call of a big seed is still ATTEMPTED', async () => {
    // The historical bug: one shared budget meant the last calls of a seed
    // failed with `deadline` having NEVER been attempted — a silent partial
    // seed. Here the retry budget is TINY (120ms) and the queue budget is
    // generous, so a long queue wait must not consume the retry budget.
    const gate = new IngestGate(
      tiny({
        maxConcurrent: 1,
        maxPerWindow: 2,
        windowMs: 150,
        deadlineMs: { interactive: 120, bulk: 120 },
        queueDeadlineMs: { interactive: 5_000, bulk: 5_000 },
      }),
    );
    let attempted = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        gate.run(async () => {
          attempted += 1;
          return i;
        }, { ...META, lane: 'bulk' }),
      ),
    );
    // Every single one ran. None failed with `deadline` while merely queued.
    expect(attempted).toBe(8);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('a call that never gets a slot fails with reason "queue", not "deadline"', async () => {
    const gate = new IngestGate(
      tiny({ maxConcurrent: 1, maxPerWindow: 1, windowMs: 5_000, queueDeadlineMs: { interactive: 80, bulk: 80 } }),
    );
    const held = gate.run(() => sleep(300), { ...META, lane: 'bulk' });
    const err = await gate.run(async () => 'never', { ...META, lane: 'bulk' }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestRateLimitExhaustedError);
    expect(err.reason).toBe('queue');
    expect(err.attempts).toBe(1); // one attempt to acquire, zero task calls
    await held;
  });
});

// ---------------------------------------------------------------------------
// 5. LOUD failure, naming corpus + document ids
// ---------------------------------------------------------------------------

describe('failure is loud and names what did not land', () => {
  it('carries corpus + every document id, not a batch index', async () => {
    const gate = new IngestGate(tiny({ maxAttempts: 1, maxPerWindow: 100, windowMs: 60_000 }));
    const err: IngestRateLimitExhaustedError = await gate
      .run(async () => {
        throw serverRateLimit(10);
      }, { corpus: 'laws-v2', documentIds: ['doc-1', 'doc-2', 'doc-3'], lane: 'bulk' })
      .catch((e) => e);
    expect(err.corpus).toBe('laws-v2');
    expect(err.documentIds).toEqual(['doc-1', 'doc-2', 'doc-3']);
    const line = err.describe();
    expect(line).toContain('laws-v2');
    expect(line).toContain('doc-1');
    expect(line).toContain('doc-3');
    expect(line).toContain('lane=bulk');
  });

  it('emits structured trace events so a long park is never silent', async () => {
    const seen: IngestGateEvent[] = [];
    const gate = new IngestGate(
      tiny({ maxAttempts: 2, maxPerWindow: 100, windowMs: 60_000, logger: (e) => seen.push(e) }),
    );
    await gate.run(async () => { throw serverRateLimit(10); }, META).catch(() => undefined);
    expect(seen.map((e) => e.event)).toEqual(['rate-limited', 'retry', 'rate-limited', 'exhausted']);
    expect(seen.at(-1)?.reason).toBe('attempts');
    expect(seen[0]?.waitMs).toBe(10);
  });

  it('a throwing logger never breaks ingest', async () => {
    const gate = new IngestGate(
      tiny({ maxPerWindow: 100, windowMs: 60_000, logger: () => { throw new Error('logger down'); } }),
    );
    let calls = 0;
    const out = await gate.run(async () => {
      calls += 1;
      if (calls === 1) throw serverRateLimit(10);
      return 'ok';
    }, META);
    expect(out).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 6. The gate is a RATE LIMITER, not a general retry loop
// ---------------------------------------------------------------------------

describe('non-rate-limit errors', () => {
  it('propagate unchanged and immediately, with no retry', async () => {
    const gate = new IngestGate(tiny({ maxPerWindow: 100, windowMs: 60_000 }));
    const boom = new BudgetExceededError('no budget', {
      org: 'o', requested: 1, remaining: 0, shortfallUsd: 1,
    });
    let calls = 0;
    const t0 = Date.now();
    const err = await gate.run(async () => { calls += 1; throw boom; }, META).catch((e) => e);
    expect(err).toBe(boom);
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// 7. LANES
// ---------------------------------------------------------------------------

describe('lanes', () => {
  it('interactive work jumps ahead of queued bulk work', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 1, maxPerWindow: 1, windowMs: 120 }));
    const order: string[] = [];
    const bulk = [1, 2, 3].map((n) =>
      gate.run(async () => { order.push(`bulk${n}`); }, { ...META, lane: 'bulk' }),
    );
    await sleep(10); // let bulk1 take the only immediate slot
    const inter = gate.run(async () => { order.push('interactive'); }, { ...META, lane: 'interactive' });
    await Promise.all([...bulk, inter]);
    expect(order[0]).toBe('bulk1');
    expect(order[1]).toBe('interactive');
  });
});

// ---------------------------------------------------------------------------
// 7b. INTERACTIVE RESERVE — bulk may never spend the last share of a window
// ---------------------------------------------------------------------------

describe('interactive reserve', () => {
  // 4 per 300 ms window, 50% reserved: bulk gets 2, interactive the rest.
  const reserveCfg = (over: Partial<IngestGateConfig> = {}) =>
    tiny({
      maxConcurrent: 8,
      maxPerWindow: 4,
      windowMs: 300,
      interactiveReserveShare: 0.5,
      queueDeadlineMs: { interactive: 100, bulk: 8_000 },
      ...over,
    });

  it('an interactive call arriving AFTER bulk saturates the window is admitted within its queue budget', async () => {
    const gate = new IngestGate(reserveCfg());
    const stamps: number[] = [];
    const bulk = Array.from({ length: 6 }, () =>
      gate.run(async () => { stamps.push(Date.now()); }, { ...META, lane: 'bulk' }),
    );
    await sleep(20); // bulk has taken everything it is allowed to
    const t0 = Date.now();
    // Queue budget 100 ms, but the window does not free a stamp for ~280 ms.
    // Without the reserve this call finds the window full and fails 'queue'.
    await gate.run(async () => { stamps.push(Date.now()); }, { ...META, lane: 'interactive' });
    expect(Date.now() - t0).toBeLessThan(100);
    await Promise.all(bulk);
    // Bulk still drains, and the total never breaks the window.
    expect(stamps).toHaveLength(7);
    assertSlidingWindow(stamps, 4, 300);
  });

  it('bulk alone never takes more than its share of any window', async () => {
    const gate = new IngestGate(reserveCfg());
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => { stamps.push(Date.now()); }, { ...META, lane: 'bulk' }),
      ),
    );
    expect(stamps).toHaveLength(6);
    // 2 per window, not 4: admission k and k+2 are a full window apart.
    assertSlidingWindow(stamps, 2, 300);
  });

  it('interactive may use the WHOLE window, reserve included', async () => {
    const gate = new IngestGate(reserveCfg({ queueDeadlineMs: { interactive: 50, bulk: 8_000 } }));
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () => gate.run(async () => {}, { ...META, lane: 'interactive' })),
    );
    expect(Date.now() - t0).toBeLessThan(50);
    expect(gate.stats().admitsInWindow).toBe(4);
  });

  it('never wedges bulk: a reserve of 100% still leaves one admission per window', async () => {
    const gate = new IngestGate(reserveCfg({ interactiveReserveShare: 1, windowMs: 100 }));
    await expect(gate.run(async () => 'ok', { ...META, lane: 'bulk' })).resolves.toBe('ok');
  });

  it('ships a 25% reserve by default (10 of 40)', () => {
    expect(DEFAULT_INGEST_GATE_CONFIG.interactiveReserveShare).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// 8. CANCELLATION
// ---------------------------------------------------------------------------

describe('abort', () => {
  it('a cancelled call leaves the queue and frees the slot', async () => {
    const gate = new IngestGate(tiny({ maxConcurrent: 1, maxPerWindow: 1, windowMs: 5_000 }));
    const held = gate.run(() => sleep(120), { ...META, lane: 'bulk' });
    const ctrl = new AbortController();
    const cancelled = gate.run(async () => 'never', { ...META, lane: 'bulk', signal: ctrl.signal });
    await sleep(10);
    expect(gate.stats().waiting).toBe(1);
    ctrl.abort(new Error('client disconnected'));
    await expect(cancelled).rejects.toThrow('client disconnected');
    expect(gate.stats().waiting).toBe(0);
    await held;
  });
});

// ---------------------------------------------------------------------------
// 9. CONFIG
// ---------------------------------------------------------------------------

describe('config', () => {
  it('ships the budget both prior implementations converged on', () => {
    expect(DEFAULT_INGEST_GATE_CONFIG.maxPerWindow).toBe(40);
    expect(DEFAULT_INGEST_GATE_CONFIG.windowMs).toBe(60_000);
    expect(DEFAULT_INGEST_GATE_CONFIG.maxConcurrent).toBe(4);
    expect(DEFAULT_INGEST_GATE_CONFIG.maxAttempts).toBe(5);
    expect(DEFAULT_INGEST_GATE_CONFIG.deadlineMs).toEqual({ interactive: 30_000, bulk: 300_000 });
    expect(DEFAULT_INGEST_GATE_CONFIG.queueDeadlineMs).toEqual({ interactive: 15_000, bulk: 2_700_000 });
    expect(MAX_DOCS_PER_INGEST_REQUEST).toBe(100);
  });

  it('merges the per-lane records FIELD-WISE, so a partial override keeps the other lane', () => {
    // One prior implementation spread only `deadlineMs`, letting `...cfg`
    // clobber `queueDeadlineMs` wholesale — `bulk` became undefined and every
    // bulk call expired instantly.
    const gate = new IngestGate({ queueDeadlineMs: { interactive: 50 } as never });
    expect(gate.config().queueDeadlineMs.interactive).toBe(50);
    expect(gate.config().queueDeadlineMs.bulk).toBe(2_700_000);
    const g2 = new IngestGate({ deadlineMs: { bulk: 77 } as never });
    expect(g2.config().deadlineMs.bulk).toBe(77);
    expect(g2.config().deadlineMs.interactive).toBe(30_000);
  });

  it('configureIngestGate reaches a gate that already exists', () => {
    const gate = getIngestGate('scope-a');
    expect(gate.config().maxPerWindow).toBe(40);
    configureIngestGate({ maxPerWindow: 7 });
    expect(gate.config().maxPerWindow).toBe(7);
    // and future gates in this process too
    expect(getIngestGate('scope-b').config().maxPerWindow).toBe(7);
  });

  it('scopes gates per API key, so a 429 on one key does not park the other', () => {
    const s1 = ingestGateScopeFor('https://ai.example', 'key-one');
    const s2 = ingestGateScopeFor('https://ai.example', 'key-two');
    expect(s1).not.toBe(s2);
    expect(getIngestGate(s1)).not.toBe(getIngestGate(s2));
    // The raw key is never embedded in the scope id.
    expect(s1).not.toContain('key-one');
  });
});

// ---------------------------------------------------------------------------
// 10. 🔴 SINGLETON SURVIVES MODULE DUPLICATION (the Next.js bundling property)
// ---------------------------------------------------------------------------

describe('process-wide singleton', () => {
  it('two evaluations of this module share ONE gate', async () => {
    const first = await import('./ingest-gate.js');
    const gate1 = first.getIngestGate('bundling-scope');
    // `vi.resetModules()` makes the next import evaluate the module AGAIN in
    // the same realm — exactly what Next.js does when the same file lands in a
    // route bundle, `instrumentation.ts` and an admin bundle. A module-level
    // `let` would hand out a second gate here, and two gates each honouring
    // 40/min is 80/min against a 100/min limit.
    vi.resetModules();
    const second = await import('./ingest-gate.js');
    expect(second).not.toBe(first);
    expect(second.IngestGate).not.toBe(first.IngestGate); // genuinely a 2nd copy
    expect(second.getIngestGate('bundling-scope')).toBe(gate1);
  });

  it('keeps the registry on globalThis under a shared Symbol.for key', () => {
    const gate = getIngestGate('probe');
    const reg = (globalThis as Record<symbol, unknown>)[
      Symbol.for('edc.ai-client.ingestGates')
    ] as { gates: Map<string, { gate: unknown }> };
    expect(reg.gates.get('probe')?.gate).toBe(gate);
  });
});

// ---------------------------------------------------------------------------
// 11. CHUNKING
// ---------------------------------------------------------------------------

describe('chunking', () => {
  it('splits to the schema cap and never above it', () => {
    expect(chunkDocuments(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunkDocuments([]).length).toBe(0);
    expect(chunkDocuments([1, 2, 3]).map((c) => c.length)).toEqual([3]);
    // A caller asking for a bigger chunk than the server accepts is clamped.
    expect(chunkDocuments(Array.from({ length: 150 }, (_, i) => i), 500).map((c) => c.length)).toEqual([100, 50]);
  });
});

// ---------------------------------------------------------------------------
// 12. errorFromResponse / HttpClient — the header is no longer discarded
// ---------------------------------------------------------------------------

describe('429 typing and the Retry-After header', () => {
  it('types a 429 as RateLimitError and prefers the body value', () => {
    const err = errorFromResponse(429, { error: 'RateLimitExceeded', message: 'nope', retryAfterMs: 58_420 }, {
      get: () => '59',
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(58_420); // ms precision beats the rounded header
  });

  it('falls back to the Retry-After HEADER when the body has no retryAfterMs', () => {
    const err = errorFromResponse(429, { error: 'RateLimitExceeded', message: 'nope' }, {
      get: (n) => (n.toLowerCase() === 'retry-after' ? '59' : null),
    });
    expect((err as RateLimitError).retryAfterMs).toBe(59_000);
  });

  it('types a bare 429 with no discriminator at all', () => {
    const err = errorFromResponse(429, { message: 'Too Many Requests' });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. 🔴 A PLAIN NODE PROCESS MUST NOT EXIT WITH WORK STILL QUEUED
// ---------------------------------------------------------------------------
//
// This runs in a REAL child process, because the property cannot be observed
// from inside vitest — the runner holds the event loop open by itself and hides
// the bug completely. The gate's wake timer used to be `unref()`ed, so a seed
// script got its first window of calls through and then Node simply ENDED, with
// no error and no exit code, losing the rest. That is the exact silent
// partial-seed failure the gate exists to prevent, and the `bulk` lane's main
// consumer is a CLI.

describe('event loop', () => {
  it('a plain Node process stays alive until every queued ingest has run', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const path = await import('node:path');
    const url = await import('node:url');
    const module = await import('node:module');

    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../..');
    const script = `
      import { IngestGate } from ${JSON.stringify(path.join(here, 'ingest-gate.ts'))};
      const gate = new IngestGate({ maxConcurrent: 1, maxPerWindow: 2, windowMs: 120,
        queueDeadlineMs: { interactive: 9000, bulk: 9000 } });
      const done = [];
      await Promise.all(Array.from({ length: 6 }, (_, i) =>
        gate.run(async () => { done.push(i); }, { corpus: 'c', documentIds: ['d' + i], lane: 'bulk' })));
      console.log('RAN=' + done.length);
      console.log('DONE');
    `;
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-client-gate-'));
    const file = path.join(dir, 'probe.mts'); // .mts: the temp dir has no package.json, so tsx would treat .ts as CJS and reject top-level await
    await fs.writeFile(file, script, 'utf8');
    let stdout = '';
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        // Resolved through Node's module lookup: a nested worktree has no
        // node_modules of its own and finds tsx in a parent directory.
        [module.createRequire(import.meta.url).resolve('tsx/cli'), file],
        { cwd: repoRoot, timeout: 25_000 },
      ));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    // With an unref'd wake timer this prints nothing at all: Node exits after
    // the first window and the awaited promise never settles.
    expect(stdout).toContain('RAN=6');
    expect(stdout).toContain('DONE');
  }, 30_000);
});
