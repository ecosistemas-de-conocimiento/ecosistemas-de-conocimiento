// set-budget.ts — provision / change an org's explicit USD budget cap.
//
// ADR-0003 D5: ai-service is FAIL-CLOSED. An org with no `budget_state` row
// cannot spend (generation 402s with "no budget configured"). This is the ONLY
// mechanism that lifts that gate, and the only money ceiling the platform has —
// the consuming app does not meter spend. Caps are changeable here WITHOUT a
// deploy: just run this script against the target env's DATABASE_URL.
//
// `--org` is the tenant slug the API key resolves to (see `API_KEYS` in
// `.env.example`). One row per org; projects inside an org share the cap.
//
// Usage:
//   # explicit org + cap (USD):
//   DATABASE_URL=… pnpm --filter @edc/ai-service set-budget -- --org edc --limit 25
//
//   # also reset the live remaining to the new cap (default: keep remaining,
//   # only move the limit — pass --refill to top the counter back up):
//   DATABASE_URL=… pnpm --filter @edc/ai-service set-budget -- --org edc --limit 25 --refill
//
//   # inspect without writing:
//   DATABASE_URL=… pnpm --filter @edc/ai-service set-budget -- --org edc --show
//
// Behaviour:
//   - Upserts the `budget_state` row for `--org`. Idempotent: re-running with
//     the same cap is a no-op on the limit.
//   - On INSERT: limit = remaining = cap, `next_reset_at` stamped from the
//     default monthly-anniversary cadence so the lazy-reset path has an anchor.
//   - On UPDATE: limit := cap. remaining is left ALONE (so you don't
//     accidentally hand an org free spend by lowering its cap) UNLESS --refill,
//     which clamps remaining up to the new cap.
//   - prod is intentionally left UNSET by the rollout — fail-closed. Run this
//     for prod only when you've decided the prod ceiling (see ADR-0003 S1).
//
// Exit codes: 0 success, 1 bad args / DB error.

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { computeNextResetAt } from '../src/services/budget/reset.js';

// Connect straight from DATABASE_URL — deliberately NOT through
// `src/db/client.ts`, which pulls in `config/env.ts` and would force the
// operator to also set REDIS_URL etc. just to change a budget. This script
// only needs Postgres.
function makeClient(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Missing DATABASE_URL env var (the target env\'s Postgres).');
    process.exit(1);
  }
  return postgres(url, { max: 1 });
}

interface Args {
  org?: string;
  limitUsd?: number;
  refill: boolean;
  show: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { refill: false, show: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--org') out.org = argv[++i];
    else if (a === '--limit') out.limitUsd = Number(argv[++i]);
    else if (a === '--refill') out.refill = true;
    else if (a === '--show') out.show = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org) {
    console.error('Missing --org <org>. See header for usage.');
    process.exit(1);
  }
  if (!args.show) {
    if (args.limitUsd === undefined || !Number.isFinite(args.limitUsd) || args.limitUsd < 0) {
      console.error('Missing/invalid --limit <usd> (a non-negative number). Use --show to inspect.');
      process.exit(1);
    }
  }

  const client = makeClient();
  const db = drizzle(client);
  try {
    if (args.show) {
      const rows = await db.execute(sql`
        SELECT "org", "limit_usd", "remaining_usd", "next_reset_at"
        FROM "budget_state" WHERE "org" = ${args.org} LIMIT 1
      `);
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      if (list.length === 0) {
        console.log(`org "${args.org}": NO budget configured (fail-closed — generation 402s).`);
      } else {
        console.log(`org "${args.org}":`, list[0]);
      }
      return;
    }

    const cap = args.limitUsd!;
    const nextReset = computeNextResetAt(new Date(), 'monthly_anniversary', 1, 'UTC');
    const nextResetIso = nextReset ? nextReset.toISOString() : null;

    // Upsert. On conflict we set the limit and (only with --refill) clamp
    // remaining up to the new cap. `remaining` is never silently increased
    // otherwise — lowering a cap must not refund spend.
    const remainingClause = args.refill
      ? sql`LEAST(${cap}::numeric, ${cap}::numeric)` // == cap; explicit for clarity
      : sql`LEAST("budget_state"."remaining_usd", ${cap}::numeric)`;

    await db.execute(sql`
      INSERT INTO "budget_state" ("org", "limit_usd", "remaining_usd", "next_reset_at")
      VALUES (${args.org}, ${cap}::numeric, ${cap}::numeric, ${nextResetIso}::timestamptz)
      ON CONFLICT ("org") DO UPDATE
        SET "limit_usd" = ${cap}::numeric,
            "remaining_usd" = ${remainingClause},
            "updated_at" = now()
    `);

    const after = await db.execute(sql`
      SELECT "org", "limit_usd", "remaining_usd" FROM "budget_state" WHERE "org" = ${args.org} LIMIT 1
    `);
    const list = Array.isArray(after) ? after : (after as { rows?: unknown[] }).rows ?? [];
    console.log(`Provisioned budget for org "${args.org}":`, list[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('set-budget failed:', err);
  process.exit(1);
});
