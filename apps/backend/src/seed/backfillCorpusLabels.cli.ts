/**
 * Runnable entry point for the one-off corpus-label backfill.
 *
 *     pnpm exec payload run src/seed/backfillCorpusLabels.cli.ts -- --organization=1
 *     pnpm exec payload run src/seed/backfillCorpusLabels.cli.ts -- --organization=1 --apply
 *
 * 🔴 A SEPARATE FILE WITH TOP-LEVEL AWAIT, for the two reasons `seed/demo.cli.ts`
 * documents at length and which cost a session to find: `payload run` rewrites
 * `process.argv` (so an `import.meta.url === argv[1]` self-execution test is
 * always false), and it calls `process.exit(0)` the moment the dynamic import
 * RESOLVES (so a `void main()` dies at its first `await`). Both defects are
 * silent and both report success. Read that file before changing the shape of
 * this one.
 *
 * 🔴 THE `--` IS NOT OPTIONAL AND IT IS NOT COSMETIC. `payload run` consumes
 * every argument that is not behind it. Measured on `payload@3.88.0`:
 *
 *     payload run …cli.ts --organization=1     → argv = [node, payload/bin.js]
 *     payload run …cli.ts -- --organization=1  → argv = [node, payload/bin.js,
 *                                                        '--organization=1']
 *
 * So without it the flags are gone before this file is imported, and
 * `argv[1]` still points at Payload's own bin either way. `parseBackfillArgs`
 * therefore refuses rather than defaulting, and its message names this as the
 * likely cause — a script that quietly ran against the wrong ecosistema because
 * a flag evaporated is the failure this shape exists to make impossible.
 *
 * ⚠ Under plain `tsx src/seed/backfillCorpusLabels.cli.ts --organization=1` the
 * flags arrive normally and the `--` is harmless.
 */
import { getPayload } from 'payload'

import config from '../payload.config'
import { backfillCorpusLabels, parseBackfillArgs } from './backfillCorpusLabels'

const parsed = parseBackfillArgs(process.argv.slice(2))
if ('error' in parsed) {
  console.error(`[backfill-labels] ${parsed.error}`)
  process.exit(1)
}

const payload = await getPayload({ config })
const result = await backfillCorpusLabels(payload, parsed)
// ⚠ Exit 1 when the script could not do its job at all, so a wrapper cannot
// read "no corpus to read" as "nothing needed doing".
if (result === null) process.exit(1)
