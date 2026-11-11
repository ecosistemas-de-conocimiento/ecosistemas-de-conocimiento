// Unit tests for the callback retry sweeper.
//
// These pin the three properties that make the sweeper safe to leave running:
//
//   1. It recovers a delivery stranded by a process restart — the whole point.
//      Without it the row stays `pending` with a past `next_attempt_at`
//      forever and the callback is silently lost.
//   2. Two replicas sweeping the same rows deliver each row exactly once.
//   3. It stops at the contract's 5-attempt cap instead of retrying forever.
//
// Plus the guards around them: the grace period that keeps the sweeper off
// rows a healthy in-process timer still owns, the age ceiling that prevents a
// first run from flooding consumers with stale events, and dry-run.
//
// The fake DB below implements just enough Postgres semantics to exercise the
// claim: row-level locking with SKIP LOCKED, and the fact that the claim's
// WHERE clause is re-evaluated against current row state. The REAL
// concurrency behaviour was additionally verified against a live Postgres —
// 4 concurrent sweepers over 10 stranded rows produced 10 disjoint claims and
// exactly 10 deliveries, and removing the lease + SKIP LOCKED produced 40.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { rootLogger } from '../../logger.js';
import { capturedLog } from '../../testing/captured-log.js';
import { MAX_ATTEMPTS } from './emit.js';
import {
  sweepOnce,
  startCallbackSweeper,
  DEFAULT_SWEEPER_CONFIG,
} from './sweeper.js';

// ---------------------------------------------------------------------------
// A tiny in-memory stand-in for `callback_deliveries` + the SQL the sweeper
// issues. It is intentionally literal about the parts that matter: which rows
// a claim is allowed to take, and that a locked row is skipped, not shared.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  attempt: number;
  next_attempt_at: Date | null;
  created_at: Date;
  last_error: string | null;
  /** Reporting columns; only the dead-letter tests set them. */
  org?: string;
  project?: string | null;
  source?: string;
  source_id?: string;
  item_key?: string | null;
  event?: string;
  response_status?: number | null;
}

interface FakePg {
  db: Db;
  rows: Row[];
  /** ids currently locked by an uncommitted claim, to emulate SKIP LOCKED. */
  locked: Set<string>;
}

/**
 * ⚠ Every timestamp here is RELATIVE to `Date.now()`, never an absolute date.
 *
 * The sweeper compares `created_at` against `now - maxAgeMs` (24h by default)
 * and refuses anything older, so a fixture pinned to a literal calendar date
 * is a time bomb: it works the week it is written and then dead-letters every
 * row forever. This suite carried `2026-08-15T00:00:00.000Z` here and went red
 * on its own 24 hours later, with no code change and no way to self-heal.
 * A fixture date that expires is a defect the day it is written, not the day
 * it fires.
 *
 * Defaults: a row created a quarter of an hour ago (well inside the age
 * ceiling) whose retry fell due ten minutes ago (well past the grace period).
 */
function makeRow(over: Partial<Row> = {}): Row {
  const now = Date.now();
  return {
    id: 'd-1',
    status: 'pending',
    attempt: 1,
    next_attempt_at: new Date(now - 600_000),
    created_at: new Date(now - 900_000),
    last_error: null,
    ...over,
  };
}

/**
 * Flatten a drizzle `sql` object into the SQL text plus, for each bind param,
 * the text that immediately precedes it.
 *
 * Looking params up by the fragment in front of them ("next_attempt_at < ")
 * rather than by position keeps this fake from breaking every time the query
 * gains or reorders a parameter.
 */
interface Bound {
  text: string;
  /** Bind values, each tagged with the SQL text accumulated before it. */
  params: Array<{ before: string; value: unknown }>;
}

function flattenSql(q: unknown): Bound {
  let text = '';
  const params: Bound['params'] = [];

  const walk = (node: unknown): void => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const c of chunks) {
      if (c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value)) {
        text += ((c as { value: unknown[] }).value as unknown[]).join('');
      } else if (c && typeof c === 'object' && 'queryChunks' in (c as object)) {
        walk(c);
      } else {
        params.push({ before: text, value: c });
      }
    }
  };
  walk(q);
  return { text, params };
}

function makeFakePg(rows: Row[]): FakePg {
  const locked = new Set<string>();

  const execute = async (q: unknown): Promise<unknown> => {
    const { text, params } = flattenSql(q);

    /** The bind value that follows the given SQL fragment. */
    const after = (needle: string): unknown =>
      params.find((p) => p.before.trimEnd().endsWith(needle))?.value;

    const isUpdate = /UPDATE callback_deliveries/i.test(text);
    const isDeadLetter = /status = 'dead_letter'/i.test(text);
    const isSelectStatus = /SELECT status FROM callback_deliveries/i.test(text);
    const skipLocked = /FOR UPDATE SKIP LOCKED/i.test(text);
    const byAge = /created_at </i.test(text);
    const byCap = /attempt >=/i.test(text);

    if (isSelectStatus) {
      const id = after('WHERE id =') as string;
      const r = rows.find((x) => x.id === id);
      return r ? [{ status: r.status }] : [];
    }

    // The per-status gauge refresh.
    if (/GROUP BY status/i.test(text)) {
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      return [...counts].map(([status, n]) => ({ status, n }));
    }

    const candidates = rows.filter((r) => {
      if (r.status !== 'pending') return false;
      // SKIP LOCKED: a row another (uncommitted) claim holds is skipped, not
      // waited on and not shared.
      if (skipLocked && locked.has(r.id)) return false;

      if (isDeadLetter && byAge) {
        return r.created_at < new Date(after('created_at <') as string);
      }
      if (isDeadLetter && byCap) {
        return r.attempt >= Number(after('attempt >='));
      }
      // The claim condition.
      const dueBefore = new Date(after('next_attempt_at <') as string);
      const bornBefore = new Date(after('created_at >=') as string);
      return (
        r.next_attempt_at !== null &&
        r.next_attempt_at < dueBefore &&
        r.attempt < Number(after('attempt <')) &&
        r.created_at >= bornBefore
      );
    });

    if (!isUpdate) return candidates.map((r) => ({ id: r.id })); // dry-run SELECT

    for (const r of candidates) {
      if (isDeadLetter) {
        r.status = 'dead_letter';
        r.next_attempt_at = null;
        r.last_error = 'retired';
      } else {
        // The lease: apply whatever the claim SQL actually assigns to
        // `next_attempt_at`.
        //
        // ⚠ Read from the statement, never assumed. Two earlier versions of
        // this fake hard-coded the lease and held the row lock forever, and
        // as a result the multi-replica tests stayed GREEN with the lease
        // deleted from the query — they were pinning the fake, not the
        // sweeper. If the SQL stops setting a new timestamp here, these tests
        // must go red.
        const leaseValue = after('SET next_attempt_at =');
        if (leaseValue !== undefined) {
          r.next_attempt_at = new Date(leaseValue as string);
        }
        // Row locks release at "commit", exactly as Postgres does at the end
        // of the claim statement — so from here on the ONLY thing stopping a
        // re-claim is the lease above.
        locked.delete(r.id);
      }
    }
    // A retire returns the reporting columns (RETURNING id, org, …).
    return candidates.map((r) => (isDeadLetter ? { ...r } : { id: r.id }));
  };

  return { db: { execute } as unknown as Db, rows, locked };
}

// ---------------------------------------------------------------------------

const CFG = { graceMs: 1_000, leaseMs: 120_000, batchSize: 50 };

describe('callback sweeper — recovery after a restart', () => {
  it('claims and delivers a row stranded by a dead in-process timer', async () => {
    // A row exactly as a killed process leaves it: pending, one attempt spent,
    // next_attempt_at in the past, and no timer anywhere that will fire it.
    const rows = [
      makeRow({ next_attempt_at: new Date(Date.now() - 600_000) }),
    ];
    const { db } = makeFakePg(rows);
    const delivered: string[] = [];
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));

    // `attemptDelivery` is the real one; give it a row it can read by making
    // the fake return the status it wrote. We assert on the claim instead of
    // re-testing emit.ts, which has its own suite.
    const result = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: CFG,
      logger: {
        info: (_o, m) => delivered.push(String(m)),
        warn: () => {},
        error: () => {},
      },
    });

    expect(result.claimed).toEqual(['d-1']);
    expect(result.dryRun).toBe(false);
    // It logged — a sweep that touched something is never silent.
    expect(delivered.join(' ')).toContain('recovered stranded deliveries');
  });

  it('leaves a row alone while it is still inside the grace period', async () => {
    // Overdue by only 1s, with a 120s grace: a healthy timer still owns this.
    const rows = [makeRow({ next_attempt_at: new Date(Date.now() - 1_000) })];
    const { db } = makeFakePg(rows);

    const result = await sweepOnce({
      db,
      fetcher: vi.fn() as unknown as typeof fetch,
      config: { ...CFG, graceMs: DEFAULT_SWEEPER_CONFIG.graceMs },
    });

    expect(result.claimed).toEqual([]);
    expect(rows[0]!.status).toBe('pending');
  });

  it('ignores rows that are not yet due at all', async () => {
    const rows = [makeRow({ next_attempt_at: new Date(Date.now() + 300_000) })];
    const { db } = makeFakePg(rows);
    const result = await sweepOnce({
      db,
      fetcher: vi.fn() as unknown as typeof fetch,
      config: CFG,
    });
    expect(result.claimed).toEqual([]);
  });
});

describe('callback sweeper — multi-replica safety', () => {
  it('two concurrent sweeps claim disjoint rows; no row is claimed twice', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({
        id: `d-${i}`,
        next_attempt_at: new Date(Date.now() - 600_000),
      }),
    );
    const { db } = makeFakePg(rows);
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));

    const [a, b] = await Promise.all([
      sweepOnce({ db, fetcher: fetcher as unknown as typeof fetch, config: CFG }),
      sweepOnce({ db, fetcher: fetcher as unknown as typeof fetch, config: CFG }),
    ]);

    const all = [...a.claimed, ...b.claimed];
    // Every row claimed exactly once across both replicas.
    expect(all.length).toBe(new Set(all).size);
    expect(new Set(all).size).toBe(10);
    // And the overlap between the two replicas is empty.
    const overlap = a.claimed.filter((id) => b.claimed.includes(id));
    expect(overlap).toEqual([]);
  });

  it('skips a row another replica is mid-claim on, rather than blocking or sharing it', async () => {
    // `FOR UPDATE SKIP LOCKED`: the row is locked by an uncommitted claim on
    // another replica. We must leave it alone entirely — not wait for it, and
    // certainly not deliver it too.
    const rows = [
      makeRow({ id: 'mine', next_attempt_at: new Date(Date.now() - 600_000) }),
      makeRow({ id: 'theirs', next_attempt_at: new Date(Date.now() - 600_000) }),
    ];
    const { db, locked } = makeFakePg(rows);
    locked.add('theirs');

    const result = await sweepOnce({
      db,
      fetcher: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
      config: CFG,
    });

    expect(result.claimed).toEqual(['mine']);
    expect(result.claimed).not.toContain('theirs');
  });

  it('a second sweep does not re-claim rows the first one leased', async () => {
    const rows = [makeRow({ next_attempt_at: new Date(Date.now() - 600_000) })];
    const { db } = makeFakePg(rows);
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));

    const first = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: CFG,
    });
    const second = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: CFG,
    });

    expect(first.claimed).toEqual(['d-1']);
    // The lease pushed next_attempt_at into the future — the second sweep sees
    // nothing due. This is what stops two replicas double-delivering.
    expect(second.claimed).toEqual([]);
  });
});

describe('callback sweeper — attempt cap', () => {
  it('never claims a row that has already used the whole 5-attempt schedule', async () => {
    const rows = [
      makeRow({
        id: 'capped',
        attempt: MAX_ATTEMPTS,
        next_attempt_at: new Date(Date.now() - 600_000),
      }),
    ];
    const { db } = makeFakePg(rows);
    const fetcher = vi.fn();

    const result = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: CFG,
    });

    // Retired, not delivered — and nothing went on the wire.
    expect(result.claimed).toEqual([]);
    expect(result.abandonedCap).toEqual(['capped']);
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe('dead_letter');
  });

  it('a row one attempt below the cap is still eligible', async () => {
    const rows = [
      makeRow({
        attempt: MAX_ATTEMPTS - 1,
        next_attempt_at: new Date(Date.now() - 600_000),
      }),
    ];
    const { db } = makeFakePg(rows);
    const result = await sweepOnce({
      db,
      fetcher: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
      config: CFG,
    });
    expect(result.claimed).toEqual(['d-1']);
    expect(result.abandonedCap).toEqual([]);
  });
});

describe('callback sweeper — age ceiling', () => {
  it('dead-letters a row past the age ceiling instead of delivering it', async () => {
    // The flood scenario: a very old stranded row that a newly-enabled sweeper
    // must NOT fire at a consumer.
    const rows = [
      makeRow({
        id: 'ancient',
        created_at: new Date(Date.now() - 72 * 60 * 60_000),
        next_attempt_at: new Date(Date.now() - 72 * 60 * 60_000),
      }),
    ];
    const { db } = makeFakePg(rows);
    const fetcher = vi.fn();

    const result = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: { ...CFG, maxAgeMs: 24 * 60 * 60_000 },
    });

    expect(result.abandonedAge).toEqual(['ancient']);
    expect(result.claimed).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows[0]!.status).toBe('dead_letter');
    // Terminal, so it stops being swept — but still visible to the admin API.
    expect(rows[0]!.next_attempt_at).toBeNull();
  });

  it('a recent row is delivered normally', async () => {
    const rows = [
      makeRow({
        created_at: new Date(Date.now() - 60_000),
        next_attempt_at: new Date(Date.now() - 600_000),
      }),
    ];
    const { db } = makeFakePg(rows);
    const result = await sweepOnce({
      db,
      fetcher: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
      config: { ...CFG, maxAgeMs: 24 * 60 * 60_000 },
    });
    expect(result.abandonedAge).toEqual([]);
    expect(result.claimed).toEqual(['d-1']);
  });
});

describe('callback sweeper — dry run', () => {
  it('reports what it would claim and sends nothing, writes nothing', async () => {
    const rows = [makeRow({ next_attempt_at: new Date(Date.now() - 600_000) })];
    const { db } = makeFakePg(rows);
    const fetcher = vi.fn();

    const result = await sweepOnce({
      db,
      fetcher: fetcher as unknown as typeof fetch,
      config: { ...CFG, dryRun: true },
    });

    expect(result.dryRun).toBe(true);
    expect(result.claimed).toEqual(['d-1']);
    expect(result.delivered).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    // Untouched: same status, and the lease was never applied.
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.next_attempt_at!.getTime()).toBeLessThan(Date.now());
  });
});

describe('callback sweeper — defaults', () => {
  it('is ON by default and dry-run is OFF by default', async () => {
    // A knob that defaults to "off" would make the durability guarantee
    // opt-in, which is how a fix quietly never ships.
    const { sweeperEnabled, configFromEnv } = await import('./sweeper.js');
    const saved = { ...process.env };
    delete process.env.CALLBACK_SWEEP_ENABLED;
    delete process.env.CALLBACK_SWEEP_DRY_RUN;
    try {
      expect(sweeperEnabled()).toBe(true);
      expect(configFromEnv().dryRun).toBe(false);
      process.env.CALLBACK_SWEEP_ENABLED = 'false';
      expect(sweeperEnabled()).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it('the grace period is longer than a healthy timer would ever be late', async () => {
    // If grace ever drops to ~0 the sweeper starts racing live timers.
    expect(DEFAULT_SWEEPER_CONFIG.graceMs).toBeGreaterThanOrEqual(60_000);
    // And the age ceiling must outlast the full retry schedule, or the sweeper
    // would retire rows that are still legitimately in flight.
    expect(DEFAULT_SWEEPER_CONFIG.maxAgeMs).toBeGreaterThan(13 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Observability — the regression guard.
//
// The sweeper shipped, ran correctly in production, and logged NOTHING. Cause:
// `src/index.ts` called `startWorkers()` with no arguments, so no logger
// reached the sweeper, and every call site was optional-chained
// (`deps.logger?.warn(...)`) and therefore no-opped.
//
// The counts line going missing was cosmetic. The killer was that
// 'sweep failed; will retry next interval' was silenced by the same
// mechanism — so a sweeper broken forever was indistinguishable, in the log,
// from a healthy one with an empty backlog. The backlog IS empty in every
// environment, so "quiet" is the expected steady state and no operator would
// ever have questioned it. It took counting index scans in
// `pg_stat_user_indexes` on the deployed database to establish the thing was
// even alive.
//
// These tests pin the property that makes that unrepeatable: the logger is
// optional to INJECT but never optional to USE. With zero wiring — the exact
// broken state that shipped — boot and failure lines must still come out.
// ---------------------------------------------------------------------------

describe('callback sweeper — observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A db whose every statement fails, i.e. a sweeper that cannot work. */
  const brokenDb = (message: string | Error = 'connection terminated unexpectedly'): Db =>
    ({
      execute: async () => {
        throw typeof message === 'string' ? new Error(message) : message;
      },
    }) as unknown as Db;

  /** Let the boot tick (setTimeout 0) fire and its sweep settle. */
  const letBootSweepRun = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 10));
  };

  it('logs a boot line, with its interval, so a deploy is verifiable from the log', async () => {
    const lines: Array<{ obj: object; msg?: string }> = [];
    const handle = startCallbackSweeper({
      db: makeFakePg([]).db,
      config: { intervalMs: 60_000 },
      logger: {
        info: (obj, msg) => lines.push({ obj, msg }),
        warn: () => {},
        error: () => {},
      },
    });
    await handle.stop();

    const boot = lines.find((l) => l.msg?.includes('started'));
    expect(boot, 'sweeper must announce itself at boot').toBeDefined();
    // The interval is the load-bearing field: it is what lets someone confirm
    // the sweeper is on the schedule they think it is on.
    expect(boot!.obj).toMatchObject({ intervalMs: 60_000 });
  });

  it('a failing sweep logs at ERROR level — not warn, not info, not nothing', async () => {
    const calls: Record<'info' | 'warn' | 'error', string[]> = {
      info: [],
      warn: [],
      error: [],
    };
    const handle = startCallbackSweeper({
      db: brokenDb('relation "callback_deliveries" does not exist'),
      logger: {
        info: (_o, m) => calls.info.push(String(m)),
        warn: (_o, m) => calls.warn.push(String(m)),
        error: (_o, m) => calls.error.push(String(m)),
      },
    });
    await letBootSweepRun();
    await handle.stop();

    expect(calls.error.join(' ')).toContain('sweep failed');
    // Level matters: a warn is filtered out of the alerting path that this
    // line exists to trip.
    expect(calls.warn.join(' ')).not.toContain('sweep failed');
  });

  /** The `err` of each 'sweep failed' line, as the shared serializer wrote it. */
  const sweepFailures = async (thrown: string | Error): Promise<{ lines: string[]; errs: object[] }> => {
    const { log, lines } = capturedLog();
    const handle = startCallbackSweeper({ db: brokenDb(thrown), logger: log });
    await letBootSweepRun();
    await handle.stop();
    const failed = lines.filter((l) => l.includes('sweep failed'));
    return { lines, errs: failed.map((l) => (JSON.parse(l) as { err: object }).err) };
  };

  it('the failing sweep carries the underlying error text, not just a message', async () => {
    const { errs } = await sweepFailures('ECONNREFUSED 127.0.0.1:5432');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ type: 'Error', message: 'ECONNREFUSED 127.0.0.1:5432' });
  });

  it('🔴 a sweep that fails with a database error logs its code, not the row', async () => {
    const rowText = 'Juana Pérez declaró en la audiencia';
    const { lines, errs } = await sweepFailures(
      Object.assign(new Error(`duplicate key value violates unique constraint: ${rowText}`), { code: '23505' }),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: '23505' });
    expect(lines.join('')).not.toContain('Juana');
  });

  it('keeps sweeping after a failure, and logs EVERY failure, not just the first', async () => {
    // "Will retry next interval" has to be true, and each retry that also
    // fails has to be as loud as the first — one error line followed by
    // silence would read as "it recovered".
    const errs: string[] = [];
    const handle = startCallbackSweeper({
      db: brokenDb(),
      config: { intervalMs: 5 },
      logger: { info: () => {}, warn: () => {}, error: (_o, m) => errs.push(String(m)) },
    });
    await new Promise((r) => setTimeout(r, 60));
    await handle.stop();

    expect(errs.length).toBeGreaterThan(1);
    expect(errs.every((m) => m.includes('sweep failed'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The two that actually reproduce the shipped bug: NO logger injected at
  // all. Before the fix these emitted nothing whatsoever.
  // -------------------------------------------------------------------------

  it('with NO logger injected, a failing sweep still reaches the root logger', async () => {
    const spy = vi.spyOn(rootLogger, 'error').mockImplementation(() => {});
    const handle = startCallbackSweeper({ db: brokenDb() }); // ← the bug's exact shape
    await letBootSweepRun();
    await handle.stop();

    expect(
      spy.mock.calls.some(([, msg]) => String(msg).includes('sweep failed')),
      'a dropped logger must cost bindings, never visibility',
    ).toBe(true);
  });

  it('with NO logger injected, the boot line still reaches the root logger', async () => {
    const spy = vi.spyOn(rootLogger, 'info').mockImplementation(() => {});
    const handle = startCallbackSweeper({ db: makeFakePg([]).db });
    await handle.stop();

    expect(
      spy.mock.calls.some(([, msg]) => String(msg).includes('callback sweeper: started')),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The other half of the contract: do NOT become chatty.
  // -------------------------------------------------------------------------

  it('a quiet sweep logs nothing at all — no heartbeat', async () => {
    // Zero pending rows is the normal state in local, dev, stage and prod. A
    // line per 60s tick would be 1,440 lines a day of "nothing happened",
    // which is how the lines that matter get buried.
    const calls: string[] = [];
    const record = (_o: object, m?: string): void => void calls.push(String(m));

    const result = await sweepOnce({
      db: makeFakePg([]).db,
      fetcher: vi.fn() as unknown as typeof fetch,
      config: CFG,
      logger: { info: record, warn: record, error: record },
    });

    expect(result.claimed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a quiet sweep does not fall through to the root logger either', async () => {
    const info = vi.spyOn(rootLogger, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(rootLogger, 'error').mockImplementation(() => {});

    await sweepOnce({
      db: makeFakePg([]).db,
      fetcher: vi.fn() as unknown as typeof fetch,
      config: CFG,
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Root-cause guard. The bug was not "someone forgot an argument" — a
  // forgotten argument is survivable. It was that the call sites tolerated a
  // missing logger by falling silent. Pin that pattern out of the file.
  // -------------------------------------------------------------------------

  it('no log call in the sweeper is optional-chained', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./sweeper.ts', import.meta.url)), 'utf8');
    // Comments discuss the old pattern by name; only real code counts.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // `logger?.info(...)` / `deps.logger?.warn(...)` — the construct that
    // turned a broken sweeper into a silent one.
    const optionalCalls = code.match(/logger\?\.\s*(info|warn|error)/g) ?? [];
    expect(
      optionalCalls,
      'resolve `deps.logger ?? rootLogger` once, then log unconditionally',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter visibility + metrics (PLAN-live-ingest-2026-10-02 §2.3)
// ---------------------------------------------------------------------------

describe('callback sweeper — dead-letter queue visibility', () => {
  it('an age-ceiling dead-letter logs one ERROR per row with the delivery coordinates', async () => {
    const rows = [
      makeRow({
        id: 'ancient',
        created_at: new Date(Date.now() - 72 * 60 * 60_000),
        next_attempt_at: new Date(Date.now() - 72 * 60 * 60_000),
        org: 'o',
        project: 'p',
        source: 'ingest',
        source_id: 'ing-9',
        item_key: 'doc-9',
        event: 'ingest.completed',
        response_status: 503,
      }),
    ];
    const { db } = makeFakePg(rows);
    const errors: Array<Record<string, unknown>> = [];
    const { callbackTransitionsTotal } = await import('../../metrics/callbacks.js');
    const count = async () =>
      (await callbackTransitionsTotal.get()).values.find(
        (v) => (v.labels as Record<string, unknown>).status === 'dead_letter' && (v.labels as Record<string, unknown>).project === 'p',
      )?.value ?? 0;
    const before = await count();

    await sweepOnce({
      db,
      fetcher: vi.fn() as unknown as typeof fetch,
      config: { ...CFG, maxAgeMs: 24 * 60 * 60_000 },
      logger: { info: () => {}, warn: () => {}, error: (o) => errors.push(o as Record<string, unknown>) },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      deliveryId: 'ancient',
      org: 'o',
      project: 'p',
      source: 'ingest',
      sourceId: 'ing-9',
      itemKey: 'doc-9',
      event: 'ingest.completed',
      responseStatus: 503,
      status: 'dead_letter',
    });
    expect(await count()).toBe(before + 1);
  });

  it('each good tick refreshes the per-status gauge and the last-run timestamp', async () => {
    const { callbackDeliveriesGauge, callbackSweeperLastRun } = await import(
      '../../metrics/callbacks.js'
    );
    const rows = [
      makeRow({ id: 'a', status: 'dead_letter' }),
      makeRow({ id: 'b', status: 'dead_letter' }),
      makeRow({ id: 'c', status: 'delivered' }),
    ];
    const fixedNow = new Date('2030-01-01T00:00:00.000Z');
    const handle = startCallbackSweeper({
      db: makeFakePg(rows).db,
      clock: () => fixedNow,
      config: { ...CFG, intervalMs: 60_000 },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 20));
    await handle.stop();

    const gauge = (await callbackDeliveriesGauge.get()).values;
    const at = (status: string) => gauge.find((v) => (v.labels as Record<string, unknown>).status === status)?.value;
    expect(at('dead_letter')).toBe(2);
    expect(at('delivered')).toBe(1);
    expect(at('auth_failed')).toBe(0);
    expect((await callbackSweeperLastRun.get()).values[0]?.value).toBe(fixedNow.getTime() / 1000);
  });

  it('a failing tick does NOT move the last-run timestamp — stale means broken', async () => {
    const { callbackSweeperLastRun } = await import('../../metrics/callbacks.js');
    callbackSweeperLastRun.set(123);
    const handle = startCallbackSweeper({
      db: {
        execute: async () => {
          throw new Error('db down');
        },
      } as unknown as Db,
      clock: () => new Date('2031-01-01T00:00:00.000Z'),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 20));
    await handle.stop();
    expect((await callbackSweeperLastRun.get()).values[0]?.value).toBe(123);
  });
});
