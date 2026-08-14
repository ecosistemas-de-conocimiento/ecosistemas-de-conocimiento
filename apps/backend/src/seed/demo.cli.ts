/**
 * Runnable entry point for the MANUAL demo seed.
 *
 *     pnpm seed:demo          # => payload run src/seed/demo.cli.ts
 *
 * ── 🔴 Why this is a SEPARATE FILE, and not `if (isDirectRun) main()` in
 *    `demo.ts` ───────────────────────────────────────────────────────────────
 *
 * It used to be exactly that, and it silently did NOTHING. Two independent
 * defects in the interaction with `payload run` (measured against
 * `payload@3.84.1`, `node_modules/payload/dist/bin/index.js`):
 *
 *   1. `payload run <script>` REWRITES `process.argv` before importing the
 *      script, and leaves `argv[1]` pointing at Payload's own bin. The old
 *      self-execution test compared `import.meta.url` against
 *      `pathToFileURL(process.argv[1])`, so it was ALWAYS false under the very
 *      command the docs told people to use. `main()` never fired.
 *   2. Even with that fixed, `payload run` calls `process.exit(0)` as soon as
 *      the dynamic `import()` RESOLVES. A `void main()` launched at module scope
 *      is not awaited, so the process would be killed at `main()`'s first
 *      `await`.
 *
 * The combination was worse than a no-op. `payload run src/seed/demo.ts` on
 * PRODUCTION printed nothing and exited **0** — so a wrapper doing
 * `payload run … && echo seeded` reported success from a gate that had never
 * run. A security gate that returns a false success is worse than no gate.
 *
 * Both defects are fixed by the two properties of this file:
 *
 *   - It is a DEDICATED entry point that nothing imports, so it is free to have
 *     side effects at module scope. `demo.ts` cannot: `payload.config.ts`
 *     imports it for the boot seed, and a side-effecting import there would run
 *     the CLI on every boot.
 *   - It uses TOP-LEVEL AWAIT. `payload run` awaits the module's evaluation
 *     (`await import(...)`), so the seed completes before Payload's
 *     `process.exit(0)` — and a refusal's own `process.exit(1)` wins, which is
 *     what makes the "refuses loudly" contract true.
 *
 * Works identically under `tsx src/seed/demo.cli.ts`.
 */
import { runDemoSeedCli } from './demo'

await runDemoSeedCli()
