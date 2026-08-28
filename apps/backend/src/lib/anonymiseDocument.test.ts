/**
 * 🔴 THE CHOKE POINT, AND THE ONE THING IT MAY NEVER DO.
 *
 * ── WHY "HELD" IS THE PROPERTY UNDER TEST AND NOT AN EDGE CASE ───────────────
 *
 * `@edc/ai-client` HAS NO PER-DOCUMENT DELETE. Retirement closes a validity
 * window; the chunk and its embedding stay in the corpus, and a retrieve that
 * forgets `asOf` still sees them. So a testimony ingested with a name still in
 * it is, for practical purposes, PERMANENT — there is no button that fixes it
 * afterwards and no migration that unsays it.
 *
 * Everything below follows from that single fact. `held` must mean NOTHING WAS
 * INGESTED, which in this module means two things at once and they are easy to
 * satisfy only one of:
 *
 *   · the return value says `ok: false`, so `enqueueIngestForDoc` stops, AND
 *   · `redactedText` IS NEVER WRITTEN TO THE ROW.
 *
 * The second half is the one a refactor would break. Writing "whatever we had
 * managed to redact so far" on a hold looks harmless — the row is marked `held`,
 * the ingest did not happen — and then the publish path calls `corpusTextFor`,
 * finds a `redactedText`, and promotes half-scrubbed text into the corpus every
 * colleague searches. That is the failure this file exists to catch, and it is
 * why the assertions are on the WRITES, not only on the return value.
 *
 * ── FAIL CLOSED, INCLUDING ON OUR OWN BUGS ───────────────────────────────────
 *
 * The gate's own failure paths already return `hold`. Anything that ESCAPES them
 * is a bug in the redactor, and a bug in the redactor is the last thing that may
 * be allowed to fail open. Both shapes are tested: a detector that throws (the
 * gate catches it) and a crash that escapes the gate entirely.
 *
 * ── NO RE-IDENTIFICATION MAP, ANYWHERE ───────────────────────────────────────
 *
 * The status, the error string and the report are all stored on a row an admin
 * reads. None of them may carry the removed text — a column that quoted the name
 * it found would be the re-identification map this design refuses to keep, filed
 * under a friendlier name. Asserted by searching the whole serialised write log
 * for the person's name.
 *
 * ⚠ NO NETWORK AND NO MODEL. `staticDetector` is the injected seam; the real
 * `aiServiceDetector` is only ever constructed when no detector is passed, and
 * every test here passes one.
 */

import { describe, expect, it } from 'vitest'

import { staticDetector } from './anonymise'
import type { PersonDetector } from './anonymise/types'
import {
  anonymiseDocumentText,
  corpusTextFor,
  needsAnonymisation,
} from './anonymiseDocument'

const DOC_ID = 99

/** The name that must never end up anywhere except `extractedText`. */
const NAME = 'María López'
const TESTIMONY = `Ayer conversé con ${NAME} sobre el agua de la comunidad.`

// ---------------------------------------------------------------------------
// The `payload.update` seam — collect the writes, assert over them
// ---------------------------------------------------------------------------

type Update = { collection: string; id: unknown; data: Record<string, unknown> }

function fakePayload() {
  const updates: Update[] = []
  return {
    updates,
    payload: {
      update: async (args: {
        collection: 'documents'
        id: never
        data: Record<string, unknown>
        overrideAccess: boolean
        context?: Record<string, unknown>
      }) => {
        updates.push({ collection: args.collection, id: args.id, data: args.data })
        return {}
      },
    },
    /** The last value written for `key`, or `undefined` if it was never written. */
    last(key: string): unknown {
      for (let i = updates.length - 1; i >= 0; i -= 1) {
        if (Object.prototype.hasOwnProperty.call(updates[i]!.data, key)) return updates[i]!.data[key]
      }
      return undefined
    },
    /** Was `key` ever written at all? Absent and `null` are different facts here. */
    wrote(key: string): boolean {
      return updates.some((u) => Object.prototype.hasOwnProperty.call(u.data, key))
    },
  }
}

type Fake = ReturnType<typeof fakePayload>

const run = (
  fake: Fake,
  args: {
    contentKind: 'documento' | 'testimonio' | 'conversacion'
    text?: string
    detector?: PersonDetector
    roster?: readonly string[]
  },
) =>
  anonymiseDocumentText({
    payload: fake.payload as unknown as Parameters<typeof anonymiseDocumentText>[0]['payload'],
    docId: DOC_ID,
    contentKind: args.contentKind,
    text: args.text ?? TESTIMONY,
    detector: args.detector,
    roster: args.roster,
  })

/** A detector that finds the name. The happy path for a testimony. */
const findsTheName = () => staticDetector([{ text: NAME, type: 'persona' }])

// ---------------------------------------------------------------------------
// needsAnonymisation
// ---------------------------------------------------------------------------

describe('needsAnonymisation — which kinds go through the gate', () => {
  it('gates a testimonio and a conversacion, under the same rules', () => {
    // ⚠ There is deliberately no per-kind leniency knob: one rule means there is
    // no default for a bulk upload to get wrong.
    expect(needsAnonymisation('testimonio')).toBe(true)
    expect(needsAnonymisation('conversacion')).toBe(true)
  })

  it('does not gate a documento — somebody’s own material, filed under their own name', () => {
    expect(needsAnonymisation('documento')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A plain documento
// ---------------------------------------------------------------------------

describe('anonymiseDocumentText — a documento is passed through, not scrubbed', () => {
  it('returns the ORIGINAL text unchanged', async () => {
    const fake = fakePayload()
    const result = await run(fake, { contentKind: 'documento', detector: findsTheName() })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe(TESTIMONY)
  })

  it('writes `anonymisationStatus: n/a` explicitly, and clears any old error', async () => {
    // Recorded rather than left null: "this was never gated" and "the gate has
    // not run yet" are different facts, and an operator reading the row should
    // not have to infer which one they are looking at.
    const fake = fakePayload()
    await run(fake, { contentKind: 'documento', detector: findsTheName() })

    expect(fake.last('anonymisationStatus')).toBe('n/a')
    expect(fake.last('anonymisationError')).toBeNull()
    expect(fake.updates).toHaveLength(1)
  })

  it('🔴 makes NO detector call — an ordinary PDF must not cost two model calls', async () => {
    // Also the privacy half of the same property: a `documento` never has its
    // text sent to the detector, which is the one place unredacted text leaves
    // this process.
    let calls = 0
    const counting: PersonDetector = {
      name: 'counting',
      async detect() {
        calls += 1
        return []
      },
    }
    await run(fakePayload(), { contentKind: 'documento', detector: counting })
    expect(calls).toBe(0)
  })

  it('never writes redactedText for an ungated kind', async () => {
    const fake = fakePayload()
    await run(fake, { contentKind: 'documento', detector: findsTheName() })
    expect(fake.wrote('redactedText')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A testimony that clears the gate
// ---------------------------------------------------------------------------

describe('anonymiseDocumentText — a testimonio that clears the gate', () => {
  it('🔴 returns the REDACTED text, not the original', async () => {
    // The return value is what the caller hands to `ingest.enqueue`. Returning
    // `text` here — the parameter that is still sitting in scope — would ingest
    // the unredacted testimony while the row proudly said `ready`.
    const fake = fakePayload()
    const result = await run(fake, { contentKind: 'testimonio', detector: findsTheName() })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).not.toContain(NAME)
    expect(result.text).toContain('[Persona A]')
    expect(result.text).toContain('sobre el agua de la comunidad')
  })

  it('persists redactedText BESIDE the original and marks the row ready', async () => {
    // ⚠ Beside, not over. `extractedText` is the record of what was actually
    // said and stays access-controlled in Postgres; overwriting it would destroy
    // the only copy of the material the person gave.
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', detector: findsTheName() })

    expect(fake.last('anonymisationStatus')).toBe('ready')
    expect(fake.last('anonymisationError')).toBeNull()
    expect(fake.last('redactedText')).toContain('[Persona A]')
    expect(fake.wrote('extractedText')).toBe(false)
  })

  it('marks the row `pending` BEFORE the model runs, so a stall is visible', async () => {
    // Without the early write a document stuck inside a slow model call is
    // indistinguishable from one nothing ever happened to.
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', detector: findsTheName() })

    expect(fake.updates[0]!.data.anonymisationStatus).toBe('pending')
    expect(fake.updates.at(-1)!.data.anonymisationStatus).toBe('ready')
  })

  it('guards every write against re-entrancy', async () => {
    // ⚠ Without `__skipDocsExtract` the afterChange hook re-fires and re-runs the
    // whole extract+ingest pass — for a testimony that means paying for the
    // gate’s model calls again on every status write.
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', detector: findsTheName() })
    expect(fake.updates.every((u) => u.collection === 'documents' && u.id === DOC_ID)).toBe(true)
  })

  it('runs a conversacion through the same gate', async () => {
    const fake = fakePayload()
    const result = await run(fake, { contentKind: 'conversacion', detector: findsTheName() })

    expect(result.ok).toBe(true)
    expect(fake.last('anonymisationStatus')).toBe('ready')
    expect(String(fake.last('redactedText'))).not.toContain(NAME)
  })
})

// ---------------------------------------------------------------------------
// 🔴 A testimony the gate HOLDS
// ---------------------------------------------------------------------------

describe('🔴 anonymiseDocumentText — a hold means nothing was ingested', () => {
  /**
   * A detector that misses a surname on the first pass and finds it on the
   * verification pass — the realistic shape of a stage-4 hold. The first call
   * sees raw text; the second sees text that already contains a placeholder,
   * which is what the branch keys off.
   */
  const missesThenFinds = () =>
    staticDetector((text) =>
      text.includes('[Persona ')
        ? [{ text: 'Beltrán', type: 'persona' as const }]
        : [{ text: 'Ana', type: 'persona' as const }],
    )

  const HELD_TEXT = 'Ana habló con Ana Beltrán en la asamblea.'

  it('🔴 returns ok:false and writes `held`', async () => {
    const fake = fakePayload()
    const result = await run(fake, {
      contentKind: 'testimonio',
      text: HELD_TEXT,
      detector: missesThenFinds(),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('verify')
    expect(fake.last('anonymisationStatus')).toBe('held')
  })

  it('🔴 NEVER writes redactedText on a hold', async () => {
    // THE load-bearing assertion in this file. ai-service has no per-document
    // delete, so "held" has to mean nothing was ingested — and a `redactedText`
    // left on the row is not inert: `corpusTextFor` reads it, and the publish
    // path would then promote half-scrubbed text into the corpus the whole
    // ecosistema searches. Marking the row `held` would not stop it.
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', text: HELD_TEXT, detector: missesThenFinds() })

    expect(fake.wrote('redactedText')).toBe(false)
    expect(JSON.stringify(fake.updates)).not.toContain('[Persona A]')
  })

  it('records WHICH stage refused, so an operator can act on it', async () => {
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', text: HELD_TEXT, detector: missesThenFinds() })
    expect(String(fake.last('anonymisationError'))).toContain('verify')
  })

  it('holds — it does not FAIL — so no retry button is implied', async () => {
    // ⚠ `failed` invites a retry. `held` means the gate looked at this and said
    // no; retrying the identical text will say no again.
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', text: HELD_TEXT, detector: missesThenFinds() })
    expect(fake.last('anonymisationStatus')).not.toBe('failed')
    expect(fake.last('anonymisationStatus')).toBe('held')
  })
})

// ---------------------------------------------------------------------------
// 🔴 Fail closed
// ---------------------------------------------------------------------------

describe('🔴 anonymiseDocumentText — failure ends in `held`, never in a pass', () => {
  it('🔴 a detector that THROWS holds the document', async () => {
    // The detector throws rather than returning `[]` precisely so it lands here.
    // A `catch` that felt defensive and returned an empty finding list would let
    // raw testimony through the gate labelled `ready`, into a corpus with no
    // per-document delete.
    const exploding: PersonDetector = {
      name: 'exploding',
      async detect() {
        throw new Error('ai-service unreachable')
      },
    }

    const fake = fakePayload()
    const result = await run(fake, { contentKind: 'testimonio', detector: exploding })

    expect(result.ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('held')
    expect(fake.wrote('redactedText')).toBe(false)
  })

  it('🔴 an UNEXPECTED crash inside the gate holds too, and says so', async () => {
    // Simulates a bug that escapes the gate’s own hold paths: the detector
    // answers, but reading its `name` for the report blows up. A crash in the
    // redactor is the last thing that may fail open, so the module’s own
    // try/catch has to turn it into `held` rather than letting it propagate as a
    // generic ingest error somebody later "fixes" by ignoring.
    const crashingName = {
      get name(): string {
        throw new Error('boom')
      },
      async detect() {
        return []
      },
    } as unknown as PersonDetector

    const fake = fakePayload()
    const result = await run(fake, { contentKind: 'testimonio', detector: crashingName })

    expect(result.ok).toBe(false)
    expect(fake.last('anonymisationStatus')).toBe('held')
    expect(String(fake.last('anonymisationError'))).toContain('gate_crashed')
    expect(fake.wrote('redactedText')).toBe(false)
  })

  it('🔴 a detector that finds nothing at all still cannot leak the name', async () => {
    // "Nothing to redact" is a legitimate answer, and the gate will let the text
    // through. What must hold is that whatever is returned is what was WRITTEN —
    // never the original substituted back in by a later refactor.
    const fake = fakePayload()
    const blind = staticDetector([])
    const result = await run(fake, { contentKind: 'testimonio', text: 'No hay nadie aquí.', detector: blind })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe(fake.last('redactedText'))
  })
})

// ---------------------------------------------------------------------------
// 🔴 No re-identification map
// ---------------------------------------------------------------------------

describe('🔴 nothing written to the row carries the person’s name', () => {
  it('keeps the name out of every write on the READY path', async () => {
    const fake = fakePayload()
    await run(fake, { contentKind: 'testimonio', detector: findsTheName() })
    expect(JSON.stringify(fake.updates)).not.toContain(NAME)
    expect(JSON.stringify(fake.updates)).not.toContain('María')
  })

  it('🔴 keeps the name out of the error string and the report on the HELD path', async () => {
    // The reason is written by the gate and carries COUNTS ONLY. An error column
    // that quoted the name it found would put the name straight back into the
    // database the gate had just kept out of it — a re-identification map with a
    // different name on the door. `anonymisationReport` is shown in the admin
    // panel, so it is covered by the same assertion.
    const fake = fakePayload()
    await run(fake, {
      contentKind: 'testimonio',
      text: `Hablé con ${NAME} y con Ana Beltrán.`,
      detector: staticDetector((text) =>
        text.includes('[Persona ')
          ? [{ text: 'Beltrán', type: 'persona' as const }]
          : [{ text: NAME, type: 'persona' as const }],
      ),
    })

    expect(fake.last('anonymisationStatus')).toBe('held')
    const written = JSON.stringify(fake.updates)
    expect(written).not.toContain(NAME)
    expect(written).not.toContain('María')
    expect(written).not.toContain('Beltrán')
  })
})

// ---------------------------------------------------------------------------
// corpusTextFor — which text a re-embed may use
// ---------------------------------------------------------------------------

describe('corpusTextFor — the stored decision, never a re-run of the gate', () => {
  it('returns extractedText for a documento', () => {
    expect(corpusTextFor({ contentKind: 'documento', extractedText: 'contenido' })).toEqual({
      ok: true,
      text: 'contenido',
    })
  })

  it('refuses a documento whose extraction never finished', () => {
    // Enqueueing an empty body publishes a document that matches nothing — a
    // silent, permanent "why does search never find it".
    for (const doc of [{ contentKind: 'documento' }, { contentKind: 'documento', extractedText: '   ' }]) {
      expect(corpusTextFor(doc)).toEqual({ ok: false, reason: 'no extracted text' })
    }
  })

  it('returns redactedText for a testimonio, even when the original is right there', () => {
    const result = corpusTextFor({
      contentKind: 'testimonio',
      extractedText: TESTIMONY,
      redactedText: 'Ayer conversé con [Persona A] sobre el agua.',
    })
    expect(result).toEqual({ ok: true, text: 'Ayer conversé con [Persona A] sobre el agua.' })
    expect(JSON.stringify(result)).not.toContain(NAME)
  })

  it('🔴 REFUSES a testimonio with no redactedText, however much extractedText it has', () => {
    // The case this covers is real and specific: the draft ingest was HELD, so
    // there is nothing cleared to share. Falling back to `extractedText` here
    // would promote the raw original into the shared corpus at exactly the
    // moment the material becomes visible to the whole ecosistema — and the gate
    // is not re-run on this path, so nothing downstream would catch it.
    for (const redactedText of [undefined, null, '', '   ', 42]) {
      const result = corpusTextFor({ contentKind: 'testimonio', extractedText: TESTIMONY, redactedText })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(NAME)
    }
  })

  it('🔴 refuses a conversacion with no redactedText for the same reason', () => {
    expect(corpusTextFor({ contentKind: 'conversacion', extractedText: TESTIMONY }).ok).toBe(false)
  })

  it('🔴 a junk contentKind is read as a documento, matching contentKindOf', () => {
    // The two files must default the same way. If `corpusTextFor` ever defaulted
    // to "gated", a typo’d row would become unpublishable instead of ordinary —
    // a different bug, but the same class of silent divergence.
    expect(corpusTextFor({ contentKind: 'testimonios', extractedText: 'contenido' })).toEqual({
      ok: true,
      text: 'contenido',
    })
  })
})
