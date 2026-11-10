/**
 * 🔴 A REVISION ALREADY IN FLIGHT WHEN ITS NOTE IS HELD SENDS NOTHING MORE —
 * AGAINST A REAL POSTGRES (ola 11).
 *
 * The revision row's own flag stays false: only its note is held, midway.
 *
 *   · `enqueueIngestForDoc`'s first check: no detector call;
 *   · its check before the claim: the row is never claimed `embedding`;
 *   · the re-check AFTER the claim: a hold that lands between the check and
 *     the claim still sends nothing, and the claim is handed back;
 *   · `readGraphableRow` (`lib/graph/schedule.ts`): no graph model call;
 *   · `regateDocumentsById`: a revision named by id is refused.
 *
 * Harness: `lib/testing/realPostgres`. The gate, the claim write and the
 * ai-service client are wrapped spies around the real ones.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({ ingestId: 'fake-ingest' })) }))
vi.mock('@/lib/aiClient', () => {
  const client = {
    ingest: { enqueue: ai.enqueue },
    admin: { setDocumentValidity: vi.fn(async () => ({})), deleteDocument: vi.fn(async () => ({})) },
  }
  return { getAdminAIClient: () => client, getAppAIClient: () => client }
})

/** `duringGate`: runs inside the gate (the detector), before it answers. */
const gate = vi.hoisted(() => ({ calls: 0, duringGate: null as null | (() => Promise<unknown>) }))
vi.mock('@/lib/anonymiseDocument', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/anonymiseDocument')>()
  return {
    ...real,
    anonymiseDocumentText: async (...args: Parameters<typeof real.anonymiseDocumentText>) => {
      gate.calls += 1
      if (gate.duringGate) await gate.duringGate()
      return real.anonymiseDocumentText(...args)
    },
  }
})

/** Every column write; `beforeClaim` runs right before the `embedding` claim. */
const writes = vi.hoisted(() => ({ data: [] as unknown[], beforeClaim: null as null | (() => Promise<unknown>) }))
vi.mock('@/lib/documentColumns', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/documentColumns')>()
  return {
    ...real,
    updateDocumentColumns: async (...args: Parameters<typeof real.updateDocumentColumns>) => {
      const data = (args[1] as { data?: { ingestStatus?: unknown } }).data
      writes.data.push(data)
      if (data?.ingestStatus === 'embedding' && writes.beforeClaim) await writes.beforeClaim()
      return real.updateDocumentColumns(...args)
    },
  }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

const NOTE = 91
const REVISION = 92
const TEXT = 'Una nota larga sobre parteras, nacimientos y la clínica del pueblo, para pasar el mínimo.'.repeat(4)
let pg: RealPostgres
let payload: Payload
const run = (s: string) => pg.db.execute(sql.raw(s))
const holdNote = () => run(`UPDATE documents SET consent_held = true WHERE id = ${NOTE}`)
const row = async (id: number) =>
  (await rowsOf(pg.db, sql`SELECT ingest_status, ingest_id, consent_held FROM documents WHERE id = ${id}`))[0]
const claims = () => writes.data.filter((d) => (d as { ingestStatus?: unknown })?.ingestStatus === 'embedding')

/** The revision as `runExtractAndIngest` read it (depth 1), before its note was held. */
const fresh = {
  name: 'nota',
  kind: 'markdown',
  contentKind: 'documento',
  anonymise: false,
  anonymisationStatus: 'n/a',
  consentHeld: false,
  revisionOf: { id: NOTE, consentHeld: false },
} as const
const enqueue = async () => {
  const { enqueueIngestForDoc } = await import('@/collections/Documents')
  await enqueueIngestForDoc({
    payload,
    docId: REVISION,
    organizationId: 1,
    uploadedById: 1,
    fresh: fresh as never,
    extractedText: TEXT,
  })
}

describe.skipIf(!dockerOk)('a revision in flight when its note is held', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-inflight-${process.pid}`, 'consent_inflight')
    payload = await bootPayload(pg.url, 'consent-inflight-secret')
    process.env.AI_SERVICE_CALLBACK_SECRET ??= 'x'
  }, 120_000)

  beforeEach(async () => {
    ai.enqueue.mockClear()
    gate.calls = 0
    gate.duringGate = null
    writes.data = []
    writes.beforeClaim = null
    await run(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, body_markdown, name, ingest_status, ingest_id,
                             graph_status, consent_held, revision_of_id)
        VALUES (${NOTE}, 1, 1, 'published', 'markdown', 'documento', false, 'n/a', '${TEXT}', '${TEXT}', 'nota', 'ready', 'i-91', 'ready', false, NULL),
               (${REVISION}, 1, 1, 'draft', 'markdown', 'documento', false, 'n/a', '${TEXT}', '${TEXT}', 'nota', 'extracting', NULL, 'pending', false, ${NOTE});
    `)
    await run(`SELECT setval(pg_get_serial_sequence('documents', 'id'), 1000)`)
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('control: a revision of a free note is gated, claimed and sent', async () => {
    await enqueue()
    expect(gate.calls).toBe(1)
    expect(claims()).toHaveLength(1)
    expect(ai.enqueue).toHaveBeenCalledTimes(1)
  })

  it('enqueueIngestForDoc, first check: the note held before it ran → no detector call', async () => {
    await holdNote()
    await enqueue()
    expect(gate.calls).toBe(0)
    expect(claims()).toEqual([])
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('enqueueIngestForDoc, check before the claim: the note held during the gate → never claimed, nothing sent', async () => {
    gate.duringGate = holdNote
    await enqueue()
    expect(gate.calls).toBe(1)
    expect(claims()).toEqual([])
    expect(ai.enqueue).not.toHaveBeenCalled()
    expect(await row(REVISION)).toMatchObject({ ingest_status: 'extracting', ingest_id: null })
  })

  it('after the claim: the note held between the check and the claim → nothing sent, the claim handed back', async () => {
    writes.beforeClaim = holdNote
    await enqueue()
    expect(claims()).toHaveLength(1)
    expect(ai.enqueue).not.toHaveBeenCalled()
    expect(await row(REVISION)).toMatchObject({ ingest_status: 'extracting', ingest_id: null, consent_held: false })
  })

  describe('readGraphableRow', () => {
    const sync = vi.fn(async (_req: unknown) => ({
      parsed: { entidades: [{ tipo: 'tema', etiqueta: 'Partería', menciones: 2 }], relaciones: [] },
    }))
    const graph = async () => {
      const { runGraphExtraction } = await import('./graph/schedule')
      return runGraphExtraction({
        payload: payload as never,
        docId: REVISION,
        organizationId: 1,
        contentKind: 'documento',
        anonymise: false,
        publicationStatus: 'draft',
        text: TEXT,
        title: 'nota',
        client: { generate: { sync } } as never,
      })
    }
    beforeEach(() => sync.mockClear())

    it('control: a revision of a free note is graphed', async () => {
      expect(await graph()).toBe('ready')
      expect(sync).toHaveBeenCalled()
    })

    it('the note held after the job was queued → no graph model call', async () => {
      await holdNote()
      expect(await graph()).toBe('skipped')
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('regateDocumentsById refuses a revision of a held note named by id', async () => {
    await holdNote()
    const { regateDocumentsById } = await import('./regateDocumentsById')
    const report = await regateDocumentsById(payload, {
      ids: [REVISION],
      organizationId: 1,
      apply: false,
      client: {} as never,
      gate: vi.fn(),
    })
    expect(report.lines[0]?.refused).toBe('consent-held')
  })
})
