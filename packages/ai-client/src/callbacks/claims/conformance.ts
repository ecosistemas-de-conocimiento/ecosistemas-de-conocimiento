/**
 * Conformance cases for the callback claim ledger — run them against YOUR
 * table, through YOUR pool, in your receiver's integration suite.
 *
 * Same idea as `CALLBACK_VERIFIER_CONFORMANCE_CASES` in
 * `@edc/ai-client/callbacks`: two receivers each carried a copy of
 * this ledger, the copies drifted (one app fixed findStuck, the other
 * never got it), and nothing checked. These cases are the check. They pin
 * the contract's §Idempotency items 1-7 against a real database, so they also
 * catch what a unit test cannot: a lost unique index, a wrong enum, a column
 * that went NOT NULL.
 *
 * ```ts
 * import { CALLBACK_CLAIMS_CONFORMANCE_CASES } from '@edc/ai-client/callbacks/claims'
 * import { claims } from '@/lib/aiService/callbackDedupe'   // your createCallbackClaims(...) instance
 *
 * it.each(CALLBACK_CLAIMS_CONFORMANCE_CASES)('$name', (c) => c.run({ claims, pool }))
 * ```
 *
 * Framework-free: each case is an async function that throws
 * `CallbackClaimsConformanceError` on failure.
 *
 * ⚠ Run against a TEST database. Cases insert rows under unique
 * `conformance-…` source ids, backdate some of them to 1999, and mark every
 * row they leave unfinished as `done` on the way out so `findStuck` stays
 * quiet. The `findStuck` cases assume no OTHER unfinished row in the table is
 * older than 1999-01-01.
 */

import type { CallbackClaims } from './claims.js';
import type { CallbackNaturalKey, FinishExtraColumn, QueryablePool } from './types.js';

export class CallbackClaimsConformanceError extends Error {
  override name = 'CallbackClaimsConformanceError';
}

export type CallbackClaimsConformanceContext = {
  /** Your `createCallbackClaims(...)` instance — the one your receiver uses. */
  claims: CallbackClaims<Record<string, FinishExtraColumn>>;
  /** A pool with more than one connection, so the concurrency cases really race. */
  pool: QueryablePool;
  /** Value for the `source` column. Default `'ingest'`. */
  source?: string;
  /** Extras to pass to `finish` per terminal state, when your table needs them (e.g. a NOT NULL audit column). */
  extras?: Partial<Record<'done' | 'error', Record<string, unknown>>>;
};

export type CallbackClaimsConformanceCase = {
  name: string;
  run: (ctx: CallbackClaimsConformanceContext) => Promise<void>;
};

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CallbackClaimsConformanceError(message);
}

let counter = 0;
const key = (ctx: CallbackClaimsConformanceContext, tag: string, over: Partial<CallbackNaturalKey> = {}) => ({
  source: ctx.source ?? 'ingest',
  sourceId: `conformance-${tag}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  itemKey: '',
  event: 'ingest.completed',
  ...over,
});

const t = (ctx: CallbackClaimsConformanceContext) => `"${ctx.claims.config.table}"`;
const s = (ctx: CallbackClaimsConformanceContext) => `"${ctx.claims.config.stateColumn}"`;

async function finish(
  ctx: CallbackClaimsConformanceContext,
  claim: { rowId: number | null; claimedAt: Date | null },
  state: 'done' | 'error',
  detail?: string,
): Promise<boolean> {
  return ctx.claims.finish(ctx.pool, claim, { state, detail, extras: ctx.extras?.[state] } as never);
}

async function readRow(ctx: CallbackClaimsConformanceContext, id: number) {
  const rs = await ctx.pool.query<{ state: string | null; attempts: number | null; detail: string | null }>(
    `SELECT ${s(ctx)} AS state, attempts::int AS attempts, detail FROM ${t(ctx)} WHERE id = $1::int`,
    [id],
  );
  check(rs.rows[0], `row ${id} vanished`);
  return rs.rows[0];
}

/** Move a row's clocks. `claimedAt: null` writes NULL; `fallback` sets received_at and created_at. */
async function backdate(
  ctx: CallbackClaimsConformanceContext,
  id: number,
  claimedAt: string | null,
  fallback?: string,
): Promise<void> {
  await ctx.pool.query(
    fallback === undefined
      ? `UPDATE ${t(ctx)} SET claimed_at = $2::timestamptz WHERE id = $1::int`
      : `UPDATE ${t(ctx)} SET claimed_at = $2::timestamptz,
                              received_at = $3::timestamptz,
                              created_at = $3::timestamptz WHERE id = $1::int`,
    fallback === undefined ? [id, claimedAt] : [id, claimedAt, fallback],
  );
}

/** Leave nothing unfinished behind, so findStuck in later runs sees only its own rows. */
async function settle(ctx: CallbackClaimsConformanceContext, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await ctx.pool.query(`UPDATE ${t(ctx)} SET ${s(ctx)} = 'done' WHERE id = ANY($1::int[])`, [ids]);
}

async function claimOk(ctx: CallbackClaimsConformanceContext, k: CallbackNaturalKey, body = '{}') {
  const c = await ctx.claims.claim(ctx.pool, k, body);
  check(c.claimed && c.rowId !== null && c.claimedAt !== null, `expected a claim, got ${JSON.stringify(c)}`);
  return c as typeof c & { rowId: number; claimedAt: Date };
}

async function expectPoolError(what: string, fn: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  let result: unknown;
  try {
    result = await fn();
  } catch (e) {
    thrown = e;
  }
  check(thrown !== undefined, `${what} without a pool returned ${JSON.stringify(result)} instead of throwing`);
  check(
    (thrown as Error).name === 'CallbackClaimsPoolError',
    `${what} without a pool threw ${(thrown as Error).name}, want CallbackClaimsPoolError`,
  );
}

export const CALLBACK_CLAIMS_CONFORMANCE_CASES: readonly CallbackClaimsConformanceCase[] = [
  {
    name: 'a missing pool THROWS — there is no degraded mode that dispatches undeduped',
    async run(ctx) {
      const k = key(ctx, 'nopool');
      for (const missing of [null, undefined, {}]) {
        await expectPoolError('claim', () => ctx.claims.claim(missing as never, k, '{}'));
        await expectPoolError('finish', () =>
          ctx.claims.finish(missing as never, { rowId: 1, claimedAt: new Date() }, { state: 'done' } as never),
        );
        await expectPoolError('findStuck', () => ctx.claims.findStuck(missing as never));
      }
      // And nothing was written for that key through the real pool either.
      const rs = await ctx.pool.query(`SELECT 1 FROM ${t(ctx)} WHERE source_id = $1::varchar`, [k.sourceId]);
      check(rs.rows.length === 0, 'a pool-less claim left a row behind');
    },
  },
  {
    name: 'a fresh claim lands IN PROGRESS, not done',
    async run(ctx) {
      const c = await claimOk(ctx, key(ctx, 'fresh'));
      check(c.reason === 'fresh' && c.attempts === 1, `fresh claim: ${JSON.stringify(c)}`);
      const row = await readRow(ctx, c.rowId);
      check(row.state === 'in_progress', `state after claim is ${row.state}, want in_progress`);
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'SUCCESS is terminal: a finished delivery is never re-claimed',
    async run(ctx) {
      const k = key(ctx, 'done');
      const c = await claimOk(ctx, k);
      check(await finish(ctx, c, 'done'), 'finish(done) was fenced out on a live claim');
      const again = await ctx.claims.claim(ctx.pool, k, '{}');
      check(!again.claimed && again.reason === 'duplicate', `re-delivery after done: ${JSON.stringify(again)}`);
    },
  },
  {
    name: 'SUCCESS stays terminal even with a ZERO lease and an ancient claimed_at',
    async run(ctx) {
      const k = key(ctx, 'done-old');
      const c = await claimOk(ctx, k);
      await finish(ctx, c, 'done');
      await backdate(ctx, c.rowId, '1999-01-01T00:00:00Z');
      const again = await ctx.claims.claim(ctx.pool, k, '{}', { leaseMs: 0 });
      check(!again.claimed && again.reason === 'duplicate', `old done row re-claimed: ${JSON.stringify(again)}`);
    },
  },
  {
    name: 'a legacy row with a NULL state is NOT reclaimable (allow-list, not deny-list)',
    async run(ctx) {
      const k = key(ctx, 'legacy');
      const c = await claimOk(ctx, k);
      await ctx.pool.query(`UPDATE ${t(ctx)} SET ${s(ctx)} = NULL WHERE id = $1::int`, [c.rowId]);
      await backdate(ctx, c.rowId, '1999-01-01T00:00:00Z');
      const again = await ctx.claims.claim(ctx.pool, k, '{}', { leaseMs: 0 });
      check(!again.claimed && again.reason === 'duplicate', `NULL-state row re-claimed: ${JSON.stringify(again)}`);
    },
  },
  {
    name: 'an unrecognised state is NOT reclaimable',
    async run(ctx) {
      const k = key(ctx, 'unknown');
      const c = await claimOk(ctx, k);
      await ctx.pool.query(`UPDATE ${t(ctx)} SET ${s(ctx)} = 'archived' WHERE id = $1::int`, [c.rowId]);
      await backdate(ctx, c.rowId, '1999-01-01T00:00:00Z');
      const again = await ctx.claims.claim(ctx.pool, k, '{}', { leaseMs: 0 });
      check(!again.claimed, `unknown-state row re-claimed: ${JSON.stringify(again)}`);
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'FAILURE is re-claimable: a retry genuinely re-runs the work',
    async run(ctx) {
      const k = key(ctx, 'error');
      const c = await claimOk(ctx, k);
      check(await finish(ctx, c, 'error', 'boom'), 'finish(error) was fenced out on a live claim');
      const again = await claimOk(ctx, k);
      check(again.reason === 'reclaimed_error', `reason ${again.reason}, want reclaimed_error`);
      check(again.rowId === c.rowId && again.attempts === 2, `attempts ${again.attempts}, want 2 on the same row`);
      const row = await readRow(ctx, again.rowId);
      check(row.state === 'in_progress', `state ${row.state} after reclaim`);
      check(row.detail === null, 'the previous attempt detail lingers after reclaim');
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'a LIVE claim holds off a concurrent delivery',
    async run(ctx) {
      const k = key(ctx, 'live');
      const c = await claimOk(ctx, k);
      const second = await ctx.claims.claim(ctx.pool, k, '{}');
      check(!second.claimed && second.reason === 'in_flight', `second delivery: ${JSON.stringify(second)}`);
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'an in-progress row is re-claimed once its lease expires',
    async run(ctx) {
      const k = key(ctx, 'stale');
      const c = await claimOk(ctx, k);
      await backdate(ctx, c.rowId, new Date(Date.now() - ctx.claims.config.leaseMs - 60_000).toISOString());
      const again = await claimOk(ctx, k);
      check(again.reason === 'reclaimed_stale' && again.attempts === 2, `stale reclaim: ${JSON.stringify(again)}`);
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'the fence stops a zombie stamping done OR error over a live re-claim',
    async run(ctx) {
      const k = key(ctx, 'fence');
      const first = await claimOk(ctx, k);
      const stale = '1999-01-01T00:00:00.000Z';
      await backdate(ctx, first.rowId, stale);
      const zombie = { rowId: first.rowId, claimedAt: new Date(stale) };
      const live = await claimOk(ctx, k);
      check(live.reason === 'reclaimed_stale', `reason ${live.reason}, want reclaimed_stale`);
      check(!(await finish(ctx, zombie, 'done')), 'a zombie stamped done over a live claim');
      check(!(await finish(ctx, zombie, 'error', 'late')), 'a zombie stamped error over a live claim');
      check((await readRow(ctx, live.rowId)).state === 'in_progress', 'the live claim lost its state');
      check(await finish(ctx, live, 'done'), 'the live owner was fenced out');
    },
  },
  {
    name: 'concurrent claims of the same delivery — exactly one wins',
    async run(ctx) {
      const k = key(ctx, 'race');
      const results = await Promise.all(Array.from({ length: 8 }, () => ctx.claims.claim(ctx.pool, k, '{}')));
      const winners = results.filter((r) => r.claimed);
      check(winners.length === 1, `${winners.length} concurrent claims won, want exactly 1`);
      await settle(ctx, [winners[0]!.rowId!]);
    },
  },
  {
    name: 'concurrent RE-claims of a failed delivery — exactly one wins',
    async run(ctx) {
      const k = key(ctx, 'rerace');
      const c = await claimOk(ctx, k);
      await finish(ctx, c, 'error', 'boom');
      const results = await Promise.all(Array.from({ length: 8 }, () => ctx.claims.claim(ctx.pool, k, '{}')));
      const winners = results.filter((r) => r.claimed);
      check(winners.length === 1, `${winners.length} concurrent re-claims won, want exactly 1`);
      check(winners[0]!.reason === 'reclaimed_error', `winner reason ${winners[0]!.reason}`);
      await settle(ctx, [c.rowId]);
    },
  },
  {
    name: 'batch-level events dedupe on an EMPTY item key',
    async run(ctx) {
      const k = key(ctx, 'batch', { itemKey: '', event: 'ingest.batch_completed' });
      const c = await claimOk(ctx, k);
      await finish(ctx, c, 'done');
      const again = await ctx.claims.claim(ctx.pool, { ...k }, '{}');
      check(again.reason === 'duplicate', `batch re-delivery: ${again.reason}`);
    },
  },
  {
    name: 'a different event or item key on the same delivery is a separate claim',
    async run(ctx) {
      const k = key(ctx, 'separate', { itemKey: 'doc-1' });
      const a = await claimOk(ctx, k);
      const b = await claimOk(ctx, { ...k, event: 'ingest.failed' });
      const c = await claimOk(ctx, { ...k, itemKey: 'doc-2' });
      check(new Set([a.rowId, b.rowId, c.rowId]).size === 3, 'distinct natural keys shared a row');
      await settle(ctx, [a.rowId, b.rowId, c.rowId]);
    },
  },
  {
    name: 'findStuck surfaces BOTH stranded in_progress and error rows, never done or fresh ones',
    async run(ctx) {
      const tag = key(ctx, 'stuck').sourceId;
      const ids: number[] = [];
      try {
        const make = async (suffix: string) => {
          const c = await claimOk(ctx, { ...key(ctx, 'x'), sourceId: `${tag}-${suffix}` }, `{"n":"${suffix}"}`);
          ids.push(c.rowId);
          return c;
        };
        const stranded = await make('stranded');
        const failed = await make('failed');
        const done = await make('done');
        const fresh = await make('fresh');
        await finish(ctx, failed, 'error', 'boom');
        await finish(ctx, done, 'done');
        for (const c of [stranded, failed, done]) await backdate(ctx, c.rowId, '1999-01-01T00:00:00Z');

        const found = (await ctx.claims.findStuck(ctx.pool, { limit: 10_000 })).filter((r) =>
          r.sourceId.startsWith(tag),
        );
        const byId = new Map(found.map((r) => [r.id, r]));
        check(byId.get(stranded.rowId)?.claimState === 'in_progress', 'a stranded in_progress row is invisible');
        check(byId.get(failed.rowId)?.claimState === 'error', 'an error row is invisible (the 2026-09-02 loss)');
        check(!byId.has(done.rowId), 'findStuck listed a done row');
        check(!byId.has(fresh.rowId), 'findStuck listed a claim still inside its lease');
        check(byId.get(stranded.rowId)?.rawBody === '{"n":"stranded"}', 'the raw body was not kept for replay');
      } finally {
        await settle(ctx, ids);
      }
    },
  },
  {
    name: 'findStuck orders by the age it filters on — a NULL claimed_at is neither truncated nor "oldest"',
    async run(ctx) {
      const tag = key(ctx, 'order').sourceId;
      const ids: number[] = [];
      try {
        const make = async (suffix: string) => {
          const c = await claimOk(ctx, { ...key(ctx, 'x'), sourceId: `${tag}-${suffix}` });
          ids.push(c.rowId);
          return c;
        };
        // Ages: B (00:05) < A (no claimed_at, received 00:10) < C (00:20).
        const a = await make('a');
        const b = await make('b');
        const c = await make('c');
        await backdate(ctx, a.rowId, null, '1990-01-01T00:10:00Z');
        await backdate(ctx, b.rowId, '1990-01-01T00:05:00Z', '1990-01-01T00:00:00Z');
        await backdate(ctx, c.rowId, '1990-01-01T00:20:00Z', '1990-01-01T00:00:00Z');

        const top = await ctx.claims.findStuck(ctx.pool, { limit: 2 });
        check(
          top.length === 2 && top[0]!.id === b.rowId && top[1]!.id === a.rowId,
          `oldest-first batch of 2 is [${top.map((r) => r.sourceId).join(', ')}], want [${tag}-b, ${tag}-a]`,
        );
      } finally {
        await settle(ctx, ids);
      }
    },
  },
];
