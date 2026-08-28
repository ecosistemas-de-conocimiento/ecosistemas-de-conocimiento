/**
 * 🔴 THE CHOKE POINT. Nothing reaches a corpus without passing through here.
 *
 * ── WHY IT IS ONE FUNCTION AND NOT A STEP IN EACH PIPELINE ───────────────────
 *
 * A `documents` row gets its text from three different places — a PDF/DOCX
 * extract, an audio transcript arriving on a webhook minutes later, and the
 * publish move re-embedding into the shared corpus. Each of those used to hand
 * text straight to `ingest.enqueue`. A gate implemented as "a step in the
 * pipeline" would therefore have to be added three times, and the one that got
 * forgotten would be the audio path — the slow, asynchronous one, whose failures
 * nobody watches.
 *
 * So instead this is called from `enqueueIngestForDoc`, which is the SINGLE
 * function all three paths already converge on, and it decides what text (if
 * any) is allowed out.
 *
 * ── 🔴 "HOLD" MEANS NOT INGESTED, AND THERE IS NO OVERRIDE ───────────────────
 *
 * ai-service has no per-document delete. Retirement closes a validity window;
 * the chunk and its vector remain. So a wrong ingest is close to permanent, and
 * every uncertain outcome has to end as "not ingested yet" rather than
 * "ingested, mostly scrubbed". A held document keeps its `extractedText` in
 * Postgres — nothing is lost, it is simply not embedded — and an operator can
 * see exactly which stage refused it.
 *
 * ⚠ A HELD DOCUMENT IS NOT A FAILED ONE, and the two statuses are separate for
 * that reason. `failed` invites a retry button. `held` means the gate looked at
 * this and said no; retrying the identical text will say no again.
 */

import { contentKindOf, type ContentKind } from './contentKind'
import type { GateReport, PersonDetector } from './anonymise/types'

/**
 * Which content kinds go through the gate.
 *
 * ⚠ TESTIMONIES AND CONVERSATIONS RUN UNDER THE SAME RULES — the owner's
 * decision, on the grounds that a testimony is expected to be anonymous anyway.
 * There is no per-kind leniency knob here on purpose: one rule means there is no
 * default for a bulk upload to get wrong.
 *
 * A `documento` is somebody's own material, filed deliberately under their own
 * name. It is not scrubbed, and pretending otherwise would make every uploaded
 * PDF cost two model calls for nothing.
 */
export function needsAnonymisation(contentKind: ContentKind): boolean {
  return contentKind === 'testimonio' || contentKind === 'conversacion'
}

/** The statuses the gate can leave on a row. */
export const ANONYMISATION_STATES = ['n/a', 'pending', 'held', 'ready'] as const

export type AnonymisationState = (typeof ANONYMISATION_STATES)[number]

export type AnonymiseOutcome =
  | { ok: true; text: string; report: GateReport | null }
  /**
   * 🔴 The caller MUST NOT ingest. Not a soft failure, not a retry hint.
   */
  | { ok: false; stage: string; reason: string; report: GateReport | null }

/** Just the write method this module needs, so tests need no Payload. */
interface Updater {
  update(args: {
    collection: 'documents'
    id: never
    data: Record<string, unknown>
    overrideAccess: boolean
    context?: Record<string, unknown>
  }): Promise<unknown>
}

/**
 * Run the gate for one document and persist the outcome on its row.
 *
 * Returns the text that may be ingested, or a refusal. The caller passes the
 * returned text to `ingest.enqueue` and nothing else — in particular NOT
 * `extractedText`, which is the unredacted original and stays in Postgres.
 *
 * @param detector test seam. Production builds one against ai-service.
 */
export async function anonymiseDocumentText(args: {
  payload: Updater
  docId: string | number
  contentKind: ContentKind
  /** The unredacted text. Never leaves this process except through `detector`. */
  text: string
  detector?: PersonDetector
  /**
   * Known member names/emails. Meaningful for a `conversacion`; deliberately
   * empty for a `testimonio`, whose people are not users of this system at all.
   */
  roster?: readonly string[]
}): Promise<AnonymiseOutcome> {
  const { payload, docId, contentKind, text } = args

  const write = (data: Record<string, unknown>): Promise<unknown> =>
    payload.update({
      collection: 'documents',
      id: docId as never,
      data,
      overrideAccess: true,
      // Re-entrancy guard, same as every other server-side write to this
      // collection: without it the afterChange hook re-fires and re-runs the
      // whole extract+ingest pass, which for a testimony means paying for the
      // gate's model calls again on every status write.
      context: { __skipDocsExtract: true },
    })

  if (!needsAnonymisation(contentKind)) {
    // Recorded explicitly rather than left null. "This was never gated" and
    // "the gate has not run yet" are different facts, and an operator reading
    // the row should not have to infer which one they are looking at.
    await write({ anonymisationStatus: 'n/a', anonymisationError: null })
    return { ok: true, text, report: null }
  }

  await write({ anonymisationStatus: 'pending', anonymisationError: null })

  const { runAnonymisationGate, aiServiceDetector } = await import('./anonymise')
  const detector = args.detector ?? aiServiceDetector()

  let result: Awaited<ReturnType<typeof runAnonymisationGate>>
  try {
    result = await runAnonymisationGate(
      {
        contentKind: contentKind === 'testimonio' ? 'testimonio' : 'conversacion',
        text,
        roster: args.roster ?? [],
      },
      { detector },
    )
  } catch (err) {
    // ⚠ An UNEXPECTED throw is a HOLD, not a pass. The gate's own failure paths
    // already return `hold`; anything that escapes them is a bug, and a bug in
    // the redactor is the last thing that should be allowed to fail open.
    const reason = err instanceof Error ? err.message : String(err)
    await write({
      anonymisationStatus: 'held',
      anonymisationError: `gate_crashed: ${reason}`.slice(0, 500),
    })
    return { ok: false, stage: 'content', reason, report: null }
  }

  if (result.status === 'hold') {
    await write({
      anonymisationStatus: 'held',
      // ⚠ The reason is written by the gate and carries COUNTS ONLY, never the
      // text that triggered it. An error column that quoted the name it found
      // would be a re-identification map with a different name on the door.
      anonymisationError: `${result.stage}: ${result.reason}`.slice(0, 500),
      anonymisationReport: result.report,
    })
    return { ok: false, stage: result.stage, reason: result.reason, report: result.report }
  }

  await write({
    // ⚠ Stored BESIDE the original, not over it. `extractedText` is the record
    // of what was actually said and stays access-controlled in Postgres; only
    // `redactedText` is ever embedded. Overwriting the original would destroy
    // the only copy of the material the person actually gave.
    redactedText: result.redactedText,
    anonymisationStatus: 'ready',
    anonymisationError: null,
    anonymisationReport: result.report,
  })

  return { ok: true, text: result.redactedText, report: result.report }
}

/**
 * 🔴 WHICH TEXT GOES INTO A CORPUS, for a row that has already been through the
 * gate.
 *
 * The publish and unpublish moves re-embed an EXISTING document, so they must
 * not re-run the gate (two more model calls, and a different outcome on the same
 * text would be worse than either outcome). They read the stored decision
 * instead — and a gated row with no `redactedText` is refused, which is what
 * stops a publish from quietly promoting the raw original into the shared corpus
 * because the draft ingest had been held.
 */
export function corpusTextFor(doc: {
  contentKind?: unknown
  extractedText?: unknown
  redactedText?: unknown
}): { ok: true; text: string } | { ok: false; reason: string } {
  const kind = contentKindOf(doc as { contentKind?: unknown })

  if (!needsAnonymisation(kind)) {
    const raw = typeof doc.extractedText === 'string' ? doc.extractedText.trim() : ''
    return raw ? { ok: true, text: raw } : { ok: false, reason: 'no extracted text' }
  }

  const redacted = typeof doc.redactedText === 'string' ? doc.redactedText.trim() : ''
  if (!redacted) {
    return {
      ok: false,
      reason:
        'this content has not cleared the anonymisation gate, so there is no redacted version to share',
    }
  }
  return { ok: true, text: redacted }
}
