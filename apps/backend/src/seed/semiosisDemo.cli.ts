/**
 * Entry point for the Semiosis demo. See `seed/semiosisDemo.ts`.
 *
 *     pnpm --filter @edc/backend seed:semiosis-demo                         # seed / finish
 *     SEMIOSIS_DEMO_RETRY=1  pnpm --filter @edc/backend seed:semiosis-demo  # also retry failed ingests (re-runs the gate)
 *     SEMIOSIS_DEMO_REMOVE=1 pnpm --filter @edc/backend seed:semiosis-demo  # delete the seed's essays only
 *
 * A dedicated file with top-level await, for the same two reasons as
 * `seed/demo.cli.ts`: `payload run` rewrites argv and exits as soon as the
 * import resolves. (That argv rewrite is why removal is an env flag first;
 * `-- --remove` is honoured only if it survives.)
 *
 * ── 🔴 OPERATOR STEPS ON DEV ────────────────────────────────────────────────
 *
 * 1. BEFORE RUNNING, read the dev roster, read-only, and confirm the nine
 *    emails belong to seeded accounts only (nobody real signed up with them):
 *
 *        SELECT id, email, display_name FROM users
 *         WHERE email LIKE 'estudiante%@ecosistemas.test' ORDER BY email;
 *        SELECT m.user_id, u.email, m.organization_id, m.role, m.is_active
 *          FROM memberships m JOIN users u ON u.id = m.user_id
 *         WHERE u.email LIKE 'estudiante%@ecosistemas.test' ORDER BY u.email, m.organization_id;
 *
 *    Expected: at most estudiante1..9, memberships only in ecosistema 8 as
 *    `estudiante`. Anything else: stop and ask.
 *
 * 2. Run INSIDE the dev backend container (its DATABASE_URL, ai-service keys,
 *    PUBLIC_BACKEND_URL / CALLBACK_SECRET and detector), with:
 *
 *    · DEMO_USERS_FILE=<a writable path in the container>, e.g.
 *      /tmp/.env.demo-users. The default (~/chamba/cide/…) does not
 *      exist there and the seed refuses.
 *    · the in-process janitors OFF, so this process does not sweep rows the
 *      running server owns (lib/janitorScheduler.ts and siblings):
 *        EMBEDDING_JANITOR_ENABLED=0 PUBLISH_JANITOR_ENABLED=0
 *        TRANSCRIPTION_JANITOR_ENABLED=0 INGEST_RECOVERY_JANITOR_ENABLED=0
 *        SESSION_JANITOR_ENABLED=0
 *
 * 3. Copy the credentials file out and MERGE it into
 *    ~/chamba/cide/.env.demo-users — key by key, newer lines win.
 *    🔴 NEVER copy it over that file: the container's file holds only this
 *    run's ESTUDIANTE1..9 lines, and overwriting wipes the existing
 *    ESTUDIANTE1/2 passwords and the INVESTIGADOR_* lines. (A run whose file
 *    was absent writes no password for ESTUDIANTE1/2 — they keep theirs.)
 *
 * 4. Read the TOTAL line. "not finished" → wait a few minutes and run step 2
 *    again. Failed ingests are reported, not retried; fix the cause, then run
 *    once with SEMIOSIS_DEMO_RETRY=1.
 *
 * Removal (after the demo, if the owner wants the essays out of the shared
 * corpus): step 2's container and janitor settings, SEMIOSIS_DEMO_REMOVE=1.
 * It prints counts only.
 */
import { runSemiosisDemoCli } from './semiosisDemo'

await runSemiosisDemoCli()
