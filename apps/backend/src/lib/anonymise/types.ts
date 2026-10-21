/**
 * THE ANONYMISATION GATE — its contract.
 *
 * ── 🔴 WHY A GATE WITH A HOLD STATE, AND NOT A BEST-EFFORT TRANSFORM ─────────
 *
 * `@edc/ai-client` HAS NO PER-DOCUMENT DELETE. Retirement closes a validity
 * window (`setDocumentValidity`); the chunk and its vector stay in the corpus
 * forever. So ingesting something we should not have is close to IRREVERSIBLE.
 *
 * That single fact decides the shape of everything here: every failure mode must
 * end in **"not ingested yet"**, never in "ingested, mostly scrubbed". A
 * transform has no way to say "I am not sure"; a gate does, and it is called
 * {@link GateResult} `status: 'hold'`.
 *
 * ── WHAT RUNS, AND WHAT ACTUALLY DOES THE WORK ───────────────────────────────
 *
 *   1 structural     drop author ids, coarsen timestamps        deterministic
 *   2 deterministic  emails, phones, CURP/RFC, roster names      deterministic
 *   3 content        the model DETECTS people and identifiers    probabilistic
 *   4 verify         a second detection pass over the OUTPUT     probabilistic
 *
 * ⚠ THE WEIGHT SITS COMPLETELY DIFFERENTLY FOR THE TWO CONTENT TYPES, and this
 * is the owner's correction to an earlier design that got it wrong:
 *
 *   · In a CONVERSATION the speakers are members of the ecosistema, so we hold
 *     a roster and stage 2 does real work.
 *   · In a TESTIMONY the people named — the speaker, their family, a neighbour,
 *     an official — are NOT USERS OF THIS SYSTEM AT ALL. No roster contains
 *     them. A dictionary scrub barely touches a Voz.
 *
 * 🔴 SO TESTIMONY REDACTION IS STAGE 3. It is the mechanism, not a refinement.
 * Do not ship testimony redaction on dictionary matching.
 *
 * ── 🔴 THE MODEL DETECTS; THIS CODE REPLACES ─────────────────────────────────
 *
 * Stage 3 does NOT ask the model to rewrite the text. It asks for a JSON list of
 * the strings that identify someone, and the replacement is done here. Two
 * reasons, both concrete:
 *
 *   · A rewriting model can silently drop, reorder or invent sentences, and
 *     nobody would notice — the output looks clean either way, which is exactly
 *     the failure §3.3 of the plan warns about.
 *   · Detection is CHECKABLE. Running the same detector over the output is a
 *     real verification (stage 4); running a rewriter twice is not.
 *
 * ── REDACT BY REPLACEMENT, AND NEVER STABLY ACROSS DOCUMENTS ─────────────────
 *
 * People become `[Persona A]`, `[Persona B]`, stable WITHIN one document and
 * deliberately NOT across documents. Stable pseudonyms across a corpus let
 * someone follow "Persona A" from document to document and re-identify them by
 * behaviour — which is worse than the names, because it looks safe.
 *
 * 🔴 NO RE-IDENTIFICATION MAP IS STORED, ANYWHERE. {@link GateReport} carries
 * COUNTS and PATTERN NAMES only — never a removed string, never a mapping from a
 * pseudonym back to anything. A stored map defeats the anonymisation the moment
 * it leaks, and no product feature needs one. Auditing is served by the original
 * rows, which already exist and are already access-controlled.
 */

/** The gate's stages, in order. A hold names the one it stopped at. */
export const GATE_STAGES = ['structural', 'deterministic', 'content', 'verify'] as const

export type GateStage = (typeof GATE_STAGES)[number]

/**
 * What one stage removed. **Counts only.**
 *
 * 🔴 `label` is the name of a RULE (`email`, `persona`, `telefono`), never the
 * text that matched. See the header: a report that carried the matched strings
 * would be the re-identification map this design refuses to keep, filed under a
 * friendlier name.
 */
export interface RedactionCount {
  label: string
  count: number
}

export interface GateStageReport {
  stage: GateStage
  removed: RedactionCount[]
  /** Human-readable note for the admin panel. Must contain no removed text. */
  note?: string
  /**
   * Verify only: which round this entry records, from 1. Its `removed` counts
   * what that round redacted, so a reviewer sees what each round caught.
   * ⚠ Absent on reports stored before verify had rounds.
   */
  round?: number
}

export interface GateReport {
  stages: GateStageReport[]
  /** How many distinct people got a `[Persona X]` label in THIS document. */
  pseudonyms: number
  /**
   * How many distinct addresses got a `[Domicilio X]` label in THIS document.
   *
   * ⚠ A COUNT, like everything else here. Never the addresses. Optional so a
   * report stored before addresses were handled still parses.
   */
  addresses?: number
  /** Which model did the content scrub, for provenance. Null when stubbed. */
  model?: string | null
}

/**
 * WHERE THE VERIFY STAGE FOUND SOMETHING STILL STANDING — as OFFSETS into
 * {@link GateHold.redactedText}, never as the text itself.
 *
 * 🔴 WHY OFFSETS ARE NOT A HOLE IN THE "COUNTS ONLY" RULE. That rule exists
 * because a report that quoted what was REMOVED would rebuild the
 * re-identification map the gate just destroyed. A survivor is the opposite
 * case: it was NOT removed, so it is still sitting in `redactedText`, which is
 * stored anyway because a reviewer has to read it. Pointing at a substring of a
 * string we already hold adds no information — it only saves the reviewer from
 * re-reading forty minutes of transcript hunting for the thing the model saw.
 *
 * ⚠ SO THE PAIRING IS LOAD-BEARING: these offsets are meaningful ONLY against
 * the exact `redactedText` they came with. Never store them next to a different
 * version of the text, and never put them in {@link GateReport}, which IS
 * counts-only and is shown in places the text is not.
 */
export interface SurvivorSpan {
  /** Index of the first character, into `redactedText`. */
  start: number
  /** Index one past the last character. */
  end: number
  /** The detector's category. A label, never the matched string. */
  type: DetectorFinding['type']
}

/**
 * 🔴 NOT AN ERROR — A REFUSAL TO INGEST. The caller must leave the content out
 * of every corpus and record the reason. There is no "ingest anyway" and no
 * `force` flag; the only way past a hold is a human review, which is audited.
 */
export interface GateHold {
  status: 'hold'
  stage: GateStage
  reason: string
  report: GateReport
  /**
   * 🔴 THE MODEL NEVER ANSWERED (429, 5xx, 402, network, timeout). Still not
   * ingested — but NOT a finding, so `anonymiseDocument.ts` leaves the row
   * retryable instead of holding it for Revisión. Absent on every real hold.
   */
  retryable?: true
  /**
   * The best-effort redacted text AT THE POINT OF REFUSAL, when there is one.
   *
   * 🔴 THIS IS NOT SAFE TO INGEST AND MUST NEVER BE STORED IN `redactedText` ON
   * A ROW. `corpusTextFor` reads that column and would publish this straight
   * into the shared corpus — which is precisely what the hold refused. It exists
   * for ONE purpose: giving a human reviewer something to read and correct. The
   * `documents` row keeps it in its own column (`heldText`) for that reason.
   *
   * Absent for a `structural` hold, which produced no output at all.
   */
  redactedText?: string
  /** Where verify found something still standing. Only ever set on a verify hold. */
  survivors?: SurvivorSpan[]
}

export type GateResult = { status: 'ready'; redactedText: string; report: GateReport } | GateHold

/**
 * What the gate is being asked to anonymise.
 *
 * ⚠ `contentKind` does NOT change the rules. The owner decided testimonies and
 * conversations run under the SAME gate, on the grounds that a testimony is
 * expected to be anonymous anyway. It is carried only so the model prompt can
 * describe the material accurately, and so the report says what was scrubbed.
 */
export interface GateInput {
  contentKind: 'testimonio' | 'conversacion'
  text: string
  /**
   * Known names and emails of the ecosistema's members, for stage 2.
   *
   * ⚠ Useful for a CONVERSATION, close to useless for a TESTIMONY — see the
   * header. Passing an empty array for a testimony is correct, not a shortcut.
   */
  roster?: readonly string[]
}

/** One finding from the detector: a literal string that identifies someone. */
export interface DetectorFinding {
  /** The exact substring as it appears in the text. */
  text: string
  /**
   * `persona` becomes `[Persona X]`, `lugar` becomes `[Domicilio X]`, and
   * everything else becomes `[Dato omitido]`.
   *
   * ⚠ `lugar` SHARES THE ADDRESS ALLOCATOR WITH STAGE 2 on purpose — same
   * argument as people: an address the regexes caught in one paragraph and the
   * model caught in another has to come out as the SAME label, or the redaction
   * invents two houses where the testimony described one.
   */
  type: 'persona' | 'lugar' | 'contacto' | 'identificador' | 'otro'
  /**
   * `false` when the model itself judged the string identifies nobody: a bare
   * title such as "el doctor" in "el doctor dijo".
   *
   * 🔴 THE GATE DOES NOT ACT ON IT (re-audit 2026-10-21): stage 3 redacts and
   * verify holds on every finding, whatever this says. Kept for measurement.
   * Anything other than an explicit `false` is recorded as identifying.
   */
  identifying?: boolean
}

/**
 * 🔴 THE SEAM THE MODEL LIVES BEHIND.
 *
 * Today this is ai-service `/v1/generate/sync`, which reaches OpenRouter. The
 * owner's endpoint will later be a box they physically control — SAME CALL,
 * different base URL. That is the whole reason this is an interface: swapping
 * the deployment must not touch the gate.
 *
 * ⚠ AND IT IS THE ONE PLACE THE UNREDACTED TEXT LEAVES THIS PROCESS. Stage 3
 * sends the RAW text to a hosted model in order to find out what to hide, which
 * is a contradiction that is easy to miss because the OUTPUT is clean. The owner
 * accepted it for development explicitly. ⚠ It stops being acceptable at the
 * first Voz from a real participant — that is a DATE on the roadmap, not a
 * config change.
 */
export interface PersonDetector {
  /** Stable name of the model behind this detector, for the report. */
  readonly name: string
  /**
   * Find every string in `text` that identifies a person.
   *
   * ⚠ MUST THROW rather than return `[]` when it could not run. An empty list
   * means "nothing to redact" and would let unscrubbed text through the gate;
   * a throw becomes a HOLD, which is the safe answer to "we do not know".
   */
  detect(args: { text: string; contentKind: 'testimonio' | 'conversacion' }): Promise<
    DetectorFinding[]
  >
}

/** What a person's name is replaced by. Index 0 → `[Persona A]`. */
export const PERSON_PLACEHOLDER_PREFIX = '[Persona '

/**
 * What an ADDRESS is replaced by. Index 0 → `[Domicilio A]`.
 *
 * 🔴 A LABEL, NOT A REDACTION BAR, for the same reason people get one. The
 * owner's decision was *"addressess should be anonimized"*, and the cheap way to
 * obey it is a blanket `[Dato omitido]`. That destroys the testimony: a Voz that
 * says "me mudé de [Dato omitido] a [Dato omitido] y luego volví a
 * [Dato omitido]" no longer records whether the person came back to the SAME
 * place. Labels keep the structure of what was said while removing the address
 * itself — exactly the trade `pseudonyms.ts` makes for names.
 *
 * ⚠ SAME LIFETIME RULE AS `[Persona X]`: stable within one document, deliberately
 * meaningless between documents. A `[Domicilio A]` that meant the same house
 * across the corpus would let a reader collect every testimony from one street.
 */
export const ADDRESS_PLACEHOLDER_PREFIX = '[Domicilio '

/** What a non-person identifier is replaced by. Deliberately not enumerated. */
export const OMITTED_PLACEHOLDER = '[Dato omitido]'

/**
 * Every placeholder this pipeline can emit, as a GLOBAL pattern. Shared by the
 * gate (what verify may ignore) and the detector (where a model span may not
 * be located). ⚠ Global: reset `lastIndex` or use `matchAll`/`match`/`replace`.
 */
export const PLACEHOLDER_PATTERN = /\[Dato omitido\]|\[Persona [A-Z]+\]|\[Domicilio [A-Z]+\]/g
