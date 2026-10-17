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

import { apiGet, pollUntil, type Caller } from './support/api'
import { draftCorpusName, onFakeProvider, retrieveAs } from './support/ai'
import { fixtures } from './support/fixtures'
import { stackDown } from './support/stack'
import { docRow, uploadPdfDocument, uploadPdfTextDocument, type DocRow } from './support/upload'
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

/**
 * The fake provider's scripted reply: `[[FAKE_REPLY:<base64 of UTF-8 text>]]`
 * anywhere in a prompt makes the model answer exactly that text
 * (`services/ai-service/test-support/fake-provider/README.md`). The detector
 * sends the document text as its user prompt, so a directive printed in the PDF
 * reaches the fake on BOTH gate calls: stage 3 (content) and stage 4 (verify).
 *
 * The reply is the detector's own contract (`lib/anonymise/detector.ts`
 * `DETECT_SYSTEM_PROMPT`): `{"hallazgos":[{"texto","tipo"}]}`.
 */
function fakeReply(json: unknown): string {
  const directive = `[[FAKE_REPLY:${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}]]`
  // ⚠ ONE PDF LINE, AND IT MUST FIT THE PAGE. `scripts/lib/txt_to_pdf.py` never
  // breaks a word, and the extractor drops glyphs past the right edge: measured
  // 2026-10-17 with unpdf, a 103-character directive came back cut at about 90
  // characters, so the fake saw no directive at all. 88 keeps it whole.
  if (directive.length > 88) {
    throw new Error(`FAKE_REPLY directive is ${directive.length} chars; keep it to 88 so it fits one PDF line`)
  }
  return directive
}

/** The gate's verdict, then the ingest it releases. */
async function settled(caller: Caller, id: number, what: string): Promise<DocRow> {
  return pollUntil(
    what,
    () => docRow(caller, id),
    (r) => r.ingestStatus === 'ready' || r.ingestStatus === 'failed' || r.anonymisationStatus === 'held',
    { timeoutMs: 120_000, intervalMs: 1500 },
  )
}

describe.skipIf(stackDown || !onFakeProvider)('anonymisation gate — passes a detector that answers', () => {
  // Words only these two documents contain. ASCII and digit-free, so no
  // deterministic rule (dates, phones, long numbers) touches them.
  const CLEAN_MARKER = 'tejocotes del solar comunitario'
  const SPAN_MARKER = 'molino de nixtamal'
  // Not a roster member of the world, so only the detector can remove it.
  // Short on purpose: the scripted reply that names it must fit one PDF line.
  const SPAN_NAME = 'Eva Ruiz'

  let world: World
  let cleanId: number
  let spanId: number

  beforeAll(async () => {
    world = await provisionWorld()

    // Stage 3 finds nothing; stage 4 re-runs over the same text and finds nothing.
    cleanId = await uploadPdfTextDocument(
      world.alice.caller,
      `${world.ns} testimonio limpio`,
      [
        `Cada temporada cosechamos los ${CLEAN_MARKER} y los repartimos entre todas.`,
        'Nadie se queda sin su parte, y eso nos sostiene.',
        fakeReply({ hallazgos: [] }),
      ].join('\n'),
      { contentKind: 'testimonio' },
    )

    // Stage 3 reports the name. Stage 4 gets the same scripted reply, but over
    // the REDACTED text the name no longer occurs, so `parseFindings` drops it
    // and verify is clean. One directive serves both calls.
    spanId = await uploadPdfTextDocument(
      world.alice.caller,
      `${world.ns} testimonio con nombre`,
      [
        `${SPAN_NAME} abrio el ${SPAN_MARKER} cuando llego al pueblo.`,
        `Desde entonces ${SPAN_NAME} muele el maiz de todo el barrio.`,
        fakeReply({ hallazgos: [{ texto: SPAN_NAME, tipo: 'persona' }] }),
      ].join('\n'),
      { contentKind: 'testimonio' },
    )
  }, 120_000)

  it('🔴 a clean detection clears the gate on its own, then the testimonio is ingested', async () => {
    const row = await settled(world.alice.caller, cleanId, 'the clean testimonio to be ingested')
    // `ready` is the gate's own clean verdict (`lib/anonymiseDocument.ts`);
    // `approved` is a human releasing a hold, which nobody did here.
    expect(row.anonymisationStatus, `ingestError: ${row.ingestError}`).toBe('ready')
    expect(row.ingestStatus, `ingestError: ${row.ingestError}`).toBe('ready')
    expect(row.ingestId).toBeTruthy()
  })

  it('a detected name clears the gate too, once it is replaced', async () => {
    const row = await settled(world.alice.caller, spanId, 'the testimonio with a name to be ingested')
    expect(row.anonymisationStatus, `ingestError: ${row.ingestError}`).toBe('ready')
    expect(row.ingestStatus, `ingestError: ${row.ingestError}`).toBe('ready')
  })

  /**
   * 🔴 Checked in ai-service's own store: the row says what the backend meant to
   * send, the corpus says what it sent.
   */
  it("🔴 ai-service holds the redacted text in the ecosistema's draft corpus, never the name", async () => {
    const probe = await retrieveAs(
      world.orgA.id,
      draftCorpusName(world.orgA.id, world.alice.id),
      CLEAN_MARKER,
    )
    expect(probe.status, probe.text.slice(0, 300)).toBe(200)
    const embedded = probe.chunks.map((c) => c.text).join('\n')

    // The clean testimonio, as written.
    expect(embedded).toContain(CLEAN_MARKER)
    // The other one, redacted: its own words are there, the name is not, and
    // the pseudonym stands where the name was.
    expect(embedded).toContain(SPAN_MARKER)
    expect(embedded).not.toContain(SPAN_NAME)
    expect(embedded).not.toContain('Ruiz')
    expect(embedded).toMatch(/\[Persona A\] abrio el molino de nixtamal/)
  })
})
