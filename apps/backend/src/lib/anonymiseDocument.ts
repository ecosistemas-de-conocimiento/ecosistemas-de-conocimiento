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
 * this and said no. The detector is a model, so the identical text CAN get a
 * different answer next time — which is why a hold stores `heldTextHash` and
 * `planIngestRetry` refuses a retry until the text has changed (audit
 * 2026-10-28 item 2). Only a reviewer releases a hold on the same words.
 *
 * 🔴 AND A GATE THAT COULD NOT RUN IS NOT A HOLD. A 429, a 5xx, a 402 budget
 * refusal or a timeout means the model never answered — nobody "said no". Those
 * leave the row at `n/a` (gate not run yet, the same state `planIngestRetry`
 * resets to) with a {@link GATE_UNAVAILABLE_CODE} error, so a seed re-run, the
 * ingest-recovery sweep or a retry runs the gate again. Before 2026-10-21 they
 * ended as permanent Revisión holds that nothing ever retried.
 */

import { randomUUID } from 'node:crypto'

import type { ContentKind } from './contentKind'
import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'
import { gatedTextHash } from './gatedTextHash'
import type { GateReport, PersonDetector } from './anonymise/types'
import { publicFiguresLog } from './publicFigures'

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
 *
 * ⚠ EXCEPT A `documento` WITH `anonymise` SET (owner rulings 2026-10-26): a
 * participant's upload, or staff material that names people. See
 * {@link anonymiseRequested}.
 */
export const UNGATED_CONTENT_KIND: ContentKind = 'documento'

/**
 * Prefix of `anonymisationError` on a row whose gate could not run (the model
 * never answered). The row is RETRYABLE, never in Revisión. See the header.
 */
export const GATE_UNAVAILABLE_CODE = 'gate_unavailable'

/**
 * Prefix of `anonymisationError` while a gate run holds the row (`pending`),
 * followed by that run's token. See the claim in {@link anonymiseDocumentText}.
 */
export const GATE_RUNNING_CODE = 'gate_running'

/**
 * Prefix of `ingestError` the draft path writes for the same case
 * (`enqueueIngestForDoc`). `ingestRecovery.ts` re-drives rows carrying it.
 */
export const GATE_UNAVAILABLE_INGEST_CODE = 'anonymisation_unavailable'

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
export function mustPassAnonymisationGate(rawContentKind: unknown, rawAnonymise?: unknown): boolean {
  return rawContentKind !== UNGATED_CONTENT_KIND || anonymiseRequested(rawAnonymise)
}

/**
 * 🔴 A `documento` FILED FOR ANONYMISATION (owner rulings 2026-10-26).
 *
 * `documents.anonymise` is set on a participant's PDF/DOCX (they auto-publish,
 * `lib/autoPublish.ts`) and, by choice, on a staff upload of meeting notes or a
 * visit report that names people. Such a row stays a `documento` — its own
 * title, its own label, the documento graph rule — but its TEXT goes through the
 * gate exactly like a testimonio's: held → Revisión, ready → `redactedText` is
 * what any corpus gets.
 *
 * ⚠ FAILS CLOSED ON A PRESENT VALUE: anything but `false`/`null`/absent gates.
 * Absent is ungated so rows assembled in code keep today's documento rule.
 *
 * 🔴 NOT FOR READ ACCESS. `forceSelect` does not survive an exclude-mode select
 * (`payload@3.88.0`), so a projected row can lack the column; read access
 * (`mayReadGatedOriginal`) requires `anonymise === false` instead.
 */
export function anonymiseRequested(rawAnonymise: unknown): boolean {
  return rawAnonymise !== undefined && rawAnonymise !== null && rawAnonymise !== false
}

/** {@link mustPassAnonymisationGate} over a row. */
export function rowMustPassGate(row: { contentKind?: unknown; anonymise?: unknown }): boolean {
  return mustPassAnonymisationGate(row.contentKind, row.anonymise)
}

/**
 * The statuses the gate — or a human reviewing its refusal — can leave on a row.
 *
 *   n/a       not gated: an ordinary `documento` — OR a gated kind whose gate
 *             has not run yet (a retry reset, or {@link GATE_UNAVAILABLE_CODE})
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
  | {
      ok: false
      stage: string
      reason: string
      report: GateReport | null
      /**
       * True when the gate could not RUN (model never answered). The row is
       * left retryable at `n/a`, not `held`. Still: do not ingest.
       */
      retryable?: true
      /**
       * 🔴 True when the gate did NOT run because it could not CLAIM the row:
       * another gate run holds it (`pending`), a decision is already on it, or
       * the row is not a draft. Nothing was written. Not a hold, not a failure:
       * the caller leaves the row exactly as it is. See {@link GATE_CLAIM_GUARD}.
       */
      busy?: true
    }

/**
 * 🔴 THE CLAIM. The gate runs only on a row that matches this, and the match
 * and the `pending` write are ONE `UPDATE … WHERE`, so two gate runs on the
 * same row cannot both start — in one process or in two.
 *
 * Measured on dev, 2026-10-21 (§4p of the edc-1 runbook): 13 testimonios ended
 * `held` + `published`. `payload run src/seed/demo.cli.ts` boots Payload, whose
 * boot seed starts `ingestSeededDocuments` detached; the CLI then runs it AGAIN
 * in the same process. Both read the 252 rows up front. Run A gated a row
 * `ready` and published it; run B, holding its stale `n/a` snapshot, gated it
 * again, the model answered differently, and B wrote `held` over a row already
 * in the shared corpus — which the hold cannot take back.
 *
 *   · not `pending`             another run is on it right now
 *   · not `held`/`rejected`/`approved`  a verdict or a human decision stands
 *   · not publishing/published/unpublishing  🔴 a row in (or moving into) the
 *     SHARED corpus is never re-gated. A different answer there cannot be
 *     acted on, so the gate would only write a status that lies about what the
 *     ecosistema can read. Unpublish first.
 *
 * ⚠ NULL passes both (`not_in` is NULL-safe in `documentColumns.ts`): a fresh
 * row has no gate state yet.
 */
export const GATE_CLAIM_GUARD = [
  { anonymisationStatus: { not_in: ['pending', 'held', 'rejected', 'approved'] } },
  { publicationStatus: { not_in: ['publishing', 'published', 'unpublishing'] } },
] as const

/** Just the database handle this module writes through, so tests need no Payload. */
type Updater = DocumentColumnsPayload

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
  /** 🔴 THE RAW `documents.anonymise`. A `documento` with it set is gated. */
  anonymise?: unknown
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
  /**
   * 🔴 KEEP PUBLIC FIGURES (`lib/publicFigures.ts`). Passed to the gate for a
   * `documento` ONLY; a testimonio or a conversation never keeps a name. What
   * was kept is logged on the row (`publicFiguresKept`) for reviewers.
   */
  keepPublicFigures?: boolean
}): Promise<AnonymiseOutcome> {
  const { payload, docId, contentKind, text } = args

  /**
   * 🔴 THE GATE'S OWN COLUMNS ONLY, never a whole-row `payload.update`. That
   * reads the row and writes every column back, so a corpus-graph status write
   * or an ingest callback landing in between was silently undone.
   * `lib/documentColumns.ts`. It also skips the afterChange hook, which the old
   * write had to switch off with `__skipDocsExtract` anyway.
   */
  const write = (data: Record<string, unknown>): Promise<unknown> =>
    updateDocumentColumns(payload, { id: docId, data })

  if (!mustPassAnonymisationGate(contentKind, args.anonymise)) {
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

  // 🔴 CLAIM, OR DO NOTHING. See `GATE_CLAIM_GUARD`.
  //
  // ⚠ The claim carries a PER-RUN TOKEN in `anonymisationError` (no new column).
  // Every final write below is guarded on `pending` + this token, so a run that
  // outlived `sweepLostGateRuns` (which resets a stale `pending`) and a newer run
  // that claimed the row since cannot be overwritten by the stale one.
  const token = `${GATE_RUNNING_CODE}: ${randomUUID()}`
  const claimed = await updateDocumentColumns(payload, {
    id: docId,
    // 🔴 `testimonioTitle` cleared with the claim: it was made from the text
    // this run is about to replace (`lib/testimonioTitle.ts`).
    data: { anonymisationStatus: 'pending', anonymisationError: token, testimonioTitle: null },
    where: GATE_CLAIM_GUARD.map((clause) => ({ ...clause })) as never,
  })
  if (claimed === 0) {
    return {
      ok: false,
      stage: 'claim',
      reason: 'the row is already being gated, already decided, or not a draft',
      report: null,
      busy: true,
    }
  }

  /** The run's final write. False when this run no longer owns the row. */
  const finish = async (data: Record<string, unknown>): Promise<boolean> =>
    (await updateDocumentColumns(payload, {
      id: docId,
      data,
      where: [{ anonymisationStatus: { equals: 'pending' } }, { anonymisationError: { equals: token } }],
    })) > 0
  const superseded = (): AnonymiseOutcome => ({
    ok: false,
    stage: 'claim',
    reason: 'a newer gate run or a sweep took the row over; this run wrote nothing',
    report: null,
    busy: true,
  })

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
        // A gated `documento` is described as a document, not a testimony.
        contentKind:
          contentKind === 'conversacion' || contentKind === 'documento' ? contentKind : 'testimonio',
        text,
        roster: args.roster ?? [],
        // 🔴 The gate itself ignores it for anything but a documento
        // (`gate.ts`, one check, tested there).
        keepPublicFigures: args.keepPublicFigures === true,
      },
      { detector },
    )
  } catch (err) {
    // ⚠ An UNEXPECTED throw is a HOLD, not a pass. The gate's own failure paths
    // already return `hold`; anything that escapes them is a bug, and a bug in
    // the redactor is the last thing that should be allowed to fail open.
    const reason = err instanceof Error ? err.message : String(err)
    if (!(await finish({
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
      publicFiguresKept: null,
      // 🔴 The text this hold is about: `/retry` refuses it unchanged.
      heldTextHash: gatedTextHash(text),
    }))) return superseded()
    return { ok: false, stage: 'content', reason, report: null }
  }

  if (result.status === 'hold' && result.retryable) {
    /**
     * 🔴 NOT A HOLD. The model never answered, so there is nothing for a human
     * to review — only a run to repeat. `n/a` + the error puts the row back in
     * every retry path (seed re-run, `planIngestRetry`, ingest recovery) and
     * keeps it out of Revisión. Not ingested: `corpusTextFor` refuses `n/a` on
     * a gated kind, and the caller sees `ok: false`.
     */
    if (!(await finish({
      anonymisationStatus: 'n/a',
      anonymisationError: `${GATE_UNAVAILABLE_CODE}: ${result.stage}: ${result.reason}`.slice(0, 500),
      anonymisationReport: result.report,
      redactedText: null,
      heldText: null,
      anonymisationSurvivors: null,
      publicFiguresKept: null,
    }))) return superseded()
    return {
      ok: false,
      stage: result.stage,
      reason: result.reason,
      report: result.report,
      retryable: true,
    }
  }

  if (result.status === 'hold') {
    if (!(await finish({
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
      // The public figures left in `heldText`, so the reviewer sees why.
      publicFiguresKept: publicFiguresLog(result.keptPublic, result.report.model),
      /**
       * 🔴 THE HELD TEXT'S HASH. Audit 2026-10-28 item 2: the detector is a
       * model, so re-running it on the same words can answer `ready`.
       * `planIngestRetry` refuses `/retry` on a held row until the text differs.
       */
      heldTextHash: gatedTextHash(text),
    }))) return superseded()
    /**
     * A held testimonio gets a title too (owner ruling 2026-10-24: Revisión
     * lists them), from the gate's REDACTED output at the hold — never the
     * original. What verify flagged is forbidden in it. Detached; a structural
     * hold has no output, so no title and the fallback label.
     */
    if (
      contentKind === 'testimonio' &&
      args.organizationId !== undefined &&
      typeof result.redactedText === 'string'
    ) {
      const heldText = result.redactedText
      const { scheduleTestimonioTitle } = await import('./testimonioTitle')
      scheduleTestimonioTitle({
        contentKind,
        docId,
        organizationId: args.organizationId,
        redactedText: heldText,
        source: 'held',
        forbidden: (result.survivors ?? []).map((sp) => heldText.slice(sp.start, sp.end)),
        payload: payload as never,
      })
    }
    return { ok: false, stage: result.stage, reason: result.reason, report: result.report }
  }

  if (!(await finish({
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
    // 🔴 THE REVIEWERS' LOG: every name kept as public, why, which model, when.
    publicFiguresKept: publicFiguresLog(result.keptPublic, result.report.model),
  }))) return superseded()

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
  /** 🔴 A `documento` with this set is gated content. See {@link anonymiseRequested}. */
  anonymise?: unknown
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
  if (!rowMustPassGate(doc)) {
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
