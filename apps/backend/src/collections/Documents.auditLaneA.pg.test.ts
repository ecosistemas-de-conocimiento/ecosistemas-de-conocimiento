/**
 * 🔴 AUDIT 2026-10-28, LANE A — AGAINST A REAL POSTGRES AND THE REAL CONFIG.
 * `plan/auditoria-codigo-2026-10-28.md`, "Fix now" items 1 and 2, plus the
 * pipeline-column LOW.
 *
 *   1. `documents.mediaFile` must be the uploader's own file. A draft PATCH
 *      `{ mediaFile: <someone else's media id> }` used to make `afterChange`
 *      extract (or transcribe) the victim's file into the caller's row.
 *   2. A HELD gate verdict cannot be re-rolled on identical text through
 *      `POST /api/documents/:id/retry`. The detector is a model; re-running it
 *      until it says `ready` was an "ingest anyway" button.
 *   3. The pipeline-control columns are not the uploader's to write.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → the suite SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { staticDetector } from '../lib/anonymise'
import { anonymiseDocumentText } from '../lib/anonymiseDocument'
import {
  bootPayload,
  dockerOk,
  rowsOf,
  shutdown,
  startRealPostgres,
  type RealPostgres,
} from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.auditLaneA.pg.test] docker is not usable — the real-Postgres tests SKIP.')

let pg: RealPostgres
let payload: Payload

const OWNER = 1 // member of ecosistema 1; owns media 1. User 2 (ecosistema 2) owns media 2.
const ADMIN = 3 // platform admin
const OWN_MEDIA = 1
const FOREIGN_MEDIA = 2

/** The server-side writes the pipeline does: no user, no extract hook. */
const SERVER = { overrideAccess: true, context: { __skipDocsExtract: true } } as const

async function userRow(id: number) {
  const user = await payload.findByID({ collection: 'users', id, overrideAccess: true })
  return { ...user, collection: 'users' } as never
}

async function createAs(userId: number, data: Record<string, unknown>) {
  return payload.create({
    collection: 'documents',
    overrideAccess: false,
    user: await userRow(userId),
    context: { __skipDocsExtract: true },
    data: { kind: 'pdf', name: 'archivo', session: [], ...data } as never,
  })
}

async function updateAs(userId: number, id: number | string, data: Record<string, unknown>) {
  return payload.update({
    collection: 'documents',
    id: id as never,
    overrideAccess: false,
    user: await userRow(userId),
    context: { __skipDocsExtract: true },
    data: data as never,
  })
}

const row = async (id: number | string): Promise<Record<string, unknown>> =>
  (await rowsOf(pg.db, sql`SELECT * FROM documents WHERE id = ${Number(id)}`))[0] ?? {}

const errorPath = (err: unknown): string | undefined =>
  (err as { data?: { errors?: Array<{ path?: string }> } })?.data?.errors?.[0]?.path

function retryEndpoint(): Endpoint {
  const documents = payload.config.collections.find((c) => c.slug === 'documents')
  const found = documents?.endpoints && documents.endpoints.find((e) => e.path === '/:id/retry')
  if (!found) throw new Error('no POST /:id/retry')
  return found
}

async function retryAs(userId: number, id: number | string): Promise<number> {
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({ user: await userRow(userId) }, payload)) as PayloadRequest
  Object.assign(req, { routeParams: { id: String(id) } })
  return (await retryEndpoint().handler(req)).status
}

describe.skipIf(!dockerOk)('audit 2026-10-28 lane A, on a real Postgres', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-audit-a-pg-${process.pid}`, 'audit_a_test')
    payload = await bootPayload(pg.url, 'audit-lane-a-secret')
  }, 90_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (1, 'owner@example.invalid', false), (2, 'victim@example.invalid', false),
        (3, 'admin@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (2, 2, 'member');
      INSERT INTO media (id, uploaded_by_id, organization_id, filename, mime_type) VALUES
        (1, 1, 1, 'mio.pdf', 'application/pdf'),
        (2, 2, 2, 'ajeno.pdf', 'application/pdf'),
        (3, 3, 1, 'admin.pdf', 'application/pdf');
      SELECT setval('media_id_seq', 10);
    `))
  })

  // -------------------------------------------------------------------------
  // 1. mediaFile is the uploader's own file
  // -------------------------------------------------------------------------

  describe('🔴 item 1: `mediaFile` must be the uploader’s own file', () => {
    it('refuses a foreign media id on CREATE', async () => {
      const err = await createAs(OWNER, { mediaFile: FOREIGN_MEDIA }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(errorPath(err)).toBe('mediaFile')
      expect(await rowsOf(pg.db, sql`SELECT id FROM documents`)).toHaveLength(0)
    })

    it('accepts the uploader’s own media on create', async () => {
      const doc = await createAs(OWNER, { mediaFile: OWN_MEDIA })
      expect(Number((await row(doc.id)).media_file_id)).toBe(OWN_MEDIA)
    })

    it('refuses re-pointing an existing draft at a foreign media id (the audit’s PATCH)', async () => {
      const doc = await createAs(OWNER, { mediaFile: OWN_MEDIA })
      const err = await updateAs(OWNER, doc.id, { mediaFile: FOREIGN_MEDIA, extractedText: '' }).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect(errorPath(err)).toBe('mediaFile')
      expect(Number((await row(doc.id)).media_file_id)).toBe(OWN_MEDIA)
    })

    it('a markdown note with no file, and an ordinary rename of a filed row, still work', async () => {
      const note = await createAs(OWNER, { kind: 'markdown', bodyMarkdown: 'hola' })
      expect((await row(note.id)).media_file_id).toBeNull()
      const doc = await createAs(OWNER, { mediaFile: OWN_MEDIA })
      await updateAs(OWNER, doc.id, { name: 'renombrado' })
      expect((await row(doc.id)).name).toBe('renombrado')
    })

    it('a platform admin’s write is unchanged — they may attach a file for someone', async () => {
      const doc = await createAs(OWNER, { mediaFile: OWN_MEDIA })
      await updateAs(ADMIN, doc.id, { mediaFile: 3 })
      expect(Number((await row(doc.id)).media_file_id)).toBe(3)
    })

    it('a server-side write (seed, pipeline: no user) is unchanged', async () => {
      const doc = await payload.create({
        collection: 'documents',
        ...SERVER,
        data: {
          kind: 'pdf',
          name: 'seed',
          session: [],
          organization: 1,
          uploadedBy: OWNER,
          mediaFile: FOREIGN_MEDIA,
        } as never,
      })
      expect(Number((await row(doc.id)).media_file_id)).toBe(FOREIGN_MEDIA)
    })
  })

  // -------------------------------------------------------------------------
  // 2. A held verdict is not re-rolled on identical text
  // -------------------------------------------------------------------------

  describe('🔴 item 2: retry on a HELD row needs new text', () => {
    /** "Ana" is found, then "Beltrán" survives the redaction: verify holds. */
    const missesThenFinds = () =>
      staticDetector((text) =>
        text.includes('[Persona ')
          ? [{ text: 'Beltrán', type: 'persona' as const }]
          : [{ text: 'Ana', type: 'persona' as const }],
      )
    const HELD_TEXT = 'Ana habló con Ana Beltrán en la asamblea.'

    /** A testimonio the real gate held, left `failed` as the ingest path leaves it. */
    async function heldTestimonio(): Promise<number> {
      const doc = await payload.create({
        collection: 'documents',
        ...SERVER,
        data: {
          kind: 'pdf',
          name: 'testimonio',
          session: [],
          organization: 1,
          uploadedBy: OWNER,
          contentKind: 'testimonio',
          extractedText: HELD_TEXT,
          ingestStatus: 'failed',
        } as never,
      })
      const outcome = await anonymiseDocumentText({
        payload: payload as never,
        docId: doc.id,
        contentKind: 'testimonio',
        text: HELD_TEXT,
        detector: missesThenFinds(),
      })
      expect(outcome.ok).toBe(false)
      expect((await row(doc.id)).anonymisation_status).toBe('held')
      return Number(doc.id)
    }

    it('the gate stores a hash of the text it held', async () => {
      const id = await heldTestimonio()
      expect(String((await row(id)).held_text_hash)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('🔴 refuses /retry on a held row whose text is unchanged — the verdict stands', async () => {
      const id = await heldTestimonio()
      expect(await retryAs(OWNER, id)).toBe(409)
      const after = await row(id)
      expect(after.anonymisation_status).toBe('held')
      expect(after.held_text).not.toBeNull()
    })

    it('allows /retry once the text differs from what was held', async () => {
      const id = await heldTestimonio()
      // Below the app, as a re-extraction would: the user-edit path resets the
      // gate itself (`gateResetForTextEdit`) and never needs a retry.
      await pg.db.execute(sql`UPDATE documents SET extracted_text = 'Texto corregido sin nombres.' WHERE id = ${id}`)
      expect(await retryAs(OWNER, id)).toBe(202)
      const after = await row(id)
      expect(after.anonymisation_status).toBe('n/a')
      expect(after.held_text_hash).toBeNull()
    })

    it('a held row with no stored hash (held before 2026-10-28) is refused — fail closed', async () => {
      const id = await heldTestimonio()
      await pg.db.execute(sql`UPDATE documents SET held_text_hash = NULL WHERE id = ${id}`)
      expect(await retryAs(OWNER, id)).toBe(409)
    })

    // R78: the transcript editor's body on a held row. Whitespace and case are
    // not a new source, so they must not clear the hold for a re-roll.
    const editorBody = (extractedText: string) => ({
      extractedText,
      ingestId: null,
      ingestStatus: 'pending',
      ingestError: null,
    })

    it('🔴 R78: a trivial transcript edit (whitespace/case) on a held row keeps the hold — 409', async () => {
      const id = await heldTestimonio()
      const before = await row(id)
      for (const trivial of [HELD_TEXT + ' ', `  ${HELD_TEXT.replace(' ', '\n\t ')}`, HELD_TEXT.toUpperCase()]) {
        const err = await updateAs(OWNER, id, editorBody(trivial)).catch((e: unknown) => e)
        expect(err, JSON.stringify(trivial)).toBeInstanceOf(Error)
        expect((err as { status?: number }).status).toBe(409)
      }
      const after = await row(id)
      expect(after.anonymisation_status).toBe('held')
      expect(after.held_text).toBe(before.held_text)
      expect(after.held_text_hash).toBe(before.held_text_hash)
      expect(after.extracted_text).toBe(HELD_TEXT)
      expect(after.ingest_status).toBe('failed')
      expect(await retryAs(OWNER, id)).toBe(409)
    })

    it('🔴 R78: /retry refuses a held row whose text changed only trivially below the app', async () => {
      const id = await heldTestimonio()
      await pg.db.execute(sql`UPDATE documents SET extracted_text = ${HELD_TEXT.toLowerCase() + '  '} WHERE id = ${id}`)
      expect(await retryAs(OWNER, id)).toBe(409)
      expect((await row(id)).anonymisation_status).toBe('held')
    })

    it('R78: a real transcript edit on a held row still clears the hold and re-gates', async () => {
      const id = await heldTestimonio()
      await updateAs(OWNER, id, editorBody('Texto corregido sin nombres.'))
      const after = await row(id)
      expect(after.extracted_text).toBe('Texto corregido sin nombres.')
      expect(after.anonymisation_status).toBe('n/a')
      expect(after.held_text).toBeNull()
      expect(after.held_text_hash).toBeNull()
      expect(after.ingest_status).toBe('pending')
    })

    it('an ordinary technical failure is still retryable', async () => {
      const doc = await payload.create({
        collection: 'documents',
        ...SERVER,
        data: {
          kind: 'pdf', name: 'doc', session: [], organization: 1, uploadedBy: OWNER,
          extractedText: 'texto', ingestStatus: 'failed',
        } as never,
      })
      expect(await retryAs(OWNER, doc.id)).toBe(202)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Pipeline-control columns
  // -------------------------------------------------------------------------

  describe('pipeline-control columns are not the uploader’s to write', () => {
    it('drops transcribeAttempt, transcribeId, publishIngestId, graphStatus and kind from a user PATCH', async () => {
      const doc = await createAs(OWNER, { mediaFile: OWN_MEDIA })
      const before = await row(doc.id)
      await updateAs(OWNER, doc.id, {
        transcribeAttempt: 7,
        transcribeId: 'forged',
        publishIngestId: 'forged',
        graphStatus: 'pending',
        kind: 'audio',
        name: 'ok',
      })
      const after = await row(doc.id)
      expect(after.name).toBe('ok')
      for (const col of ['transcribe_attempt', 'transcribe_id', 'publish_ingest_id', 'graph_status', 'kind']) {
        expect(after[col], col).toEqual(before[col])
      }
    })

    it('ingestStatus/ingestId move only with a text edit (the transcript editor), never alone', async () => {
      const doc = await payload.create({
        collection: 'documents',
        ...SERVER,
        data: {
          kind: 'pdf', name: 'doc', session: [], organization: 1, uploadedBy: OWNER,
          extractedText: 'texto', ingestStatus: 'failed', ingestId: 'old',
        } as never,
      })
      await updateAs(OWNER, doc.id, { ingestStatus: 'pending', ingestId: null })
      expect((await row(doc.id)).ingest_status).toBe('failed')
      expect((await row(doc.id)).ingest_id).toBe('old')

      // The web transcript editor's exact body (`transcript/+server.ts`).
      await updateAs(OWNER, doc.id, {
        extractedText: 'texto corregido',
        ingestId: null,
        ingestStatus: 'pending',
        ingestError: null,
      })
      const after = await row(doc.id)
      expect(after.extracted_text).toBe('texto corregido')
      expect(after.ingest_status).toBe('pending')
      expect(after.ingest_id).toBeNull()
    })
  })
})
