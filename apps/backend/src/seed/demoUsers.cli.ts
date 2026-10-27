/**
 * Entry point for the dev demo accounts. See `seed/demoUsers.ts`.
 *
 *     pnpm --filter @edc/backend seed:demo-users
 *
 * A dedicated file with top-level await, for the same two reasons as
 * `seed/demo.cli.ts`: `payload run` rewrites argv and exits as soon as the
 * import resolves.
 */
import { runDemoUsersCli } from './demoUsers'

await runDemoUsersCli()
