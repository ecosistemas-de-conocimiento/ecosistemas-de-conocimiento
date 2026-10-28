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

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'ing-test' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
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
        graphRequests.push(JSON.stringify(req))
        return {
          parsed: {
            entidades: [
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

  /**
   * 🔴 THE AUDIT'S RACE (2026-10-28). A pipeline write lands while an edit is in
   * flight. The whole-row `payload.update` writes the `draft` it read back over
   * `publishing`; the note endpoint's narrow write does not.
   */
  it('🔴 an edit racing a pipeline write: payload.update clobbers it, the note endpoint does not', async () => {
    await insertNote(500, SEMIOSIS, ANA)
    const midFlight = () => pg!.db.execute(sql`UPDATE documents SET publication_status = 'publishing', ingest_status = 'ready' WHERE id = 500`)
    const reset = () => pg!.db.execute(sql`UPDATE documents SET publication_status = 'draft', ingest_status = 'n/a' WHERE id = 500`)

    // Old path: the write lands between the update's read and its write.
    const db = payload!.db as unknown as { updateOne: (...a: unknown[]) => Promise<unknown> }
    const original = db.updateOne.bind(db)
    const spy = vi.spyOn(db, 'updateOne').mockImplementationOnce(async (...a: unknown[]) => {
      await midFlight()
      return original(...a)
    })
    const user = await payload!.findByID({ collection: 'users', id: ANA, overrideAccess: true })
    await payload!.update({
      collection: 'documents',
      id: 500,
      data: { bodyMarkdown: `${BODY} uno` } as never,
      user: { ...user, collection: 'users' } as never,
      overrideAccess: true,
    })
    spy.mockRestore()
    expect([(await row(500)).p, (await row(500)).i]).toEqual(['draft', 'n/a']) // clobbered

    // New path: same interleaving, after the endpoint's read.
    await reset()
    const findByID = payload!.findByID.bind(payload!)
    const read = vi.spyOn(payload!, 'findByID').mockImplementation((async (args: Parameters<Payload['findByID']>[0]) => {
      const out = await findByID(args)
      if (args.collection === 'documents') await midFlight()
      return out
    }) as never)
    const res = await autosave(ANA, 500, { bodyMarkdown: `${BODY} dos` })
    read.mockRestore()
    expect(res.status).toBe(200)
    const r = await row(500)
    expect([r.p, r.i, r.b]).toEqual(['publishing', 'ready', `${BODY} dos`])
  })
})
