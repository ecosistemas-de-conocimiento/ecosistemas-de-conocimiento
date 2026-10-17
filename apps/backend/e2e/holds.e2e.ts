/**
 * THE HOLD DECISION PATH, against the running stack.
 *
 * When the anonymisation gate refuses a document it does not fail it — it HOLDS
 * it, and a person with `holds:review` reads the refused text and either
 * approves it into the corpus or rejects it forever. That path returned 500
 * until recently and so had never been exercised anywhere but unit tests.
 *
 * ── WHAT THIS FILE ADDS OVER `lib/holdReview.test.ts` ────────────────────────
 *
 * The unit tests pin the logic against a fake Payload. What only a live run can
 * say is that the three HTTP routes exist, that Next's route handlers wire
 * `payload.auth(headers)` to the same permission check, that the refusal really
 * is a 404 on the wire rather than a 403, and that the audit row and the
 * document flip land in POSTGRES inside one request.
 *
 * ── 🔴 WHY THIS FILE SEEDS ITS OWN HOLD ──────────────────────────────────────
 *
 * A decision is TERMINAL and a held row cannot be created through the API — see
 * the long note in `support/db.ts`. So this suite makes its own held document,
 * decides on THAT, and never touches a hold it did not create. Any hold already
 * in the database is read and asserted against, and left holding. The one
 * hand-made review fixture in the shared dev database was consumed this way
 * once already; that is what the rule exists to prevent.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { anonymous, apiGet, apiJson, pollUntil, type Caller } from './support/api'
import { draftCorpusName, onFakeProvider, retrieveAs } from './support/ai'
import { dbAccess, exec, sql } from './support/db'
import { fixtures } from './support/fixtures'
import { stackDown } from './support/stack'
import { docRow, uploadPdfDocument } from './support/upload'
import { createTextDocument, provisionWorld, type World } from './support/world'

/**
 * The gate's refused output for our seeded hold, and the two identifiers it
 * says are still in it.
 *
 * ⚠ The offsets are COMPUTED FROM THE STRING, never written by hand. Doing this
 * arithmetic by eye is exactly how the shared fixture ended up with highlights
 * pointing at the wrong characters, and a test that hardcodes 58 and 64 would
 * silently stop meaning anything the first time the sentence is reworded.
 */
const HELD_TEXT =
  'Mi nombre es [Persona A] y vivo en [Domicilio A]. Mi hija Lupita estudia cerca. ' +
  'Si necesitan algo me marcan al 55 4821 9930.'

const SURVIVOR_WORDS: { text: string; type: string }[] = [
  { text: 'Lupita', type: 'persona' },
  { text: '55 4821 9930', type: 'contacto' },
]

function survivorSpans(): { start: number; end: number; type: string }[] {
  return SURVIVOR_WORDS.map(({ text, type }) => {
    const start = HELD_TEXT.indexOf(text)
    if (start < 0) throw new Error(`[e2e] "${text}" is not in HELD_TEXT — the fixture is incoherent`)
    return { start, end: start + text.length, type }
  })
}

const GATE_ERROR = 'verify: La verificacion encontro 2 datos que todavia identifican a una persona.'
const GATE_REPORT = { stage: 'verify', removed: { persona: 1, contacto: 1 } }

const db = dbAccess()
/**
 * ⚠ SKIPPED, NOT DEGRADED. Without SQL we cannot MAKE a hold, and the only
 * other way to exercise a decision would be to spend somebody else's fixture.
 * A gap is better than damage — see `support/db.ts`.
 */
const noSeed = stackDown || !db.ok

if (!stackDown && !db.ok) {
  console.error(
    `\n[e2e] holds: the decision tests are SKIPPED — ${db.reason}\n` +
      `      The read-only hold assertions still run.\n`,
  )
}

describe.skipIf(stackDown)('holds — the anonymisation review queue', () => {
  let world: World
  /** Our own held document. Every destructive assertion aims at this and only this. */
  let heldId: number | null = null
  /**
   * 🔴 A REAL hold: a `testimonio` PDF the gate refused on its own, because the
   * fake provider cannot answer the detector in JSON. No column of it is seeded.
   * The approval tests decide on THIS, so "approved → ingested" is proven on an
   * ingestable kind, all the way into ai-service.
   */
  let pdfHeldId: number | null = null
  /** Someone with `holds:review` in orgA. `owner` inherits it; `member` does not. */
  let reviewer: Caller
  /** A colleague in the SAME ecosistema who may NOT review. */
  let outsider: Caller

  beforeAll(async () => {
    world = await provisionWorld()
    reviewer = world.alice.caller
    outsider = world.bob.caller

    if (!db.ok) return

    // Created through the ORDINARY API first, so the row has a real owner, a
    // real ecosistema and a real audit trail behind it. Only the gate's own
    // columns — which no API caller may write — are set by hand afterwards.
    const doc = await createTextDocument(
      reviewer,
      `${world.ns} held fixture`,
      'Yo llegue a [Domicilio 1] en 2019 buscando trabajo. Mi hermana Lupita me ayudo.',
      { contentKind: 'testimonio' },
    )
    heldId = Number(doc.id)

    exec(
      `update documents set
         anonymisation_status    = 'held',
         anonymisation_error     = :'err',
         anonymisation_report    = :'report'::jsonb,
         held_text               = :'held',
         anonymisation_survivors = :'survivors'::jsonb,
         redacted_text           = null
       where id = :'id'`,
      {
        id: heldId,
        err: GATE_ERROR,
        report: JSON.stringify(GATE_REPORT),
        held: HELD_TEXT,
        survivors: JSON.stringify(survivorSpans()),
      },
    )

    if (onFakeProvider) {
      pdfHeldId = await uploadPdfDocument(reviewer, `${world.ns} held pdf`, {
        contentKind: 'testimonio',
      })
      await pollUntil(
        'the testimonio PDF to be held by the gate',
        () => docRow(reviewer, pdfHeldId!),
        (r) => r.anonymisationStatus === 'held' || r.ingestStatus === 'ready',
        { timeoutMs: 120_000, intervalMs: 1500 },
      )
    }
  }, 300_000)

  // ── the queue ──────────────────────────────────────────────────────────────

  describe.skipIf(noSeed)('the queue', () => {
    it('lists the held document for a reviewer in its ecosistema', async () => {
      const res = await apiGet(reviewer, `/api/holds?organization=${world.orgA.id}`)
      expect(res.status).toBe(200)
      expect(String(res.body.ecosystem.id)).toBe(String(world.orgA.id))

      const mine = res.body.holds.find((h: { id: string }) => String(h.id) === String(heldId))
      expect(mine, `hold ${heldId} is missing from the queue`).toBeTruthy()
      expect(mine.survivorCount).toBe(SURVIVOR_WORDS.length)
      expect(mine.stage).toBe('verify')
    })

    /**
     * 🔴 THE PRIVACY CONTRACT OF THE LIST. The queue is a page a reviewer opens
     * before deciding they are the right person to read this — so it must not
     * leak the text, and it must not leak the UPLOADER'S OWN TITLE either. The
     * title is one of three fixed neutral strings chosen from `contentKind`.
     */
    it('carries no text and no uploader-typed name', async () => {
      const res = await apiGet(reviewer, `/api/holds?organization=${world.orgA.id}`)
      const mine = res.body.holds.find((h: { id: string }) => String(h.id) === String(heldId))

      expect(mine.title).not.toContain(world.ns)
      expect(['Documento retenido', 'Testimonio retenido', 'Conversación retenida']).toContain(
        mine.title,
      )

      // Nothing anywhere in the serialised row may quote the held text.
      const serialised = JSON.stringify(res.body)
      expect(serialised).not.toContain('Lupita')
      expect(serialised).not.toContain('55 4821 9930')
      expect(serialised).not.toContain('[Persona A]')
    })

    it('refuses a request that does not name an ecosistema', async () => {
      const res = await apiGet(reviewer, '/api/holds')
      expect(res.status).toBe(400)
    })

    it('is 401 for an anonymous caller', async () => {
      const res = await apiGet(anonymous, `/api/holds?organization=${world.orgA.id}`)
      expect(res.status).toBe(401)
    })

    /**
     * 🔴 404, NOT 403 — and the SAME 404. `member` does not carry
     * `holds:review`, and telling them "you may not" would confirm there is
     * something here to be denied. The whole point is that a queue you cannot
     * review is indistinguishable from one that does not exist.
     */
    it('a colleague in the same ecosistema without holds:review gets 404, not 403', async () => {
      const res = await apiGet(outsider, `/api/holds?organization=${world.orgA.id}`)
      expect(res.status).toBe(404)
      expect(res.status).not.toBe(403)
    })

    it('a reviewer in ANOTHER ecosistema gets the same 404, with the same body', async () => {
      const foreign = await apiGet(world.carol.caller, `/api/holds?organization=${world.orgA.id}`)
      const denied = await apiGet(outsider, `/api/holds?organization=${world.orgA.id}`)
      expect(foreign.status).toBe(404)
      expect(foreign.text).toBe(denied.text)
    })
  })

  // ── the detail page ────────────────────────────────────────────────────────

  describe.skipIf(noSeed)('the held document itself', () => {
    it('returns the refused text, the offsets and the report', async () => {
      const res = await apiGet(reviewer, `/api/holds/${heldId}`)
      expect(res.status).toBe(200)
      expect(res.body.heldText).toBe(HELD_TEXT)
      expect(res.body.survivors).toHaveLength(SURVIVOR_WORDS.length)
      expect(res.body.report).toEqual(GATE_REPORT)
    })

    /**
     * 🔴 NEVER THE ORIGINAL. `extractedText` is the un-redacted upload. The
     * reviewer's job is to check the REDACTION, and handing them the original
     * would make the gate decorative — every reviewer would become someone who
     * has read the identifiers the gate was there to remove.
     */
    it('never hands back the original text', async () => {
      const res = await apiGet(reviewer, `/api/holds/${heldId}`)
      expect(res.body).not.toHaveProperty('extractedText')
      expect(res.text).not.toContain('[Domicilio 1]')
      expect(res.text).not.toContain('buscando trabajo')
    })

    /**
     * 🔴 THE OFFSETS MUST LAND ON THE IDENTIFIERS. `anonymisationSurvivors`
     * drives the `<mark>` highlights the reviewer reads, so an off-by-one here
     * highlights the wrong characters and quietly tells a person that a
     * harmless word is the thing that is still identifying. Checked by SLICING
     * the text the API returned, never by re-deriving the arithmetic that
     * produced the spans.
     */
    it('every survivor offset slices out a real identifier', async () => {
      const res = await apiGet(reviewer, `/api/holds/${heldId}`)
      const sliced = res.body.survivors.map((s: { start: number; end: number }) =>
        (res.body.heldText as string).slice(s.start, s.end),
      )
      expect(sliced).toEqual(SURVIVOR_WORDS.map((w) => w.text))
    })

    it('is 404 for a colleague without holds:review, and for an id that does not exist', async () => {
      const denied = await apiGet(outsider, `/api/holds/${heldId}`)
      const missing = await apiGet(reviewer, '/api/holds/999999999')
      expect(denied.status).toBe(404)
      expect(missing.status).toBe(404)
      // Indistinguishable, byte for byte.
      expect(denied.text).toBe(missing.text)
    })

    it('is 401 for an anonymous caller', async () => {
      const res = await apiGet(anonymous, `/api/holds/${heldId}`)
      expect(res.status).toBe(401)
    })
  })

  // ── refusals that must NOT consume the hold ────────────────────────────────

  describe.skipIf(noSeed)('input the route refuses', () => {
    /**
     * ⚠ Each of these asserts the document is STILL HELD afterwards. A
     * validation path that half-decided would be far worse than one that
     * refused, because the reviewer would be told "no" about a document that
     * had already moved.
     */
    async function stillHeld(): Promise<void> {
      const res = await apiGet(reviewer, `/api/holds/${heldId}`)
      expect(res.status, 'the refused call consumed the hold').toBe(200)
    }

    it('refuses a decision that is neither approve nor reject', async () => {
      const res = await apiJson(reviewer, 'POST', `/api/holds/${heldId}`, { decision: 'maybe' })
      expect(res.status).toBe(400)
      await stillHeld()
    })

    it('refuses a body that is not an object', async () => {
      const res = await apiJson(reviewer, 'POST', `/api/holds/${heldId}`, ['approve'])
      expect(res.status).toBe(400)
      await stillHeld()
    })

    it('refuses an empty approved redaction', async () => {
      const res = await apiJson(reviewer, 'POST', `/api/holds/${heldId}`, {
        decision: 'approve',
        text: '   ',
      })
      expect(res.status).toBe(400)
      await stillHeld()
    })

    it('a colleague without holds:review cannot decide, and nothing moves', async () => {
      const res = await apiJson(outsider, 'POST', `/api/holds/${heldId}`, { decision: 'reject' })
      expect(res.status).toBe(404)
      await stillHeld()

      const reviews = sql<{ n: number }>(
        `select count(*)::int as n from anonymisation_reviews where document_id = :'id'`,
        { id: heldId! },
      )
      expect(reviews[0].n, 'a refused decision still wrote an audit row').toBe(0)
    })
  })

  // ── the decision ───────────────────────────────────────────────────────────

  /**
   * ⚠ Needs SQL (the audit-row reads) AND the fake provider: the gate must
   * refuse a REAL upload, and must not bill a real model doing it.
   */
  describe.skipIf(noSeed || !onFakeProvider)('approving a hold', () => {
    /** What the reviewer released, built from the gate's REAL held text. */
    let corrected = ''
    /** The upload's marker: the subject's name, unique across the corpus. */
    let marker = ''
    const REVIEWER_LABEL = '[Persona revisada]'

    /**
     * 🔴 THE TEST THE WHOLE FILE EXISTS FOR, and it is destructive — which is
     * why it runs against a row this suite created and nothing else.
     */
    it('records the audit row, releases the corrected text, and flips the document', async () => {
      marker = fixtures().pdf.marker

      const held = await apiGet(reviewer, `/api/holds/${pdfHeldId}`)
      expect(held.status, 'the gate did not hold the testimonio PDF').toBe(200)
      const heldText = String(held.body.heldText ?? '')
      // The detector never ran, so no stage could have taken the NAME out: the
      // gate's held output still carries it. That is what the reviewer is for.
      expect(heldText, 'the held text lost the subject name before review').toContain(marker)

      // The reviewer removes what the gate could not. This — not the gate's
      // output, and not the raw upload — is what must end up embedded.
      corrected = heldText.split(marker).join(REVIEWER_LABEL)

      const res = await apiJson(reviewer, 'POST', `/api/holds/${pdfHeldId}`, {
        decision: 'approve',
        text: corrected,
        note: 'e2e: quité el nombre que quedó.',
      })

      expect(res.status).toBe(200)
      expect(res.body.decision).toBe('approved')
      expect(res.body.anonymisationStatus).toBe('approved')
      expect(res.body.reviewId).toBeTruthy()

      // ── the row itself ──────────────────────────────────────────────────
      const [row] = sql<{
        anonymisation_status: string
        redacted_text: string | null
        held_text: string | null
        anonymisation_survivors: unknown
      }>(
        `select anonymisation_status, redacted_text, held_text, anonymisation_survivors
           from documents where id = :'id'`,
        { id: pdfHeldId! },
      )

      expect(row.anonymisation_status).toBe('approved')
      // 🔴 The REVIEWER'S text is what gets embedded, not the gate's.
      expect(row.redacted_text).toBe(corrected)
      // 🔴 The refused text is gone. It existed only for the review.
      expect(row.held_text).toBeNull()
      expect(row.anonymisation_survivors).toBeNull()

      // ── the audit row ───────────────────────────────────────────────────
      const [audit] = sql<{
        decision: string
        reviewer_id: number
        document_id: number
        organization_id: number
        text_edited: boolean
        note: string | null
        gate_stage: string | null
      }>(
        `select decision, reviewer_id, document_id, organization_id,
                text_edited, note, gate_stage
           from anonymisation_reviews where document_id = :'id'`,
        { id: pdfHeldId! },
      )

      expect(audit, 'no audit row was written').toBeTruthy()
      expect(audit.decision).toBe('approved')
      expect(audit.reviewer_id).toBe(world.alice.id)
      expect(audit.organization_id).toBe(world.orgA.id)
      // The stage the REAL gate stopped at, carried from the row into the audit.
      expect(audit.gate_stage).toBe('content')
      // The reviewer changed the text, and the record says so.
      expect(audit.text_edited).toBe(true)
      expect(audit.note).toContain('e2e:')
    })

    /**
     * 🔴 APPROVAL RE-ENTERS THE ORDINARY INGEST PATH, AND WHAT IT INGESTS IS THE
     * APPROVED TEXT. Checked in ai-service's own store, not on the backend row:
     * the row can only say what the backend meant to send.
     */
    it('reaches `ready`, and ai-service holds the approved text, not the raw upload', async () => {
      const row = await pollUntil(
        'the approved PDF to be ingested',
        () => docRow(reviewer, pdfHeldId!),
        (r) => r.ingestStatus === 'ready' || r.ingestStatus === 'failed',
        { timeoutMs: 120_000, intervalMs: 2000 },
      )
      expect(row.ingestStatus, `ingestError: ${row.ingestError}`).toBe('ready')
      expect(row.anonymisationStatus).toBe('approved')

      const probe = await retrieveAs(
        world.orgA.id,
        draftCorpusName(world.orgA.id, world.alice.id),
        REVIEWER_LABEL,
      )
      expect(probe.status, probe.text.slice(0, 300)).toBe(200)
      expect(probe.chunks.length).toBeGreaterThan(0)

      const embedded = probe.chunks.map((c) => c.text).join('\n')
      // 🔴 The raw upload's subject name is nowhere in the corpus…
      expect(embedded).not.toContain(marker)
      // …and the reviewer's own edit is.
      expect(embedded).toContain(REVIEWER_LABEL)
    })

    it('is gone from the queue once it is decided', async () => {
      const res = await apiGet(reviewer, `/api/holds?organization=${world.orgA.id}`)
      const ids = res.body.holds.map((h: { id: string }) => String(h.id))
      expect(ids).not.toContain(String(pdfHeldId))
    })

    /**
     * 🔴 TERMINAL. A second decision must not overwrite the first — the audit
     * row names a person, and letting it be re-decided would let a later
     * reviewer quietly replace whose name is on it. The row is no longer
     * `held`, so it is not loadable at all: the same 404 as everything else.
     */
    it('cannot be decided a second time, and writes no second audit row', async () => {
      const again = await apiJson(reviewer, 'POST', `/api/holds/${pdfHeldId}`, { decision: 'reject' })
      expect(again.status).toBe(404)

      const [{ n }] = sql<{ n: number }>(
        `select count(*)::int as n from anonymisation_reviews where document_id = :'id'`,
        { id: pdfHeldId! },
      )
      expect(n).toBe(1)

      const [row] = sql<{ anonymisation_status: string }>(
        `select anonymisation_status from documents where id = :'id'`,
        { id: pdfHeldId! },
      )
      expect(row.anonymisation_status).toBe('approved')
    })
  })

  // ── every OTHER hold in the database, read-only ────────────────────────────

  /**
   * ⚠ READ-ONLY, ON PURPOSE. These rows belong to somebody else — the hand-made
   * review fixture, or whatever the demo seed grows. They are asserted against
   * and left exactly as they were found. Nothing in this block writes.
   */
  describe.skipIf(!db.ok)('holds this suite did not create', () => {
    it('every survivor offset lands on real characters of its held text', () => {
      const rows = sql<{ id: number; held_text: string | null; survivors: string | null }>(
        `select id, held_text, anonymisation_survivors::text as survivors
           from documents
          where anonymisation_status = 'held' and anonymisation_survivors is not null`,
      )

      // A stack with no hand-made fixture is a legitimate state, not a failure.
      if (rows.length === 0) return

      for (const row of rows) {
        const spans = JSON.parse(row.survivors ?? '[]') as { start: number; end: number }[]
        const text = row.held_text ?? ''
        for (const span of spans) {
          expect(span.end, `document ${row.id}: an empty or inverted span`).toBeGreaterThan(
            span.start,
          )
          expect(span.end, `document ${row.id}: a span runs past the end of heldText`).toBeLessThanOrEqual(
            text.length,
          )
          // 🔴 The slice must be a real identifier, not whitespace. A span that
          // lands between words highlights nothing and hides a real one.
          expect(text.slice(span.start, span.end).trim().length,
            `document ${row.id}: span ${span.start}-${span.end} slices out blank text`,
          ).toBeGreaterThan(0)
        }
      }
    })
  })
})
