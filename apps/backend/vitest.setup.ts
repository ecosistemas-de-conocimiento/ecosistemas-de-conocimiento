/**
 * 🔴 EVERY JANITOR IS OFF IN A TEST RUN UNLESS THE TEST TURNS IT ON.
 *
 * Files that boot Payload with `getPayload` directly (not `bootPayload`) used
 * to arm whatever janitor was on by default; since the first sweep runs 2 min
 * after boot (`lib/janitorScheduler.ts`), a slow file would sweep its own
 * database. A janitor's own test calls `allowJanitors()` (`lib/testing/janitors.ts`).
 * `lib/janitorsOffInTests.pg.test.ts` fails if this goes.
 */
import { JANITORS_DISABLED_VAR } from './src/lib/janitorScheduler'

process.env[JANITORS_DISABLED_VAR] = '1'
