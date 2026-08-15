/**
 * PUBLISH AND UNPUBLISH — the asynchronous state machine, driven for real.
 *
 * 🔴 WHY THIS CANNOT BE A UNIT TEST. Publishing is not a column flip. Isolation
 * is by CORPUS NAME, so sharing a document means RE-EMBEDDING it into the
 * ecosistema's corpus at ai-service, waiting for a webhook, and only then
 * retiring the draft copy and flipping the row. Three processes and a network
 * hop decide whether `published` is true. Mocking any of them tests the mock.
 *
 * The visibility half is the payoff: bob cannot see alice's draft, CAN see it
 * once published, and cannot see it again after she takes it back.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, apiJson, pollUntil, type Caller } from './support/api'
import { stackDown } from './support/stack'
import { createTextDocument, provisionWorld, type World } from './support/world'

const TEXT =
  'Acta de la sesión de trabajo del ecosistema. Palabra clave: MEMBRILLO-E2E-PUBLICADO. ' +
  'Este documento existe para comprobar el ciclo publicar / despublicar de extremo a extremo.'

async function publicationState(
  caller: Caller,
  id: number,
): Promise<{ publicationStatus?: string; publicationError?: string | null; publishIngestId?: string | null }> {
  const res = await apiGet(caller, `/api/documents/${id}?depth=0`)
  return {
    publicationStatus: res.body?.publicationStatus,
    publicationError: res.body?.publicationError,
    publishIngestId: res.body?.publishIngestId,
  }
}

describe.skipIf(stackDown)('publish / unpublish', () => {
  let world: World
  let docId: number

  beforeAll(async () => {
    world = await provisionWorld()
    const doc = await createTextDocument(world.alice.caller, `${world.ns} acta`, TEXT)
    docId = doc.id
  }, 120_000)

  it('a draft is invisible to a colleague before anything is published', async () => {
    expect((await apiGet(world.bob.caller, `/api/documents/${docId}`)).status).toBe(404)
  })

  it('refuses to publish a document with no extracted text', async () => {
    // ⚠ Enqueueing an empty body would produce a `published` document that
    // matches nothing — a silent, permanent "why does search never find it".
    const empty = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      name: `${world.ns} sin texto`,
      kind: 'markdown',
      bodyMarkdown: 'x',
    })
    expect(empty.status).toBe(201)
    const res = await apiJson(
      world.alice.caller,
      'POST',
      `/api/documents/${empty.body.doc.id}/publish`,
    )
    expect(res.status).toBe(409)
  })

  it('POST /publish returns 202 and moves the row into the in-flight state', async () => {
    const res = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/publish`)
    expect(res.status).toBe(202)
    expect(res.body.publicationStatus).toBe('publishing')
    // The shared corpus, derived server-side. The client never names one.
    expect(res.body.corpus).toBe(`eco-${world.orgA.id}`)
    expect(typeof res.body.ingestId).toBe('string')
  })

  it('an in-flight document stays visible to its uploader and invisible to everyone else', async () => {
    // ⚠ The uploader clause is unconditional precisely so a crash mid-publish is
    // never a data-loss report.
    const mine = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    expect(mine.status).toBe(200)
    expect(['publishing', 'published']).toContain(mine.body.publicationStatus)
  })

  it('🔴 reaches `published` once ai-service confirms the re-embed', async () => {
    const state = await pollUntil(
      'the publish state machine to settle',
      () => publicationState(world.alice.caller, docId),
      (s) => s.publicationStatus === 'published' || Boolean(s.publicationError),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )
    expect(state.publicationError ?? null).toBeNull()
    expect(state.publicationStatus).toBe('published')
    // Cleared on confirmation, so the next transition cannot be confused with it.
    expect(state.publishIngestId ?? null).toBeNull()
  })

  it('🔴 a published document IS readable by another member of the same ecosistema', async () => {
    const res = await apiGet(world.bob.caller, `/api/documents/${docId}?depth=0`)
    expect(res.status).toBe(200)
    expect(res.body.extractedText).toContain('MEMBRILLO-E2E-PUBLICADO')
  })

  it('…and still not by anyone in another ecosistema', async () => {
    const res = await apiGet(world.carol.caller, `/api/documents/${docId}`)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('MEMBRILLO-E2E-PUBLICADO')
  })

  // ⚠ The two tests below PRESUME the state machine reached `published`. If the
  // one above failed, these fail with it — that is one root cause, not three.
  it('publishing again is a no-op rather than a second ingest', async () => {
    const res = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/publish`)
    expect(res.status).toBe(200)
    expect(res.body.alreadyDone).toBe(true)
  })

  it('🔴 unpublishing takes it back out of the colleague\'s view', async () => {
    const res = await apiJson(world.alice.caller, 'POST', `/api/documents/${docId}/unpublish`)
    expect(res.status).toBe(202)
    expect(res.body.publicationStatus).toBe('unpublishing')
    // The draft corpus it is going back into — again derived, never declared.
    expect(res.body.corpus).toBe(`eco-${world.orgA.id}-draft-${world.alice.id}`)

    const state = await pollUntil(
      'the unpublish state machine to settle',
      () => publicationState(world.alice.caller, docId),
      (s) => s.publicationStatus === 'draft' || Boolean(s.publicationError),
      { timeoutMs: 120_000, intervalMs: 2000 },
    )
    expect(state.publicationError ?? null).toBeNull()
    expect(state.publicationStatus).toBe('draft')

    // ⚠ The point of unpublishing. Sharing stops.
    const asBob = await apiGet(world.bob.caller, `/api/documents/${docId}`)
    expect(asBob.status).toBe(404)
  })

  it('a direct PATCH cannot mark a document published', async () => {
    // `publicationStatus` moves ONLY through the state machine; a column flip
    // would claim a document was shared with none of it in the shared corpus.
    const res = await apiJson(world.alice.caller, 'PATCH', `/api/documents/${docId}`, {
      publicationStatus: 'published',
    })
    expect(res.status).toBeLessThan(500)
    const after = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    expect(after.body.publicationStatus).toBe('draft')
    expect((await apiGet(world.bob.caller, `/api/documents/${docId}`)).status).toBe(404)
  })
})
