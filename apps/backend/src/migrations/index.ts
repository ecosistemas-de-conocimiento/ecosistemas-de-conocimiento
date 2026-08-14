import type { MigrateUpArgs, MigrateDownArgs } from '@payloadcms/db-postgres'

/**
 * ⚠ EMPTY ON PURPOSE. There is no baseline migration yet.
 *
 * Read `./README.md` before adding one — generating the first baseline is a
 * one-time decision that also flips this app from schema-push to
 * migrations-only, and doing half of that leaves an environment with no schema.
 *
 * The type import above is deliberate too: it keeps the migration signature in
 * scope so the first generated file drops in without an import fight.
 */
export const migrations: Array<{
  up: (args: MigrateUpArgs) => Promise<void>
  down: (args: MigrateDownArgs) => Promise<void>
  name: string
}> = []
