/**
 * 🔴 THE ANONYMISATION GATE FAILS CLOSED, on the real pipeline (finding I-6).
 *
 * A `testimonio` PDF goes through the real upload → extract → gate path. The
 * gate's detector is a model call through ai-service, and on this stack ai-service
 * talks to the TEST-ONLY fake provider, whose answer is marked prose — never the
 * JSON the detector asks for. So the detector cannot run, and the only correct
 * outcome is a HOLD: nothing ingested, the row says why.
 *
 * Nothing here is seeded. The row's statuses are written by the gate itself
 * (`lib/anonymiseDocument.ts`, `collections/Documents.ts` → `enqueueIngestForDoc`),
 * and the "not ingested" claim is checked in ai-service's own store.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, pollUntil } from './support/api'
import { draftCorpusName, onFakeProvider, retrieveAs } from './support/ai'
import { fixtures } from './support/fixtures'
import { stackDown } from './support/stack'
import { docRow, uploadPdfDocument } from './support/upload'
import { provisionWorld, type World } from './support/world'

describe.skipIf(stackDown || !onFakeProvider)('anonymisation gate — fail-closed on a real upload', () => {
  let world: World
  let docId: number

  beforeAll(async () => {
    world = await provisionWorld()
    docId = await uploadPdfDocument(world.alice.caller, `${world.ns} testimonio pdf`, {
      contentKind: 'testimonio',
    })
  }, 120_000)

  it('🔴 a testimonio whose detector cannot answer ends HELD, with the reason on ingestError', async () => {
    const row = await pollUntil(
      'the testimonio to settle at the gate',
      () => docRow(world.alice.caller, docId),
      (r) => r.anonymisationStatus === 'held' || r.ingestStatus === 'ready',
      { timeoutMs: 120_000, intervalMs: 1500 },
    )

    expect(row.anonymisationStatus).toBe('held')
    // `failed`, not a spinner: the gate must not leave the row at a
    // non-terminal `extracting` with nothing left to move it.
    expect(row.ingestStatus).toBe('failed')
    expect(row.ingestError).toMatch(/^anonymisation_held: /)
    // 🔴 WHICH failure. `respuesta-no-json` is the class the detector throws
    // when the model answered but not in JSON — so the call DID reach ai-service
    // and the fake provider. A `transporte` failure would hold too, but would
    // mean this test never exercised the detector at all.
    expect(row.ingestError).toMatch(/content: .*respuesta-no-json/)
    // Never enqueued.
    expect(row.ingestId ?? null).toBeNull()
  })

  it('🔴 nothing from the held testimonio reached ai-service', async () => {
    const corpus = draftCorpusName(world.orgA.id, world.alice.id)
    const probe = await retrieveAs(world.orgA.id, corpus, fixtures().pdf.marker)
    // 404 (the corpus was never created) or 200 with nothing in it. Either way
    // not one chunk.
    expect([200, 404], probe.text.slice(0, 300)).toContain(probe.status)
    expect(probe.chunks).toHaveLength(0)
  })

  it('the hold lands in the review queue, carrying the stage the gate stopped at', async () => {
    const res = await apiGet(world.alice.caller, `/api/holds?organization=${world.orgA.id}`)
    expect(res.status).toBe(200)
    const mine = res.body.holds.find((h: { id: string }) => String(h.id) === String(docId))
    expect(mine, `hold ${docId} is missing from the queue`).toBeTruthy()
    expect(mine.stage).toBe('content')
  })
})
