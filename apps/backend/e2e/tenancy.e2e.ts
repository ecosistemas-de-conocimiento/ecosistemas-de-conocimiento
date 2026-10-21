/**
 * 🔴 CROSS-TENANT AND CROSS-PERSON ISOLATION. The highest-value assertions in
 * this suite, and the ones a unit test cannot make: every rule here is enforced
 * by a WHERE constraint that Payload compiles into SQL, so it is only really
 * proven against a real database.
 *
 * Three separate boundaries, deliberately tested apart:
 *   1. ECOSISTEMA — carol (org B) must not reach anything in org A.
 *   2. PERSON, INSIDE ONE ECOSISTEMA — bob must not reach alice's DRAFT even
 *      though they are colleagues. This is the risk the ecosistema model adds
 *      that a purely per-tenant scheme did not have.
 *   3. CONVERSATION — sessions are private per person, and "not yours" must be
 *      indistinguishable from "does not exist".
 *
 * ⚠ EVERY NEGATIVE ASSERTION CHECKS FOR 404, NOT 403. That is a product
 * decision, written down in `lib/corpus.ts` and `access/index.ts`: ids are
 * sequential, so a 403 would be an oracle telling an attacker which ids exist.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { anonymous, apiGet, apiJson, pollUntil } from './support/api'
import { onFakeProvider, retrieveAs } from './support/ai'
import { fixtures } from './support/fixtures'
import { stackDown } from './support/stack'
import { docRow, uploadPdfDocument } from './support/upload'
import { createTextDocument, provisionWorld, type World } from './support/world'

describe.skipIf(stackDown)('tenancy and isolation', () => {
  let world: World
  let aliceDraftId: number
  let aliceSessionId: number
  let carolSessionId: number

  beforeAll(async () => {
    world = await provisionWorld()

    const session = await apiJson(world.alice.caller, 'POST', '/api/sessions', {
      title: `${world.ns} alice session`,
    })
    expect(session.status).toBe(201)
    aliceSessionId = session.body.doc.id

    const carolSession = await apiJson(world.carol.caller, 'POST', '/api/sessions', {
      title: `${world.ns} carol session`,
    })
    expect(carolSession.status).toBe(201)
    carolSessionId = carolSession.body.doc.id

    const draft = await createTextDocument(
      world.alice.caller,
      `${world.ns} alice draft`,
      'Contenido privado de alice. Palabra clave ALICE-SECRETO.',
      { session: aliceSessionId },
    )
    aliceDraftId = draft.id
  }, 120_000)

  // -------------------------------------------------------------------------
  // Setup itself is an assertion: the server derived the tenancy, not the client
  // -------------------------------------------------------------------------

  it('derives the ecosistema and the uploader server-side, and starts every document as a draft', async () => {
    const res = await apiGet(world.alice.caller, `/api/documents/${aliceDraftId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.organization).toBe(world.orgA.id)
    expect(res.body.uploadedBy).toBe(world.alice.id)
    expect(res.body.publicationStatus).toBe('draft')
  })

  it('refuses a client-supplied uploader and a client-supplied ecosistema', async () => {
    // Both are corpus-name inputs. Accepting either would let one person file a
    // document into another's private draft corpus.
    const res = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      name: `${world.ns} forged`,
      kind: 'markdown',
      bodyMarkdown: 'x',
      extractedText: 'x',
      uploadedBy: world.bob.id,
      organization: world.orgB.id,
      publicationStatus: 'published',
    })
    expect(res.status).toBe(201)
    expect(res.body.doc.uploadedBy.id ?? res.body.doc.uploadedBy).toBe(world.alice.id)
    expect(res.body.doc.organization.id ?? res.body.doc.organization).toBe(world.orgA.id)
    expect(res.body.doc.publicationStatus).toBe('draft')
  })

  // -------------------------------------------------------------------------
  // 1. Cross-ecosistema
  // -------------------------------------------------------------------------

  it('🔴 a member of ecosistema B cannot read a document in ecosistema A, even by explicit id', async () => {
    const res = await apiGet(world.carol.caller, `/api/documents/${aliceDraftId}`)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('ALICE-SECRETO')
  })

  it('🔴 the document LIST never crosses the ecosistema boundary', async () => {
    const res = await apiGet(world.carol.caller, '/api/documents?limit=200&depth=0')
    expect(res.status).toBe(200)
    const ids = res.body.docs.map((d: { id: number }) => d.id)
    expect(ids).not.toContain(aliceDraftId)
    // Whatever carol can see, all of it is hers.
    for (const doc of res.body.docs) {
      expect(doc.uploadedBy).toBe(world.carol.id)
    }
  })

  it('a member of ecosistema B cannot read ecosistema A itself', async () => {
    const res = await apiGet(world.carol.caller, `/api/organizations/${world.orgA.id}`)
    expect(res.status).toBe(404)
  })

  it('a member of ecosistema B cannot see ecosistema A memberships', async () => {
    const res = await apiGet(world.carol.caller, '/api/memberships?limit=200&depth=0')
    expect(res.status).toBe(200)
    for (const row of res.body.docs) {
      expect(row.organization).toBe(world.orgB.id)
    }
  })

  it('🔴 an owner of ecosistema B cannot add someone to ecosistema A', async () => {
    // Payload ignores the WHERE that `create` access returns; the
    // `refuseForeignOrganization` hook is what stops this. The target is the
    // platform admin's account: not carol herself (the self-assignment hook
    // would answer) and not already in A (the uniqueness hook would answer).
    const res = await apiJson(world.carol.caller, 'POST', '/api/memberships', {
      user: world.adminId,
      organization: world.orgA.id,
      role: 'owner',
    })
    expect(res.status).toBe(400)
    expect(res.text).toContain('You can only add people to an ecosistema you administer.')
  })

  it('the user roster is not browsable — a member sees only their own row', async () => {
    const res = await apiGet(world.bob.caller, '/api/users?limit=200&depth=0')
    expect(res.status).toBe(200)
    expect(res.body.docs.map((u: { id: number }) => u.id)).toEqual([world.bob.id])

    const other = await apiGet(world.bob.caller, `/api/users/${world.alice.id}`)
    expect(other.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // 2. Cross-person, INSIDE one ecosistema
  // -------------------------------------------------------------------------

  it('🔴 a colleague in the SAME ecosistema cannot read an unpublished draft', async () => {
    const res = await apiGet(world.bob.caller, `/api/documents/${aliceDraftId}`)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('ALICE-SECRETO')
  })

  it("a colleague cannot edit or delete another person's document", async () => {
    const patch = await apiJson(world.bob.caller, 'PATCH', `/api/documents/${aliceDraftId}`, {
      name: 'hijacked',
    })
    // ⚠ 403/404 specifically, not "any 4xx". A 400 would mean the write was
    // rejected by VALIDATION rather than by the access rule, and the test would
    // keep passing on a build where the access rule had been removed.
    expect([403, 404]).toContain(patch.status)

    const del = await apiJson(world.bob.caller, 'DELETE', `/api/documents/${aliceDraftId}`)
    expect([403, 404]).toContain(del.status)

    // …and it is untouched.
    const still = await apiGet(world.alice.caller, `/api/documents/${aliceDraftId}?depth=0`)
    expect(still.status).toBe(200)
    expect(still.body.name).toBe(`${world.ns} alice draft`)
  })

  it("a colleague cannot publish another person's draft", async () => {
    const res = await apiJson(world.bob.caller, 'POST', `/api/documents/${aliceDraftId}/publish`)
    // 404 (invisible) is the correct answer; 403 would confirm the id exists.
    expect(res.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // 3. Sessions and the corpora endpoint
  // -------------------------------------------------------------------------

  it('a session is private to its owner — a colleague gets 404, not 403', async () => {
    const res = await apiGet(world.bob.caller, `/api/sessions/${aliceSessionId}`)
    expect(res.status).toBe(404)
  })

  it('refuses to create a session in an ecosistema you do not belong to', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/sessions', {
      title: `${world.ns} cross-tenant attempt`,
      organization: world.orgB.id,
    })
    expect(res.status).toBe(400)
    expect(res.text).toMatch(/no perteneces|do not belong/i)
  })

  it('stamps the owner and the ecosistema on a session from the server, never the body', async () => {
    const res = await apiJson(world.alice.caller, 'POST', '/api/sessions', {
      title: `${world.ns} stamped`,
      user: world.bob.id,
    })
    expect(res.status).toBe(201)
    expect(res.body.doc.user.id ?? res.body.doc.user).toBe(world.alice.id)
    expect(res.body.doc.organization.id ?? res.body.doc.organization).toBe(world.orgA.id)
  })

  it('refuses to attach a document to somebody else\'s session', async () => {
    // ⚠ This is INJECTION, not disclosure: the attacker could never read the row
    // back, but the victim's assistant would answer from a document they chose.
    const res = await apiJson(world.carol.caller, 'POST', '/api/documents', {
      name: `${world.ns} injected`,
      kind: 'markdown',
      bodyMarkdown: 'payload',
      extractedText: 'payload',
      session: aliceSessionId,
    })
    expect(res.status).toBe(400)
    expect(res.text).toMatch(/no such conversation/i)
  })

  it('GET /api/sessions/:id/corpora derives both corpus names server-side', async () => {
    const res = await apiGet(world.alice.caller, `/api/sessions/${aliceSessionId}/corpora`)
    expect(res.status).toBe(200)
    expect(res.body.published).toBe(`eco-${world.orgA.id}`)
    expect(res.body.draft).toBe(`eco-${world.orgA.id}-draft-${world.alice.id}`)
    expect(res.body.corpora).toEqual([res.body.published, res.body.draft])
    // Handed over rather than documented, so a caller cannot forget it.
    expect(typeof res.body.asOf).toBe('string')
    expect(Number.isNaN(Date.parse(res.body.asOf))).toBe(false)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('🔴 corpora for a session that is not yours is 404 — NOT 403', async () => {
    const res = await apiGet(world.carol.caller, `/api/sessions/${aliceSessionId}/corpora`)
    expect(res.status).toBe(404)
    // The one that matters: no corpus name leaks in the refusal.
    expect(res.text).not.toContain(`eco-${world.orgA.id}`)
  })

  it('corpora for a session that does not exist is the SAME 404, with the same body', async () => {
    const notYours = await apiGet(world.carol.caller, `/api/sessions/${aliceSessionId}/corpora`)
    const notThere = await apiGet(world.carol.caller, '/api/sessions/999999999/corpora')
    expect(notThere.status).toBe(404)
    // ⚠ Byte-identical. "Not yours" and "does not exist" being the same answer is
    // what stops this becoming an oracle for which session ids exist.
    expect(notThere.text).toBe(notYours.text)
  })

  it('corpora is 401 for an anonymous caller', async () => {
    const res = await apiGet(anonymous, `/api/sessions/${aliceSessionId}/corpora`)
    expect(res.status).toBe(401)
  })

  it('each person gets their OWN draft corpus inside the shared ecosistema', async () => {
    const bobSession = await apiJson(world.bob.caller, 'POST', '/api/sessions', {
      title: `${world.ns} bob session`,
    })
    expect(bobSession.status).toBe(201)
    const bobCorpora = await apiGet(
      world.bob.caller,
      `/api/sessions/${bobSession.body.doc.id}/corpora`,
    )
    const aliceCorpora = await apiGet(
      world.alice.caller,
      `/api/sessions/${aliceSessionId}/corpora`,
    )
    // Same ecosistema…
    expect(bobCorpora.body.published).toBe(aliceCorpora.body.published)
    // …different private drafts. This is the whole cross-person rule, in names.
    expect(bobCorpora.body.draft).not.toBe(aliceCorpora.body.draft)
  })

  it('carol\'s corpora name a different ecosistema entirely', async () => {
    const res = await apiGet(world.carol.caller, `/api/sessions/${carolSessionId}/corpora`)
    expect(res.status).toBe(200)
    expect(res.body.published).toBe(`eco-${world.orgB.id}`)
    expect(res.body.published).not.toBe(`eco-${world.orgA.id}`)
  })

  // -------------------------------------------------------------------------
  // 🔴 Isolation INSIDE ai-service, not just in the corpus names (finding T-3)
  // -------------------------------------------------------------------------

  /**
   * The tests above prove the backend derives different corpus NAMES per
   * ecosistema. That alone isolates nothing: anyone who learns `eco-<A>-…` could
   * ask ai-service for it. What isolates is the ai-service ORG each ecosistema
   * reads as (`X-AI-Org: eco-<id>` → org `edc-eco-<id>`). So this ingests a real
   * PDF for alice through the pipeline, then asks ai-service for alice's corpus
   * BY NAME — once as orgA (control: the chunks are there) and once as orgB.
   */
  it.skipIf(!onFakeProvider)(
    '🔴 a retrieve sent as ecosistema B returns none of ecosistema A\'s chunks',
    async () => {
      const docId = await uploadPdfDocument(world.alice.caller, `${world.ns} tenancy pdf`)

      // The corpus name the backend itself hands alice, not one rebuilt here.
      const corpora = await apiGet(world.alice.caller, `/api/sessions/${aliceSessionId}/corpora`)
      const corpus = String(corpora.body.draft)
      const query = fixtures().pdf.marker

      // Control: as orgA the chunks arrive. Without this, "0 chunks" below could
      // just mean the ingest never landed.
      //
      // ⚠ Polled on ai-service, NOT on the backend's `ingestStatus: 'ready'`.
      // The claim here is about ai-service's store. The backend status has its
      // own race (a background graph-status write can revert `ready` to
      // `embedding`, measured 2026-10-17 on the fake provider), and that is
      // `documents.e2e.ts`'s assertion to make, not this one's.
      const asA = await pollUntil(
        'alice\'s PDF chunks to reach ai-service',
        async () => {
          const probe = await retrieveAs(world.orgA.id, corpus, query)
          const row = await docRow(world.alice.caller, docId)
          return { ...probe, row }
        },
        (p) => p.chunks.length > 0 || p.row.ingestStatus === 'failed',
        { timeoutMs: 120_000, intervalMs: 2000 },
      )
      expect(asA.row.ingestStatus, `ingestError: ${asA.row.ingestError}`).not.toBe('failed')
      expect(asA.status, asA.text.slice(0, 300)).toBe(200)
      expect(asA.chunks.length).toBeGreaterThan(0)
      // Every chunk is the document we just uploaded, so the control is ours.
      expect(new Set(asA.chunks.map((c) => c.documentId)).size).toBe(1)

      const asB = await retrieveAs(world.orgB.id, corpus, query)
      // 404 (no such corpus in orgB) or an empty 200 — either way not one chunk.
      expect([200, 404], asB.text.slice(0, 300)).toContain(asB.status)
      expect(asB.chunks).toHaveLength(0)
    },
    240_000,
  )

  // -------------------------------------------------------------------------
  // Messages ride the session's privacy
  // -------------------------------------------------------------------------

  it('messages are private via their session', async () => {
    const mine = await apiJson(world.alice.caller, 'POST', '/api/messages', {
      session: aliceSessionId,
      role: 'user',
      content: `${world.ns} pregunta privada`,
    })
    expect(mine.status).toBe(201)

    const asBob = await apiGet(world.bob.caller, `/api/messages/${mine.body.doc.id}`)
    expect(asBob.status).toBe(404)

    const bobList = await apiGet(world.bob.caller, '/api/messages?limit=200&depth=0')
    expect(bobList.status).toBe(200)
    expect(bobList.body.docs.map((m: { id: number }) => m.id)).not.toContain(mine.body.doc.id)
  })
})
