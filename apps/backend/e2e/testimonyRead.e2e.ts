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

import { apiGet, apiJson, pollUntil, uploadFixture } from './support/api'
import { dbAccess, exec } from './support/db'
import { fixtures } from './support/fixtures'
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
         publication_status   = 'published',
         graph_status         = 'failed',
         graph_error          = :'graphError'
       where id = :'id'`,
      // L5: the shape a schema miss leaves — the model's reply, quoting the text.
      {
        id: docId,
        redacted: REDACTED,
        graphError: `graph_extract_failed: every extraction window failed — {"etiqueta":"${marker}"`,
      },
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
    expect(res.body.graphError).toContain(marker)
  })

  it('🔴 L5: graphError (the model’s raw reply) is hidden from a colleague', async () => {
    const res = await apiGet(world.bob.caller, `/api/documents/${docId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.graphError).toBeUndefined()
    expect(res.text).not.toContain(marker)
  })

  // L1: Payload matches `OR` / `And` case-insensitively; the narrowing used not to.
  it.each([
    ['OR', `where[OR][0][name][like]=${encodeURIComponent(marker)}`],
    ['And', `where[And][0][name][like]=${encodeURIComponent(marker)}`],
    ['nested oR', `where[and][0][oR][0][name][like]=${encodeURIComponent(marker.slice(0, 9))}`],
  ])('🔴 L1: a count under %s is not an oracle on the hidden filename', async (_label, query) => {
    const res = await apiGet(world.bob.caller, `/api/documents/count?${query}`)
    expect(res.status).toBe(200)
    expect(res.body.totalDocs).toBe(0)
  })

  it('🔴 L2: sort=name is not an oracle — the order ignores the hidden title', async () => {
    // Bob controls two probes that bracket the hidden name: "Testimonio de
    // Zelmira" sorts BEFORE "Testimonio de Zelmira<hex>.m4a", "…Zelmirazz" AFTER.
    const after = await createTextDocument(world.bob.caller, `Testimonio de ${marker.slice(0, 7)}zz`, 'sonda')
    const before = await createTextDocument(world.bob.caller, `Testimonio de ${marker.slice(0, 7)}`, 'sonda')
    const ids = [docId, after.id, before.id].map(Number)
    const scope = ids.map((id, i) => `where[id][in][${i}]=${id}`).join('&')
    const order = async (sort: string) => {
      const res = await apiGet(world.bob.caller, `/api/documents?${scope}&depth=0&limit=10${sort}`)
      expect(res.status).toBe(200)
      return (res.body.docs as Array<{ id: number }>).map((d) => Number(d.id))
    }
    const unsorted = await order('')
    expect(unsorted).toHaveLength(3)
    // With the sort honoured the testimonio would sit between the probes.
    expect(await order('&sort=name')).toEqual(unsorted)
    expect(await order('&sort=-name')).toEqual(unsorted)
  })

  it('🔴 L6: a storage failure does not write the filename into ingestError', async () => {
    const pdf = fixtures().pdf
    const media = await uploadFixture(
      world.alice.caller,
      pdf.file,
      pdf.mimeType,
      `Testimonio de ${marker}.pdf`,
    )
    expect(media.status).toBe(201)
    // Point the row at an object that is not there, so the extractor's read fails.
    exec(`update media set prefix = 'e2e-missing' where id = :'id'`, { id: Number(media.body.doc.id) })
    const created = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      name: 'Testimonio sin archivo',
      kind: 'pdf',
      mode: 'rag-retrieve',
      contentKind: 'testimonio',
      mediaFile: media.body.doc.id,
    })
    expect(created.status).toBe(201)
    const failedId = Number(created.body.doc.id)
    const failed = await pollUntil(
      'the extraction failure',
      async () => (await apiGet(world.alice.caller, `/api/documents/${failedId}?depth=0`)).body,
      (b: { ingestStatus?: string; ingestError?: string | null }) => b.ingestStatus === 'failed',
      { timeoutMs: 60_000 },
    )
    exec(`update documents set publication_status = 'published' where id = :'id'`, { id: failedId })
    expect(String(failed.ingestError)).toMatch(/^extraction_failed: /)
    expect(String(failed.ingestError)).not.toContain(marker)
    const asBob = await apiGet(world.bob.caller, `/api/documents/${failedId}?depth=0`)
    expect(asBob.text).not.toContain(marker)
  })

  // Last: it promotes Bob, which the cases above must not see.
  it('🔴 L3: anonymisation-reviews cannot be searched by the hidden filename', async () => {
    // Bob becomes a reviewer (`owner` carries `holds:review`) who did not
    // upload the testimonio; a review row points at it.
    exec(
      `update memberships set role = 'owner' where user_id = :'bob' and organization_id = :'org'`,
      { bob: world.bob.id, org: world.orgA.id },
    )
    exec(
      `insert into anonymisation_reviews (document_id, organization_id, reviewer_id, decision)
       values (:'doc', :'org', :'alice', 'approved')`,
      { doc: docId, org: world.orgA.id, alice: world.alice.id },
    )
    const base = `/api/anonymisation-reviews?where[document][equals]=${docId}&depth=0`
    const all = await apiGet(world.bob.caller, base)
    expect(all.status).toBe(200)
    expect(all.body.docs.length).toBe(1)

    const probe = await apiGet(
      world.bob.caller,
      `/api/anonymisation-reviews?where[document][equals]=${docId}` +
        `&where[document.name][like]=${encodeURIComponent(marker)}&depth=0`,
    )
    expect(probe.status).toBe(200)
    expect(probe.body.docs).toEqual([])
  })
})
