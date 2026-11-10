import { JANITORS_DISABLED_VAR } from '../janitorScheduler'

/** For a janitor's own test: let it arm in this file (`vitest.setup.ts` turns them all off). */
export function allowJanitors(): void {
  delete process.env[JANITORS_DISABLED_VAR]
}
