/**
 * 🔴 A PUBLISHED TESTIMONY DOES NOT LEAK ITS ORIGINAL. Audit 2026-10-17.
 *
 * `visibleToCaller` shares a published row with every member of its
 * ecosistema. Before the fix, that row carried `extractedText` — the unredacted
 * testimony — and `name`, the uploader's filename. This suite seeds an APPROVED,
 * PUBLISHED testimonio and reads it as a colleague, by id and by list, and
 * asserts the raw marker appears nowhere in either response.
 *
 * ── HOW IT IS SEEDED, AND WHY NO MODEL IS CALLED ─────────────────────────────
 *
 * Created through the ordinary API (`kind: 'markdown'`, so no extractor and no
 * ingest run), then the gate's columns and the publication state are set by
 * direct SQL — the same pattern as `holds.e2e.ts`, because those columns are
 * `gateWritesOnly`. No gate, no embedding, no paid call.
 *
 * ⚠ IT TESTS THE BACKEND THAT IS RUNNING. Point `E2E_BACKEND_URL` at a backend
 * built from this tree; the long-lived container serves whatever it was built
 * from.
 */

import { randomBytes } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet } from './support/api'
import { dbAccess, exec } from './support/db'
import { stackDown } from './support/stack'
import { createTextDocument, provisionWorld, type World } from './support/world'

const db = dbAccess()
const noSeed = stackDown || !db.ok

if (!stackDown && !db.ok) {
  console.error(`\n[e2e] testimonyRead: SKIPPED — ${db.reason}\n`)
}

describe.skipIf(noSeed)('🔴 a published testimonio, read by a colleague', () => {
  let world: World
  let docId: number
  /** Appears ONLY in the raw text and the raw filename. Never in the redaction. */
  const marker = `Zelmira${randomBytes(4).toString('hex')}`
  const REDACTED = 'Me llamo [Persona A] y vivo en [Domicilio A].'

  beforeAll(async () => {
    world = await provisionWorld()
    // Alice is `owner` in orgA, which carries `voces:upload`.
    const doc = await createTextDocument(
      world.alice.caller,
      `Testimonio de ${marker}.m4a`,
      `Me llamo ${marker} y vivo en la calle Morelos 12.`,
      { contentKind: 'testimonio' },
    )
    docId = Number(doc.id)
    exec(
      `update documents set
         anonymisation_status = 'approved',
         redacted_text        = :'redacted',
         publication_status   = 'published'
       where id = :'id'`,
      { id: docId, redacted: REDACTED },
    )
  }, 180_000)

  it('by id: the colleague gets the redaction, and no raw text or name anywhere', async () => {
    const res = await apiGet(world.bob.caller, `/api/documents/${docId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.contentKind).toBe('testimonio')
    expect(res.body.redactedText).toBe(REDACTED)
    expect(res.text).not.toContain(marker)
    expect(res.body.extractedText).toBeUndefined()
    expect(res.body.bodyMarkdown).toBeUndefined()
    expect(res.body.name).toBeUndefined()
  })

  it('by list: same', async () => {
    const res = await apiGet(
      world.bob.caller,
      `/api/documents?where[organization][equals]=${world.orgA.id}&depth=0&limit=100`,
    )
    expect(res.status).toBe(200)
    expect(res.body.docs.some((d: { id: number }) => Number(d.id) === docId)).toBe(true)
    expect(res.text).not.toContain(marker)
  })

  it('🔴 a title search is not an oracle on the hidden filename', async () => {
    const res = await apiGet(
      world.bob.caller,
      `/api/documents?where[name][like]=${encodeURIComponent(marker)}&depth=0`,
    )
    expect(res.status).toBe(200)
    expect(res.body.docs).toEqual([])
  })

  it('the uploader still reads her own original', async () => {
    const res = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.extractedText).toContain(marker)
    expect(res.body.name).toContain(marker)
  })
})
