/**
 * ONE-OFF: set `held_text` (and `held_text_hash`) to NULL on `content` holds
 * from before P-01 whose model never ran ("La revisión automática no pudo
 * terminar…"): they still store stage 2's near-raw text. Logic, selection and
 * guards: `src/lib/clearLegacyHeldText.ts`.
 *
 * 🔴 DRY RUN BY DEFAULT: lists ids and the count, never any text. Writes only
 * with HELD_TEXT_CLEAR_APPLY=1. No model, no ai-service, no Payload hooks.
 * 🔴 Never ecosistema 8, never a row held for consent.
 *
 * Run on dev AFTER the deploy that carries this file, inside the backend
 * container, with the Payload binary (never `pnpm` in the image,
 * `docs/05-infraestructura/despliegue-y-runbook.md` §6.6). `<backend>` is the
 * dev backend container's name (`docker ps`).
 *
 *     # 1. dry run (default): ids and count
 *     docker exec -w /repo/apps/backend <backend> \
 *       node_modules/.bin/payload run scripts/clear-legacy-held-text.ts
 *     # one ecosistema only
 *     docker exec -w /repo/apps/backend -e HELD_TEXT_CLEAR_ORG=6 <backend> \
 *       node_modules/.bin/payload run scripts/clear-legacy-held-text.ts
 *     # 2. apply
 *     docker exec -w /repo/apps/backend -e HELD_TEXT_CLEAR_APPLY=1 <backend> \
 *       node_modules/.bin/payload run scripts/clear-legacy-held-text.ts
 *
 * Env (not flags: `payload run` does not reliably forward argv):
 *   HELD_TEXT_CLEAR_APPLY=1   write. Anything else is a dry run.
 *   HELD_TEXT_CLEAR_ORG=<id>  only this ecosistema (8 is still excluded).
 * plus the backend's usual DATABASE_URI.
 */

import { clearLegacyHeldText } from '../src/lib/clearLegacyHeldText'
import { errSummary } from '../src/lib/errorSummary'

async function main(): Promise<void> {
  const apply = process.env.HELD_TEXT_CLEAR_APPLY === '1'
  const org = process.env.HELD_TEXT_CLEAR_ORG?.trim()
  if (org && !/^\d+$/.test(org)) throw new Error('HELD_TEXT_CLEAR_ORG must be a number')

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  const db = (payload.db as unknown as { drizzle: Parameters<typeof clearLegacyHeldText>[0] }).drizzle

  console.log(`[clear-legacy-held-text] mode=${apply ? 'APPLY' : 'dry-run'}${org ? ` org=${org}` : ''}`)
  const report = await clearLegacyHeldText(db, {
    apply,
    ...(org ? { organizationId: Number(org) } : {}),
    log: (line) => console.log(`[clear-legacy-held-text] ${line}`),
  })
  console.log(
    `[clear-legacy-held-text] ${JSON.stringify({ selected: report.ids.length, cleared: report.cleared, ids: report.ids })}`,
  )
  if (!apply && report.ids.length > 0) {
    console.log('[clear-legacy-held-text] dry run — nothing written. Re-run with HELD_TEXT_CLEAR_APPLY=1 to clear them.')
  }
}

// `payload run` awaits only the import; top-level await keeps it alive.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[clear-legacy-held-text] failed:', errSummary(err))
  process.exit(1)
}
