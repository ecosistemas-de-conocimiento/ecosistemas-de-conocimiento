/**
 * 🔴 A STUDENT'S IN-APP NOTE → THE GATE → GRAPH ROWS → "MIS TEMAS", on a real
 * Payload + Postgres (every migration), through the real hooks.
 *
 * Pinned, through the real `POST /api/documents/:id/publish` and
 * `PATCH /api/documents/:id/note` handlers:
 *   · "Publicar" on an `estudiante`'s draft note in a `studentView` ecosistema
 *     goes the upload path: gated (`anonymise` set), redacted, ingested as a
 *     draft, graphed from the REDACTED text only, and its topics reach the
 *     student's own `topicsByUser` — never a peer's while it is a draft;
 *   · publishing then follows `autoPublishMembers`;
 *   · unpublish → edit → Publicar gates the new text from scratch; unchanged
 *     text never re-gates;
 *   · no `studentView`, or not a student → today's behaviour, no gate, no graph;
 *   · autosave never processes, and 🔴 it cannot write stale pipeline or
 *     publication columns back (the whole-row `payload.update` could).
 *
 * Model calls are stubs: the gate's detector, the graph client and ai-service.
 * ⚠ No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const NAME = 'Tadeo Villaseñor'
const graphRequests: string[] = []
let detectorCalls = 0

/** Every ai-service call the code made: `path` like `ingest.enqueue`, `admin.setDocumentValidity`. */
type AiCall = { path: string; args: unknown[] }
const aiCalls: AiCall[] = ((globalThis as { __aiCalls?: AiCall[] }).__aiCalls ??= [])
/** Runs inside `ingest.enqueue`, before it answers: a write that lands mid-re-index. */
;(globalThis as { __onEnqueue?: () => Promise<void> }).__onEnqueue = undefined

vi.mock('@/lib/aiClient', () => {
  const calls = ((globalThis as { __aiCalls?: Array<{ path: string; args: unknown[] }> }).__aiCalls ??= [])
  const client = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : client([...path, String(key)])),
      apply: async (_t, _this, args: unknown[]) => {
        calls.push({ path: path.join('.'), args })
        const hook = (globalThis as { __onEnqueue?: () => Promise<void> }).__onEnqueue
        if (path.join('.') === 'ingest.enqueue' && hook) await hook()
        return { ok: true, ingestId: `ing-${calls.length}` }
      },
    })
  return { getAdminAIClient: () => client([]), getAppAIClient: () => client([]) }
})

vi.mock('@/lib/anonymise', async (importOriginal) => {
  const real = await importOriginal<typeof import('./anonymise')>()
  return {
    ...real,
    aiServiceDetector: () => {
      const inner = real.staticDetector([{ text: NAME, type: 'persona' }])
      return {
        ...inner,
        detect: async (input: Parameters<typeof inner.detect>[0]) => {
          detectorCalls++
          return inner.detect(input)
        },
      }
    },
  }
})

vi.mock('@/lib/graph/client', () => ({
  getGraphAIClient: async () => ({
    generate: {
      async sync(req: unknown) {
        const seen = JSON.stringify(req)
        graphRequests.push(seen)
        // A test may hold the revision's graph run open (`__graphGate`).
        if (seen.includes('Abducción')) await (globalThis as { __graphGate?: Promise<void> }).__graphGate
        return {
          parsed: {
            entidades: seen.includes('Abducción')
              ? [{ tipo: 'tema', etiqueta: 'Abducción', menciones: 2 }]
              : [
                  { tipo: 'tema', etiqueta: 'Semiótica', menciones: 2 },
                  { tipo: 'tema', etiqueta: 'Signo', menciones: 1 },
                ],
            relaciones: [],
          },
        }
      },
    },
  }),
}))

import type { Endpoint, PayloadRequest } from 'payload'

import { getAdminAIClient } from './aiClient'
import { autoPublishParticipantDocument } from './autoPublish'
import { invalidateFeatures } from './features'
import { topicsByUser } from './student/queries'
import { bootPayload, dockerOk, eventually, rowsOf, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

if (!dockerOk) console.warn('[studentNotes.pg.test] docker is not usable — SKIP.')

let pg: RealPostgres | undefined
let payload: Payload | undefined

const SEMIOSIS = 8 // studentView on, wikilink-seeded
const PLAIN = 9 // studentView off
const ANA = 1 // estudiante of 8
const BETO = 2 // member of 8
const CARO = 3 // estudiante of 9

const PAD = ' Escribo sobre signos, interpretantes y objetos en el aula, y sobre cómo se leen.'.repeat(3)
const BODY = `# Ensayo\n\nMi vecino ${NAME} habla de [[Semiótica]] y del [[Signo]].${PAD}`

const row = async (id: number) =>
  (
    await rowsOf(
      pg!.db,
      sql`SELECT ingest_status AS i, anonymisation_status AS a, anonymise AS anon, redacted_text AS r,
                 graph_status AS g, publication_status AS p, extracted_text AS t, body_markdown AS b
            FROM documents WHERE id = ${id}`,
    )
  )[0]!
const mentions = async (id: number) =>
  Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM graph_mentions WHERE document_id = ${id}`))[0]!.n)
const topics = async (user: number, publishedOnly: boolean) =>
  ((await topicsByUser(payload as never, SEMIOSIS, [user], { publishedOnly })).get(user) ?? []).map((t) => t.label)

const insertNote = (id: number, org: number, user: number, body = BODY) =>
  pg!.db.execute(sql`
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, mode, body_markdown,
                           publication_status, content_kind, ingest_status, anonymise)
    VALUES (${id}, ${org}, ${user}, 'Mi nota', 'markdown', 'full-text', ${body}, 'draft', 'documento', 'n/a', false)`)

const endpoint = (method: string, path: string) =>
  (payload!.collections.documents.config.endpoints as Endpoint[]).find((e) => e.method === method && e.path === path)!

async function call(as: number, method: string, path: string, id: number, body?: unknown) {
  const { createLocalReq } = await import('payload')
  const user = await payload!.findByID({ collection: 'users', id: as, overrideAccess: true })
  const req = (await createLocalReq({ user: { ...user, collection: 'users' } as never }, payload!)) as PayloadRequest
  Object.assign(req, { routeParams: { id: String(id) }, json: async () => body ?? {} })
  const res = await endpoint(method, path).handler(req)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const publicar = (as: number, id: number) => call(as, 'post', '/:id/publish', id)
const autosave = (as: number, id: number, body: unknown) => call(as, 'patch', '/:id/note', id, body)
const setFeatures = async (features: Record<string, boolean>) => {
  await pg!.db.execute(sql`UPDATE organizations SET features = ${JSON.stringify(features)}::jsonb WHERE id = ${SEMIOSIS}`)
  invalidateFeatures(SEMIOSIS)
}

describe.skipIf(!dockerOk)('student in-app notes: Publicar → gate → graph (real Payload + Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-student-notes-pg-${process.pid}`, 'student_notes_test')
    payload = await bootPayload(pg.url, 'student-notes-secret')
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'ana@x.invalid', 'Ana', false), (2, 'beto@x.invalid', 'Beto', false), (3, 'caro@x.invalid', 'Caro', false);
      SELECT setval('users_id_seq', 3);
      INSERT INTO organizations (id, name, slug, features) VALUES
        (8, 'Semiosis', 'semiosis', '{"studentView": true}'), (9, 'Plain', 'plain', '{}');
      SELECT setval('organizations_id_seq', 9);
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (1, 8, 'estudiante'), (2, 8, 'member'), (3, 9, 'estudiante');
    `),
    )
    invalidateFeatures()
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('🔴 autosave never processes a note', async () => {
    await insertNote(100, SEMIOSIS, ANA, 'Primer borrador.')
    expect((await autosave(ANA, 100, { bodyMarkdown: BODY })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 500))
    const r = await row(100)
    expect([r.b, r.i, r.a]).toEqual([BODY, 'n/a', 'n/a'])
    expect(detectorCalls).toBe(0)
    expect(graphRequests).toHaveLength(0)
  })

  it('🔴 Publicar → gated, redacted → graph rows from the redaction → own topics, not peers', async () => {
    const res = await publicar(ANA, 100)
    expect([res.status, res.body.processing, res.body.publicationStatus]).toEqual([202, true, 'draft'])

    expect(await eventually(async () => (await row(100)).g === 'ready', 20_000)).toBe(true)
    const r = await row(100)
    expect([r.anon, r.a, r.i, r.p]).toEqual([true, 'ready', 'embedding', 'draft'])
    expect(String(r.r)).not.toContain('Villaseñor')
    expect(detectorCalls).toBeGreaterThan(0)

    // 🔴 The graph saw the redaction only.
    expect(graphRequests.length).toBeGreaterThan(0)
    for (const req of graphRequests) expect(req).not.toContain('Villaseñor')
    expect(await mentions(100)).toBeGreaterThan(0)

    expect(await topics(ANA, false)).toEqual(expect.arrayContaining(['Semiótica', 'Signo']))
    // 🔴 Still a draft: no peer sees its topics.
    expect(await topics(ANA, true)).toEqual([])
  }, 60_000)

  it('publishing follows autoPublishMembers; unchanged text never re-gates', async () => {
    // The ingest callback landed (simulated).
    await pg!.db.execute(sql`UPDATE documents SET ingest_status = 'ready' WHERE id = 100`)
    const before = detectorCalls
    await setFeatures({ studentView: true, autoPublishMembers: false })
    const off = await publicar(ANA, 100)
    expect(off.status).toBe(409)
    expect(JSON.stringify(off.body)).toContain('disabled')
    expect((await row(100)).p).toBe('draft')

    await setFeatures({ studentView: true })
    const on = await publicar(ANA, 100)
    expect([on.status, on.body.publicationStatus]).toEqual([202, 'publishing'])
    expect((await row(100)).p).toBe('publishing')
    expect(detectorCalls).toBe(before)
  })

  it('🔴 unpublish → edit → Publicar gates the new text from scratch', async () => {
    // `confirmUnpublish` landed (simulated): a draft again, gate state as it was.
    await pg!.db.execute(sql`UPDATE documents SET publication_status = 'draft' WHERE id = 100`)
    const edited = `${BODY}\n\nOtra idea sobre el índice.`
    expect((await autosave(ANA, 100, { bodyMarkdown: edited })).status).toBe(200)
    expect((await row(100)).i).toBe('ready') // autosave touched nothing else

    const before = detectorCalls
    const res = await publicar(ANA, 100)
    expect([res.status, res.body.processing]).toEqual([202, true])
    expect(await eventually(async () => (await row(100)).a === 'ready' && detectorCalls > before, 20_000)).toBe(true)
    expect(String((await row(100)).t)).toContain('índice')
  }, 60_000)

  it('🔴 no studentView, or not a student: today\'s path — no gate, no graph', async () => {
    await insertNote(200, PLAIN, CARO)
    await insertNote(201, SEMIOSIS, BETO)
    const before = detectorCalls
    for (const [as, id] of [[CARO, 200], [BETO, 201]] as const) {
      const res = await publicar(as, id)
      expect(res.body.processing).toBeUndefined()
      expect((await row(id)).i).toBe('n/a')
      expect(await mentions(id)).toBe(0)
    }
    expect(detectorCalls).toBe(before)
  })

  it('a note too short to graph is refused, untouched', async () => {
    await insertNote(300, SEMIOSIS, ANA, 'Idea suelta.')
    const res = await publicar(ANA, 300)
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.body)).toContain('too-short')
    expect((await row(300)).i).toBe('n/a')
  })

  it('autosave is the owner\'s only, and never writes a pipeline or publication column', async () => {
    await insertNote(400, SEMIOSIS, ANA)
    expect((await autosave(BETO, 400, { bodyMarkdown: 'x' })).status).toBeGreaterThanOrEqual(403)
    expect((await autosave(ANA, 400, { bodyMarkdown: 'x', publicationStatus: 'published' })).status).toBe(400)
    expect((await row(400)).b).toBe(BODY)
  })

  it('🔴 two Publicar clicks at once: one claim, one gate run', async () => {
    await insertNote(600, SEMIOSIS, ANA)
    let before = detectorCalls
    await publicar(ANA, 600)
    expect(await eventually(async () => (await row(600)).a === 'ready', 20_000)).toBe(true)
    const single = detectorCalls - before

    await insertNote(601, SEMIOSIS, ANA)
    before = detectorCalls
    const both = await Promise.all([publicar(ANA, 601), publicar(ANA, 601)])
    for (const res of both) expect([res.status, res.body.processing]).toEqual([202, true])
    expect(await eventually(async () => (await row(601)).a === 'ready', 20_000)).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(detectorCalls - before).toBe(single)
  }, 60_000)

  it('🔴 autosave on someone else\'s PUBLISHED note: 403 (they can read it, not write it)', async () => {
    await insertNote(700, SEMIOSIS, ANA)
    await pg!.db.execute(sql`UPDATE documents SET publication_status = 'published' WHERE id = 700`)
    const res = await autosave(BETO, 700, { bodyMarkdown: 'pisado', name: 'otro' })
    expect(res.status).toBe(403)
    expect((await row(700)).b).toBe(BODY)
  })

  it('🔴 a direct PATCH to `pending` on an ungated note never reaches the graph (hook guard)', async () => {
    await insertNote(800, SEMIOSIS, ANA) // anonymise false, as a pre-ruling note
    const before = { d: detectorCalls, g: graphRequests.length }
    const user = await payload!.findByID({ collection: 'users', id: ANA, overrideAccess: true })
    // overrideAccess so the field write sticks: only the hook guard stands in the way.
    await payload!.update({
      collection: 'documents',
      id: 800,
      data: { ingestStatus: 'pending', extractedText: BODY } as never,
      user: { ...user, collection: 'users' } as never,
      overrideAccess: true,
    })
    await new Promise((r) => setTimeout(r, 1_500))
    const r = await row(800)
    expect([r.i, r.anon, r.g]).toEqual(['pending', false, 'n/a'])
    expect(await mentions(800)).toBe(0)
    expect([detectorCalls, graphRequests.length]).toEqual([before.d, before.g])
  })

  /**
   * 🔴 THE AUDIT'S RACE (2026-10-28, probe A8). A pipeline write lands INSIDE
   * the autosave's write. Any whole-row writer (`payload.update` →
   * `db.updateOne`) is paused after its read, the pipeline write lands, and the
   * writer then puts the `draft` / `n/a` it read back. The note endpoint must
   * not: going back to `payload.update` fails this test.
   */
  it('🔴 a pipeline write inside the autosave write is not clobbered', async () => {
    const midFlight = (id: number) =>
      pg!.db.execute(sql`UPDATE documents SET publication_status = 'publishing', ingest_status = 'ready' WHERE id = ${id}`)
    const db = payload!.db as unknown as { updateOne: (...a: unknown[]) => Promise<unknown> }
    const original = db.updateOne.bind(db)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let paused = 0
    const spy = vi.spyOn(db, 'updateOne').mockImplementation(async (...a: unknown[]) => {
      const args = a[0] as { id?: unknown; collection?: unknown }
      if (String(args?.id) === '500' || String(args?.id) === '501') {
        paused++
        await held
      }
      return original(...a)
    })
    try {
      // Control: the whole-row write IS clobbered under the same interleaving.
      await insertNote(500, SEMIOSIS, ANA)
      const user = await payload!.findByID({ collection: 'users', id: ANA, overrideAccess: true })
      const old = payload!.update({
        collection: 'documents',
        id: 500,
        data: { bodyMarkdown: `${BODY} uno` } as never,
        user: { ...user, collection: 'users' } as never,
        overrideAccess: true,
      })
      // The note endpoint, same interleaving.
      await insertNote(501, SEMIOSIS, ANA)
      const res = autosave(ANA, 501, { bodyMarkdown: `${BODY} dos` })
      await new Promise((r) => setTimeout(r, 300))
      await midFlight(500)
      await midFlight(501)
      release()
      await old
      expect((await res).status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    expect([(await row(500)).p, (await row(500)).i]).toEqual(['draft', 'n/a']) // clobbered: the bug
    const r = await row(501)
    expect([r.p, r.i, r.b]).toEqual(['publishing', 'ready', `${BODY} dos`])
    expect(paused).toBe(1) // only the control went through `updateOne`
  })

  describe('"Publicar cambios" on a published note (owner ruling 2026-10-28)', () => {
    const NOTE = 900
    const NEW_BODY = `# Otra cosa\n\nMi vecino ${NAME} me explicó la Abducción, nada más.${PAD.replace(/signos, interpretantes y objetos/g, 'inferencias')}`
    let version = 0
    /** A fresh edit of the note each time (changed text). */
    const nextBody = () => `${NEW_BODY}\n\nVersión ${++version} sobre la Abducción.`
    const revisionOf = async (id: number) =>
      (
        await rowsOf(
          pg!.db,
          sql`SELECT id, ingest_status AS i, anonymisation_status AS a, graph_status AS g, publication_status AS p
                FROM documents WHERE revision_of_id = ${id}`,
        )
      )[0]
    /** What ai-service's callback does when a draft ingest lands: `ready`, then auto-publish. */
    const landDraftIngest = async (id: number) => {
      await pg!.db.execute(sql`UPDATE documents SET ingest_status = 'ready' WHERE id = ${id}`)
      return autoPublishParticipantDocument({ payload: payload!, documentId: id, clientFor: (o) => getAdminAIClient(o) as never })
    }
    const noteLabels = async () =>
      (
        await rowsOf(pg!.db, sql`SELECT e.label FROM graph_mentions m JOIN graph_entities e ON e.id = m.entity_id WHERE m.document_id = ${NOTE} ORDER BY 1`)
      ).map((r) => r.label)
    const sharedEnqueues = () =>
      aiCalls.filter((c) => c.path === 'ingest.enqueue' && (c.args[0] as { corpus?: string }).corpus === 'eco-8')
    const retiresOf = (id: number) =>
      aiCalls.filter((c) => c.path === 'admin.setDocumentValidity' && c.args[0] === 'eco-8' && c.args[1] === String(id))
    /** Edit → Publicar cambios → the revision's gate and graph done; its draft ingest NOT landed yet. */
    const changeAndWait = async () => {
      expect((await autosave(ANA, NOTE, { bodyMarkdown: nextBody() })).status).toBe(200)
      const res = await publicar(ANA, NOTE)
      expect([res.status, res.body.processing, res.body.publicationStatus]).toEqual([202, true, 'published'])
      expect(await eventually(async () => (await revisionOf(NOTE))?.g === 'ready', 20_000)).toBe(true)
      return Number((await revisionOf(NOTE))!.id)
    }

    it('setup: a published note, its topics visible to peers', async () => {
      ;(globalThis as { __graphGate?: Promise<void> }).__graphGate = Promise.resolve()
      await setFeatures({ studentView: true })
      await insertNote(NOTE, SEMIOSIS, ANA)
      await publicar(ANA, NOTE)
      expect(await eventually(async () => (await row(NOTE)).g === 'ready', 20_000)).toBe(true)
      expect(await landDraftIngest(NOTE)).toEqual({ published: true })
      await pg!.db.execute(sql`UPDATE documents SET publication_status = 'published' WHERE id = ${NOTE}`) // confirmPublish
      expect(await topics(ANA, true)).toEqual(expect.arrayContaining(['Semiótica', 'Signo']))
    }, 60_000)

    it('🔴 the draft ingest lands BEFORE the revision\'s graph: no promotion until the graph is final; peers keep the old version', async () => {
      let release!: () => void
      ;(globalThis as { __graphGate?: Promise<void> }).__graphGate = new Promise<void>((r) => (release = r))
      expect((await autosave(ANA, NOTE, { bodyMarkdown: nextBody() })).status).toBe(200)
      const before = await row(NOTE)
      expect((await publicar(ANA, NOTE)).status).toBe(202)
      expect(await eventually(async () => (await revisionOf(NOTE))?.g === 'extracting', 20_000)).toBe(true)
      const rev = Number((await revisionOf(NOTE))!.id)

      // 🔴 The revision is hidden from its own author's reads.
      const user = await payload!.findByID({ collection: 'users', id: ANA, overrideAccess: true })
      const asAna = await payload!.find({
        collection: 'documents',
        where: { id: { equals: rev } },
        user: { ...user, collection: 'users' } as never,
        overrideAccess: false,
      })
      expect(asAna.docs).toHaveLength(0)

      expect(await landDraftIngest(rev)).toEqual({ published: false, reason: 'graph-pending' })
      const during = await row(NOTE)
      expect([during.p, during.r, during.t]).toEqual(['published', before.r, before.t])
      expect(await noteLabels()).toEqual(['Semiótica', 'Signo'])
      expect(await topics(ANA, true)).not.toContain('Abducción')

      // The graph run ends → the promotion runs from there.
      aiCalls.length = 0
      release()
      expect(await eventually(async () => (await revisionOf(NOTE)) === undefined, 20_000)).toBe(true)
      const after = await row(NOTE)
      expect(after.p).toBe('published')
      expect(String(after.r)).toContain('Abducción')
      expect(String(after.r)).not.toContain('Villaseñor')
      expect(await noteLabels()).toEqual(['Abducción'])
      expect(await topics(ANA, true)).toContain('Abducción')
      // 🔴 The shared corpus got the NEW redaction, under the note's own id, with a callback id kept.
      const sent = sharedEnqueues()
      expect(sent).toHaveLength(1)
      expect((sent[0]!.args[0] as { documents: Array<{ id: string; text: string }> }).documents[0]).toMatchObject({ id: String(NOTE), text: after.r })
      expect((await rowsOf(pg!.db, sql`SELECT reindex_ingest_id AS x FROM documents WHERE id = ${NOTE}`))[0]!.x).toBeTruthy()
      ;(globalThis as { __graphGate?: Promise<void> }).__graphGate = Promise.resolve()
    }, 60_000)

    it('🔴 the old text is never re-exposed: no old graph row, no old text on the row', async () => {
      expect(await noteLabels()).toEqual(['Abducción'])
      const r = await row(NOTE)
      for (const col of [r.t, r.r]) expect(String(col)).not.toContain('Semiótica')
      // The same text is now the published one: nothing to publish.
      expect((await publicar(ANA, NOTE)).status).toBe(409)
    })

    it('🔴 duplicate promotions (two callbacks, or callback + graph end) run once', async () => {
      const rev = await changeAndWait()
      await pg!.db.execute(sql`UPDATE documents SET ingest_status = 'ready' WHERE id = ${rev}`)
      aiCalls.length = 0
      const both = await Promise.all([1, 2].map(() =>
        autoPublishParticipantDocument({ payload: payload!, documentId: rev, clientFor: (o) => getAdminAIClient(o) as never }),
      ))
      expect(both.filter((o) => o.published)).toHaveLength(1)
      expect(sharedEnqueues()).toHaveLength(1)
      expect(await revisionOf(NOTE)).toBeUndefined()
      expect(await noteLabels()).toEqual(['Abducción'])
    }, 60_000)

    it('🔴 concurrent Publicar cambios: one revision, one gate run', async () => {
      expect((await autosave(ANA, NOTE, { bodyMarkdown: nextBody() })).status).toBe(200)
      const perRun = await (async () => {
        await insertNote(950, SEMIOSIS, ANA, String((await row(NOTE)).b))
        const b = detectorCalls
        await publicar(ANA, 950)
        await eventually(async () => (await row(950)).a === 'ready', 20_000)
        return detectorCalls - b
      })()
      const before = detectorCalls
      const both = await Promise.all([publicar(ANA, NOTE), publicar(ANA, NOTE)])
      for (const res of both) expect([res.status, res.body.processing]).toEqual([202, true])
      expect(await eventually(async () => (await revisionOf(NOTE))?.g === 'ready', 20_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 500))
      expect(Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM documents WHERE revision_of_id = ${NOTE}`))[0]!.n)).toBe(1)
      expect(detectorCalls - before).toBe(perRun)
      expect(await landDraftIngest(Number((await revisionOf(NOTE))!.id))).toEqual({ published: true })
    }, 60_000)

    it('🔴 a reviewer\'s rows on the revision move onto the note (no cascade loss)', async () => {
      const rev = await changeAndWait()
      await pg!.db.execute(sql`INSERT INTO anonymisation_reviews (document_id, organization_id, reviewer_id, decision, text_edited) VALUES (${rev}, ${SEMIOSIS}, ${BETO}, 'approved', true)`)
      await pg!.db.execute(sql`UPDATE documents SET anonymisation_status = 'approved' WHERE id = ${rev}`)
      const count = async (id: number) =>
        Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM anonymisation_reviews WHERE document_id = ${id}`))[0]!.n)
      const onNote = await count(NOTE)
      expect(await landDraftIngest(rev)).toEqual({ published: true })
      expect(await count(NOTE)).toBe(onNote + 1)
      expect((await row(NOTE)).a).toBe('approved')
    }, 60_000)

    it.each(['rejected', 'held'])('🔴 a %s revision does not block a later attempt with changed text', async (verdict) => {
      const rev = await changeAndWait()
      await pg!.db.execute(sql`UPDATE documents SET anonymisation_status = ${verdict}, ingest_status = 'failed' WHERE id = ${rev}`)
      await pg!.db.execute(sql`INSERT INTO anonymisation_reviews (document_id, organization_id, reviewer_id, decision, text_edited) VALUES (${rev}, ${SEMIOSIS}, ${BETO}, 'rejected', false)`)
      // The same text: the verdict stands.
      expect((await publicar(ANA, NOTE)).status).toBe(409)
      const reviews = Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM anonymisation_reviews WHERE document_id = ${NOTE}`))[0]!.n)
      // Changed text: a fresh revision, gated from scratch; the old review rows kept on the note.
      const fresh = await changeAndWait()
      expect(fresh).not.toBe(rev)
      expect((await revisionOf(NOTE))!.a).toBe('ready')
      expect(Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM anonymisation_reviews WHERE document_id = ${NOTE}`))[0]!.n)).toBe(reviews + 1)
      expect(await landDraftIngest(fresh)).toEqual({ published: true })
    }, 60_000)

    it('🔴 withdrawn BEFORE the promotion: no re-index, the change is discarded', async () => {
      const rev = await changeAndWait()
      const before = await row(NOTE)
      await pg!.db.execute(sql`UPDATE documents SET publication_status = 'draft' WHERE id = ${NOTE}`) // unpublished
      aiCalls.length = 0
      expect(await landDraftIngest(rev)).toEqual({ published: false, reason: 'withdrawn' })
      expect(sharedEnqueues()).toHaveLength(0)
      expect(await revisionOf(NOTE)).toBeUndefined()
      expect([(await row(NOTE)).r, (await row(NOTE)).t]).toEqual([before.r, before.t])
      await pg!.db.execute(sql`UPDATE documents SET publication_status = 'published' WHERE id = ${NOTE}`)
    }, 60_000)

    it('🔴 withdrawn DURING the re-index: taken back out of the shared corpus, nothing swapped', async () => {
      const rev = await changeAndWait()
      const before = await row(NOTE)
      ;(globalThis as { __onEnqueue?: () => Promise<void> }).__onEnqueue = async () => {
        await pg!.db.execute(sql`UPDATE documents SET publication_status = 'unpublishing' WHERE id = ${NOTE}`)
      }
      aiCalls.length = 0
      try {
        expect(await landDraftIngest(rev)).toEqual({ published: false, reason: 'withdrawn' })
      } finally {
        ;(globalThis as { __onEnqueue?: () => Promise<void> }).__onEnqueue = undefined
      }
      expect(retiresOf(NOTE)).toHaveLength(1)
      expect([(await row(NOTE)).r, (await row(NOTE)).t]).toEqual([before.r, before.t])
      expect(await revisionOf(NOTE)).toBeUndefined()
      await pg!.db.execute(sql`UPDATE documents SET publication_status = 'published' WHERE id = ${NOTE}`)
    }, 60_000)

    describe('the re-index callback', () => {
      const SECRET = 'notes-callback-secret'
      const post = async (body: Record<string, unknown>) => {
        const { signCallback } = await import('./hmac')
        const raw = JSON.stringify(body)
        const timestamp = Math.floor(Date.now() / 1000)
        const { POST } = await import('../app/api/ai-service/callback/route')
        return POST(
          new Request('http://backend.test/api/ai-service/callback', {
            method: 'POST',
            body: raw,
            headers: {
              'content-type': 'application/json',
              'x-aiservice-timestamp': String(timestamp),
              'x-aiservice-signature': signCallback({ timestamp, body: raw, secret: SECRET }),
            },
          }),
        )
      }
      beforeAll(() => {
        vi.stubEnv('CALLBACK_SECRET', SECRET)
        vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
      })
      afterAll(() => vi.unstubAllEnvs())

      it('🔴 withdrawn AFTER the swap, before the re-index landed: the callback retires it again', async () => {
        const rev = await changeAndWait()
        expect(await landDraftIngest(rev)).toEqual({ published: true })
        const reindex = String((await rowsOf(pg!.db, sql`SELECT reindex_ingest_id AS x FROM documents WHERE id = ${NOTE}`))[0]!.x)
        // An unpublish ran (shared copy retired); ai-service's upsert then put it back.
        await pg!.db.execute(sql`UPDATE documents SET publication_status = 'draft' WHERE id = ${NOTE}`)
        aiCalls.length = 0
        const res = await post({ event: 'ingest.completed', ingestId: reindex, docId: String(NOTE), corpus: 'eco-8' })
        expect(res.status).toBe(200)
        expect(retiresOf(NOTE)).toHaveLength(1)
        expect((await rowsOf(pg!.db, sql`SELECT reindex_ingest_id AS x FROM documents WHERE id = ${NOTE}`))[0]!.x).toBeNull()
        expect((await row(NOTE)).p).toBe('draft') // untouched otherwise
      }, 60_000)

      it('still published when it lands: nothing retired', async () => {
        await pg!.db.execute(sql`UPDATE documents SET publication_status = 'published', reindex_ingest_id = 'ing-x' WHERE id = ${NOTE}`)
        aiCalls.length = 0
        expect((await post({ event: 'ingest.completed', ingestId: 'ing-x', docId: String(NOTE), corpus: 'eco-8' })).status).toBe(200)
        expect(retiresOf(NOTE)).toHaveLength(0)
        expect((await row(NOTE)).p).toBe('published')
      })

      it('🔴 the note was deleted: a shared-corpus ingest for a missing row is retired', async () => {
        aiCalls.length = 0
        expect((await post({ event: 'ingest.completed', ingestId: 'ing-y', docId: '99999', corpus: 'eco-8' })).status).toBe(200)
        expect(retiresOf(99999)).toHaveLength(1)
      })
    })

    it('deleting the note deletes its pending revision', async () => {
      await changeAndWait()
      await payload!.delete({ collection: 'documents', id: NOTE, overrideAccess: true })
      expect(
        Number((await rowsOf(pg!.db, sql`SELECT count(*)::int AS n FROM documents WHERE revision_of_id = ${NOTE} OR id = ${NOTE}`))[0]!.n),
      ).toBe(0)
    }, 60_000)
  })
})
