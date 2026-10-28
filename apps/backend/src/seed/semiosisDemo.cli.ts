/**
 * Entry point for the Semiosis demo. See `seed/semiosisDemo.ts`.
 *
 *     pnpm --filter @edc/backend seed:semiosis-demo
 *
 * A dedicated file with top-level await, for the same two reasons as
 * `seed/demo.cli.ts`: `payload run` rewrites argv and exits as soon as the
 * import resolves.
 */
import { runSemiosisDemoCli } from './semiosisDemo'

await runSemiosisDemoCli()
