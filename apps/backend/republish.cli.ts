/**
 * ONE-OFF: re-drive the publications the corpus seed left stranded.
 *
 * The seed fanned 285 publishes out at concurrency and ai-service refused most
 * of them (its `/v1` bucket is 100/min and — see `server-limits.ts` — keyed on
 * IP rather than API key, so every consumer shares it). Nothing retried, so 145
 * documents sat in `publishing` and 118 never left `draft`.
 *
 * This walks them SEQUENTIALLY with a pause between each, which is the whole
 * point: the failure was concurrency, not volume.
 *
 * ⚠ SAFE TO RE-RUN. ai-service's ingest is idempotent on `(corpus, externalId)`
 * — a repeat replaces the document's chunks rather than duplicating them — and
 * `beginPublish` re-reads the row each time.
 *
 * 🔴 IT DOES NOT TOUCH A HELD TESTIMONY. `corpusTextFor` refuses a gated row
 * whose scrub has not cleared, so those come back as `NotPublishableError` and
 * are counted as skipped. That is the anonymisation gate working; releasing one
 * is a human decision made through the review screen, never a batch script.
 *
 *     payload run republish.cli.ts
 *     REPUBLISH_DELAY_MS=2500 REPUBLISH_LIMIT=20 payload run republish.cli.ts
 */
import { getPayload } from 'payload'
import config from '@payload-config'

import { getAdminAIClient } from '@/lib/aiClient'
import { ingestCallbackUrl } from '@/lib/callbackConfig'
import { beginPublish, NotPublishableError } from '@/lib/publishDocument'

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = raw && raw.trim() ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** ~24/min. Under the 100/min bucket with room for the gate and the graph. */
const DELAY_MS = intEnv('REPUBLISH_DELAY_MS', 2500)
const LIMIT = intEnv('REPUBLISH_LIMIT', 10_000)
const ORG = intEnv('REPUBLISH_ORG', 1)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const payload = await getPayload({ config })

const { docs } = await payload.find({
  collection: 'documents',
  where: {
    and: [
      { organization: { equals: ORG } },
      { publicationStatus: { in: ['publishing', 'draft'] } },
    ],
  },
  limit: LIMIT,
  depth: 0,
  overrideAccess: true,
  sort: 'id',
})

console.log(`[republish] ${docs.length} documento(s) por re-publicar (org ${ORG}, ${DELAY_MS}ms entre cada uno)`)

const client = getAdminAIClient(ORG)
const callbackUrl = ingestCallbackUrl() ?? undefined
let ok = 0
let failed = 0
/**
 * ⚠ `NotPublishableError` covers TWO different situations and reporting them as
 * one number is misleading. "The gate held this testimony" is a human-review
 * task; "this row has no text" is e2e residue nobody should act on. The first
 * smoke run said "5 retenidos por el gate" when all five were empty fixtures.
 */
const skipped: Record<string, number> = {}

for (const [i, doc] of docs.entries()) {
  try {
    const res = await beginPublish(doc as never, {
      payload,
      client: client as never,
      ...(callbackUrl ? { callbackUrl } : {}),
    })
    ok++
    console.log(`[republish] ${i + 1}/${docs.length} doc ${doc.id} → ${res.corpus}`)
  } catch (err) {
    if (err instanceof NotPublishableError) {
      const msg = (err as Error).message
      const reason = /anonimiz|gate|redact|scrub/i.test(msg)
        ? 'retenido por el gate (revisión humana)'
        : /texto|text/i.test(msg)
          ? 'sin texto (residuo de pruebas)'
          : 'no publicable'
      skipped[reason] = (skipped[reason] ?? 0) + 1
    } else {
      failed++
      console.error(`[republish] doc ${doc.id} FALLÓ:`, (err as Error).message)
    }
  }
  if (i < docs.length - 1) await sleep(DELAY_MS)
}

const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0)
console.log(`[republish] listo: ${ok} enviados, ${skippedTotal} omitidos, ${failed} fallidos`)
for (const [reason, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`[republish]   ${n} ${reason}`)
}
