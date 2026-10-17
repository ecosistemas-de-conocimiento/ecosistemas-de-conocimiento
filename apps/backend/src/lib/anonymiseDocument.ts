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

import type { ContentKind } from './contentKind'
import type { GateReport, PersonDetector } from './anonymise/types'

/**
 * 🔴 THE ONE CONTENT KIND THAT IS NEVER GATED.
 *
 * The owner's decision, verbatim: *"docs uploaded should be kept in their
 * original form."* An uploaded `documento` is somebody's own material, filed
 * deliberately under their own name and expected back out of the corpus the way
 * it went in. Scrubbing it would both corrupt the source and cost two model
 * calls per PDF for nothing.
 *
 * ⚠ THE OTHER TWO RUN UNDER IDENTICAL RULES — also the owner's decision, on the
 * grounds that a testimony is expected to be anonymous anyway. There is no
 * per-kind leniency knob, because one rule means there is no default for a bulk
 * upload to get wrong.
 */
export const UNGATED_CONTENT_KIND: ContentKind = 'documento'

/**
 * 🔴 THE ANONYMISATION POLICY. One function, one name, one place to read it.
 *
 * ── WHY IT TAKES `unknown` AND NOT A `ContentKind` ──────────────────────────
 *
 * Because the coercion is the bug. {@link contentKindOf} answers "what should we
 * LABEL this row?" and defaults an unreadable value to `documento`, which is the
 * right answer for a citation card. Feeding that answer to this decision turns
 * it into "anything we cannot read is an ungated document" — fail-OPEN at the
 * single point in the design where an ungated pass is close to irreversible
 * (ai-service has no per-document delete).
 *
 * A previous review already caught exactly that fallback once, in the
 * `contentKind` beforeValidate hook in `collections/Documents.ts`. This function
 * exists so the same mistake cannot be made a second time by reaching for the
 * convenient helper: it is phrased as an ALLOW-LIST OF ONE over the RAW value.
 * `undefined`, `null`, `'documentos'`, `'Documento'` and any future kind nobody
 * has taught this function about are all gated.
 *
 * ⚠ THAT MEANS ADDING A CONTENT KIND MAKES IT GATED BY DEFAULT, and un-gating it
 * is a deliberate edit here with a reason attached. That direction is the whole
 * point: a missing decision costs a hold a human can clear, never an ingest
 * nobody can undo.
 */
export function mustPassAnonymisationGate(rawContentKind: unknown): boolean {
  return rawContentKind !== UNGATED_CONTENT_KIND
}

/**
 * The statuses the gate — or a human reviewing its refusal — can leave on a row.
 *
 *   n/a       not gated: an ordinary `documento`
 *   pending   the gate is running
 *   held      🔴 the gate refused. Not ingested. A human must look.
 *   approved  🔴 a human released a hold. AUDITED, and the only way past one.
 *   rejected  🔴 a human refused it. Terminal — never ingested, never re-gated.
 *   ready     cleared the gate on its own; `redactedText` is populated
 *
 * ⚠ `failed` is still deliberately absent. See `collections/Documents.ts`.
 */
export const ANONYMISATION_STATES = [
  'n/a',
  'pending',
  'held',
  'approved',
  'rejected',
  'ready',
] as const

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
  /**
   * 🔴 THE RAW `documents.contentKind`, NOT `contentKindOf(row)`.
   *
   * Typed `unknown` on purpose so a caller cannot quietly hand over a coerced
   * value: {@link mustPassAnonymisationGate} is the only thing allowed to read
   * it, and it fails CLOSED on anything it does not recognise. See that
   * function.
   */
  contentKind: unknown
  /** The unredacted text. Never leaves this process except through `detector`. */
  text: string
  detector?: PersonDetector
  /** The document's ecosistema: the detector's model call is booked to its org. */
  organizationId?: number | string
  /**
   * 🔴 TEXT A HUMAN REVIEWER APPROVED. When present, THE GATE DOES NOT RUN.
   *
   * The row is already `approved` and its `redactedText` is what a reviewer
   * cleared — possibly text they corrected by hand. Re-running the gate here
   * would discard their decision, spend two model calls to do it, and could
   * answer `ready` on the raw original, ingesting something nobody approved.
   *
   * ⚠ THE CALLER MUST TAKE THIS FROM THE STORED ROW, never from a request body.
   * `documents.anonymisationStatus` and `documents.redactedText` are locked
   * against API writes (`gateWritesOnly` in `collections/Documents.ts`), which
   * is what makes reading them here safe. Passing caller-supplied text into this
   * parameter would be an "ingest anyway" flag with a friendlier name.
   */
  approvedText?: string
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

  if (!mustPassAnonymisationGate(contentKind)) {
    // Recorded explicitly rather than left null. "This was never gated" and
    // "the gate has not run yet" are different facts, and an operator reading
    // the row should not have to infer which one they are looking at.
    await write({ anonymisationStatus: 'n/a', anonymisationError: null })
    return { ok: true, text, report: null }
  }

  if (typeof args.approvedText === 'string') {
    // 🔴 THE HUMAN OVERRIDE. Nothing is re-computed and nothing is re-written:
    // `lib/holdReview.ts` already stored the text, flipped the status and wrote
    // the audit row, in that order and in one place. This branch exists so the
    // ingest path can carry that decision without a second opinion about it.
    return { ok: true, text: args.approvedText, report: null }
  }

  await write({ anonymisationStatus: 'pending', anonymisationError: null })

  const { runAnonymisationGate, aiServiceDetector } = await import('./anonymise')
  const detector =
    args.detector ??
    aiServiceDetector(args.organizationId !== undefined ? { organizationId: args.organizationId } : {})

  let result: Awaited<ReturnType<typeof runAnonymisationGate>>
  try {
    result = await runAnonymisationGate(
      {
        // ⚠ `testimonio` IS THE DEFAULT ARM, and the direction matters. This only
        // picks which sentence describes the material to the model; the rules
        // are identical. But the `conversacion` prompt tells the model it is
        // reading members of a community talking to each other, and an
        // unrecognised kind is not evidence of that. `testimonio` is the arm
        // that assumes nothing and holds no roster.
        contentKind: contentKind === 'conversacion' ? 'conversacion' : 'testimonio',
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
      // 🔴 CLEARED. See the hold branch below — a `redactedText` left over from
      // an earlier successful run is publishable, and nothing on the publish
      // path re-reads the status.
      redactedText: null,
      // A crash produced no reviewable output. Cleared rather than left stale:
      // showing a reviewer the text from a PREVIOUS run of a different code path
      // is worse than showing them nothing.
      heldText: null,
      anonymisationSurvivors: null,
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
      /**
       * 🔴 CLEARED, AND THIS IS A REAL REACHABLE BUG, NOT TIDINESS.
       *
       * A row can already carry a `redactedText` from an EARLIER run that
       * cleared the gate: run one is `ready`, the ai-service ingest then fails,
       * the uploader retries, and the re-run — the detector is a model — holds
       * this time. Without this line the row is `held` while still holding run
       * one's redaction, and `corpusTextFor` asks only "is `redactedText`
       * non-empty?". The next publish would push it into the shared, undeletable
       * corpus, and the gate is not re-run on that path to catch it.
       */
      redactedText: null,
      /**
       * 🔴 THE GATE'S REFUSED OUTPUT GOES IN `heldText`, NOT `redactedText`.
       *
       * `corpusTextFor` reads `redactedText`. Writing the held text there would
       * make the very next publish push the text the gate just refused into the
       * ecosistema's shared corpus — and the gate is not re-run on that path, so
       * nothing would catch it. The separate column is the whole defence.
       */
      heldText: result.redactedText ?? null,
      anonymisationSurvivors: result.survivors ?? null,
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
    // A clean run has nothing held. Clearing keeps a stale review from an
    // earlier attempt off a row that has since passed.
    heldText: null,
    anonymisationSurvivors: null,
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
  /** 🔴 Consulted for gated content — see below. */
  anonymisationStatus?: unknown
}): { ok: true; text: string } | { ok: false; reason: string } {
  // 🔴 THE RAW VALUE, for the reason spelled out on `mustPassAnonymisationGate`.
  // This function is the LAST thing standing between a publish and the shared
  // corpus, and it is routinely handed objects assembled in code rather than
  // rows straight out of Postgres — which is precisely where a `contentKind`
  // goes missing without the database's NOT NULL enum noticing.
  if (!mustPassAnonymisationGate(doc.contentKind)) {
    const raw = typeof doc.extractedText === 'string' ? doc.extractedText.trim() : ''
    return raw ? { ok: true, text: raw } : { ok: false, reason: 'no extracted text' }
  }

  /**
   * 🔴 THE STATUS, NOT JUST THE COLUMN. BELT AND BRACES, DELIBERATELY.
   *
   * This used to ask only "is `redactedText` non-empty?", which is true of a row
   * that cleared the gate ONCE and has since been held or rejected. The hold
   * branch above now clears the column, so the two checks agree — and they are
   * both here on purpose, because this function is the last thing standing
   * between a publish and a corpus with no per-document delete, and one of the
   * two being forgotten in a future edit is exactly how this bug arrived.
   *
   * `ready` is the gate's own verdict; `approved` is a human's, recorded in
   * `anonymisation-reviews`. Nothing else may be published.
   */
  const status = typeof doc.anonymisationStatus === 'string' ? doc.anonymisationStatus : ''
  const redacted = typeof doc.redactedText === 'string' ? doc.redactedText.trim() : ''
  if (!redacted || (status !== 'ready' && status !== 'approved')) {
    return {
      ok: false,
      reason:
        'this content has not cleared the anonymisation gate, so there is no redacted version to share',
    }
  }
  return { ok: true, text: redacted }
}
