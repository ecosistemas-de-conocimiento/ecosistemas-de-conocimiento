/**
 * THE GATE ITSELF — four stages, one allocator, and exactly two possible
 * answers.
 *
 * ── 🔴 THERE IS NO "INGEST ANYWAY" AND NO PARTIAL SUCCESS ───────────────────
 *
 * `@edc/ai-client` HAS NO PER-DOCUMENT DELETE. Retirement closes a validity
 * window (`admin.setDocumentValidity`); the chunk and its embedding stay in the
 * corpus forever, and a retrieve that forgets `asOf` still sees them (see
 * `lib/publishDocument.ts`). So a document ingested with a name still in it is,
 * for practical purposes, PERMANENT. There is no button that fixes it later and
 * no migration that unsays it.
 *
 * That is why this function returns `ready | hold` and nothing in between. Not
 * "ready with warnings", not a `force` flag, not a confidence score the caller
 * can decide to ignore at 5pm on a Friday. Every uncertain outcome — a model
 * that would not answer, JSON that would not parse, a name still standing after
 * the scrub — ends in `hold`, which means the content was NOT ingested and a
 * human has to look. `hold` is a REFUSAL, not an error: nothing is broken, we
 * simply do not know that the text is safe, and "we do not know" must never
 * resolve to "ship it".
 *
 * ── THE FOUR STAGES, AND WHY THE ORDER IS THIS ORDER ────────────────────────
 *
 *   1 structural     dates coarsened, uuids and author markers stripped
 *   2 deterministic  emails, phones, CURP/RFC, urls, roster members
 *   3 content        the model DETECTS; this file REPLACES
 *   4 verify         the same detector, re-run over the REDACTED text
 *
 * The two cheap deterministic stages run first so the text the model sees is
 * already smaller and so their removals are never charged to the model's
 * accuracy. Stage 4 is the only stage that can fail on something the earlier
 * ones produced, which is exactly why it is last and why it is not optional.
 *
 * ── ONE ALLOCATOR, THREADED THROUGH ALL OF IT ───────────────────────────────
 *
 * 🔴 Stage 2 and stage 3 share the SAME {@link createPseudonymAllocator}
 * instance. A member matched from the roster in stage 2 and named again in a
 * sentence the model catches in stage 3 must come out as the same
 * `[Persona A]`. Two allocators would restart at `A` and silently merge two
 * different people into one pseudonym — a redaction that fabricates a
 * relationship that never existed.
 *
 * ── 🔴 WHAT THE REPORT MAY CONTAIN ──────────────────────────────────────────
 *
 * COUNTS AND RULE LABELS ONLY. Never a matched string, never a pseudonym→name
 * mapping, never a quoted excerpt — not in `removed`, not in `note`, and not in
 * a hold `reason`. Putting the matched strings in the report would recreate,
 * under a friendlier name, precisely the re-identification map this whole design
 * refuses to keep: `GateReport` is stored and shown in an admin panel, so a
 * report that quoted the names would put the names back in the database the
 * moment the gate finished removing them. The verify reason therefore says HOW
 * MANY findings survived and nothing else.
 */

import { deterministicPass } from './deterministic'
import { createPseudonymAllocator } from './pseudonyms'
import { structuralPass } from './structural'
import { absorbTitles, onlyPlaceholders } from './titles'
import type {
  DetectorFinding,
  GateInput,
  GateReport,
  GateResult,
  GateStage,
  GateStageReport,
  PersonDetector,
  RedactionCount,
  SurvivorSpan,
} from './types'
import { OMITTED_PLACEHOLDER } from './types'

export interface GateDeps {
  detector: PersonDetector
}

/**
 * Every placeholder this pipeline can emit.
 *
 * ⚠ Used by stage 4 to tell "the model found a name we missed" from "the model
 * found the word `Persona` inside our own placeholder". Without this the gate
 * would HOLD on every document it successfully redacted — the safest possible
 * failure, and a completely useless product.
 */
const PLACEHOLDER = /\[Dato omitido\]|\[Persona [A-Z]+\]|\[Domicilio [A-Z]+\]/g

function countsByLabel(entries: Iterable<string>): RedactionCount[] {
  const tally = new Map<string, number>()
  for (const label of entries) tally.set(label, (tally.get(label) ?? 0) + 1)
  return [...tally].map(([label, count]) => ({ label, count }))
}

/** Character ranges in `text` occupied by placeholders we inserted. */
function placeholderSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const m of text.matchAll(PLACEHOLDER)) {
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

/**
 * True when every occurrence of `needle` sits inside a placeholder — or there is
 * no occurrence at all.
 *
 * ⚠ "No occurrence at all" counts as covered on purpose: a finding whose text is
 * not in the redacted document cannot be a leak from that document, so holding
 * on it would mean a hallucinating model could block ingestion forever with no
 * way for a human to act on the report.
 */
function coveredByPlaceholder(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  needle: string,
): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return true
    const end = at + needle.length
    const inside = spans.some(([s, e]) => at >= s && end <= e)
    if (!inside) return false
    from = at + 1
  }
}

/**
 * Replace every occurrence of `needle` that does not cut into a placeholder.
 * Returns null when nothing was replaced.
 *
 * 🔴 MEASURED 2026-10-17, 9,454 words: stage 2 had written `[Domicilio E]`, the
 * model then returned part of it as a finding, and a plain split/join turned
 * every such placeholder into `[[Domicilio AH]E]`. Verify held on 13 of them.
 * An occurrence that lies inside a placeholder, or straddles its edge, is
 * skipped; one that wholly CONTAINS a placeholder is replaced (that only
 * removes more text).
 *
 * Literal `indexOf` rather than a built RegExp: the finding is arbitrary user
 * text and `new RegExp(finding.text)` would either throw on a stray `(` or,
 * worse, silently match something else entirely.
 */
function replaceOutsidePlaceholders(
  text: string,
  needle: string,
  replacement: () => string,
): string | null {
  const spans = placeholderSpans(text)
  let label: string | undefined
  let result = ''
  let copied = 0
  let search = 0
  for (;;) {
    const at = text.indexOf(needle, search)
    if (at === -1) break
    const end = at + needle.length
    const cuts = spans.some(([s, e]) => at < e && end > s && !(at <= s && end >= e))
    if (cuts) {
      search = at + 1
      continue
    }
    label ??= replacement()
    result += text.slice(copied, at) + label
    copied = end
    search = end
  }
  // `copied` only moves on a replacement, and a needle is never empty.
  return copied === 0 ? null : result + text.slice(copied)
}

/**
 * Replace findings, LONGEST FIRST.
 *
 * 🔴 THE ORDER IS A REAL BUG FIX, NOT TIDINESS. Models routinely return both
 * "María" and "María López". Shortest-first turns the full name into
 * `[Persona A] López` — the surname survives, glued to a pseudonym, which is
 * worse than leaving the whole name alone because the document now LOOKS
 * redacted. Longest-first consumes the full name, and the later "María" simply
 * finds nothing left to replace.
 */
function applyFindings(
  text: string,
  findings: readonly DetectorFinding[],
  allocate: (name: string) => string,
  allocateAddress: (address: string) => string,
): { text: string; labels: string[] } {
  const ordered = [...findings].sort((a, b) => b.text.length - a.text.length)
  const labels: string[] = []
  let out = text

  for (const finding of ordered) {
    /**
     * 🔴 `lugar` GETS A LABEL, NOT A BAR, and it comes from the SAME allocator
     * stage 2 used. A testimony that says the family moved out of one place and
     * back into it is telling you something; `[Dato omitido]` twice erases
     * whether it was the same place, and a second allocator would restart at `A`
     * and claim it was not. Same argument as people, one namespace down.
     *
     * ⚠ The model's `lugar` covers "domicilios y lugares identificables", so a
     * school can land under `[Domicilio X]`. That reads slightly wrong and is
     * accepted: both are places whose identity we are removing, and splitting
     * them would need the model to make a distinction its prompt never asked for.
     */
    // ⚠ LAZY: a finding that replaces nothing must not use up a label, or the
    // report counts a person who is not in the text and the letters skip.
    const replacement = () =>
      finding.type === 'persona'
        ? allocate(finding.text)
        : finding.type === 'lugar'
          ? allocateAddress(finding.text)
          : OMITTED_PLACEHOLDER
    const next = replaceOutsidePlaceholders(out, finding.text, replacement)
    if (next === null) continue
    labels.push(finding.type)
    out = next
  }

  // 🔴 A title before a name is part of the name: "Don [Persona F]" becomes
  // "[Persona F]". Without this, verify reads the title as a leftover and holds
  // a document whose names are all gone. See `titles.ts`.
  return { text: absorbTitles(out), labels }
}

/**
 * Every place a survivor occurs in the output, as offsets.
 *
 * ⚠ EVERY occurrence, not the first. A name the model missed usually appears
 * more than once, and a reviewer who fixes only the highlighted one and approves
 * would release the others.
 */
function survivorSpans(text: string, survivors: readonly DetectorFinding[]): SurvivorSpan[] {
  const spans: SurvivorSpan[] = []
  for (const finding of survivors) {
    if (finding.text.length === 0) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(finding.text, from)
      if (at === -1) break
      spans.push({ start: at, end: at + finding.text.length, type: finding.type })
      from = at + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Failure CLASS of a thrown detector error. ⚠ Never the message, never the text. */
function failureClassOf(err: unknown): string {
  const named = err as { failureClass?: unknown; name?: unknown }
  if (typeof named?.failureClass === 'string') return named.failureClass
  if (typeof named?.name === 'string') return named.name
  return 'desconocido'
}

export async function runAnonymisationGate(
  input: GateInput,
  deps: GateDeps,
): Promise<GateResult> {
  // 🔴 ONE allocator for the whole document, created here and dropped when this
  // function returns. See `pseudonyms.ts`: its lifetime IS the safety property.
  const allocator = createPseudonymAllocator()
  const stages: GateStageReport[] = []

  const report = (): GateReport => ({
    stages,
    pseudonyms: allocator.count,
    addresses: allocator.addressCount,
    model: deps.detector.name,
  })

  /**
   * ⚠ `redactedText` ON A HOLD IS FOR A HUMAN TO READ, NOT FOR A CORPUS. See
   * `GateHold` — storing it in a row's `redactedText` column would hand the
   * publish path exactly the text this refusal was about.
   */
  const hold = (
    stage: GateStage,
    reason: string,
    extra?: { redactedText?: string; survivors?: SurvivorSpan[] },
  ): GateResult => ({
    status: 'hold',
    stage,
    reason,
    report: report(),
    ...(extra ?? {}),
  })

  // ── 1. STRUCTURAL ─────────────────────────────────────────────────────────
  const structural = structuralPass(input.text)
  stages.push({ stage: 'structural', removed: structural.removed })

  if (structural.text.trim().length === 0) {
    // ⚠ HOLD, NOT "ready with an empty string". An empty body would ingest a
    // chunk that matches nothing and can never be found or corrected — a silent
    // permanent hole in the corpus. It also almost always means the extraction
    // upstream failed, which is a thing a human should see.
    return hold(
      'structural',
      'El texto quedó vacío después de la limpieza estructural, así que no hay nada que ingerir. Revisa la extracción del documento.',
    )
  }

  // ── 2. DETERMINISTIC ──────────────────────────────────────────────────────
  const deterministic = deterministicPass({
    text: structural.text,
    roster: input.roster,
    allocate: (name) => allocator.labelFor(name),
    // 🔴 THE SAME ALLOCATOR STAGE 3 WILL USE. See the header — one allocator per
    // document is the invariant, and addresses obey it exactly like people do.
    allocateAddress: (address) => allocator.addressLabelFor(address),
  })
  stages.push({ stage: 'deterministic', removed: deterministic.removed })

  // ── 3. CONTENT ────────────────────────────────────────────────────────────
  let found: DetectorFinding[]
  try {
    found = await deps.detector.detect({
      text: deterministic.text,
      contentKind: input.contentKind,
    })
  } catch (err) {
    // 🔴 A detector that could not run is NOT "nothing to redact". See
    // `detector.ts`: the whole reason it throws instead of returning `[]` is to
    // land here.
    // The deterministic output is real work already done and a reviewer can act
    // on it, so it travels with the refusal even though the model never ran.
    return hold(
      'content',
      `No se pudo revisar el contenido con el modelo (${failureClassOf(err)}), así que no se ingirió nada.`,
      { redactedText: deterministic.text },
    )
  }

  const applied = applyFindings(
    deterministic.text,
    found,
    (name) => allocator.labelFor(name),
    (address) => allocator.addressLabelFor(address),
  )
  stages.push({ stage: 'content', removed: countsByLabel(applied.labels) })

  // ── 4. VERIFY ─────────────────────────────────────────────────────────────
  //
  // The same detector, over the OUTPUT. This is the only check in the pipeline
  // that can catch stage 3 having missed something, and it is the reason stage 3
  // was built as a detector rather than a rewriter — you cannot verify a
  // rewriter by running it twice.
  let survivors: DetectorFinding[]
  try {
    survivors = await deps.detector.detect({
      text: applied.text,
      contentKind: input.contentKind,
    })
  } catch (err) {
    return hold(
      'verify',
      `No se pudo verificar el texto ya censurado (${failureClassOf(err)}), así que no se ingirió nada.`,
      { redactedText: applied.text },
    )
  }

  const spans = placeholderSpans(applied.text)
  // ⚠ `onlyPlaceholders`: a finding made of our placeholders, punctuation and
  // titles before a person ("[Domicilio AP], [Domicilio AQ]") names nobody.
  // It needs at least one placeholder, so a bare "Don" still holds.
  const real = survivors.filter(
    (f) => !coveredByPlaceholder(applied.text, spans, f.text) && !onlyPlaceholders(f.text),
  )

  stages.push({
    stage: 'verify',
    removed: [],
    note:
      real.length === 0
        ? 'La verificación no encontró datos personales en el texto censurado.'
        : `La verificación encontró ${real.length} dato(s) personal(es) todavía presentes.`,
  })

  if (real.length > 0) {
    // ⚠ THE COUNT, NEVER THE STRINGS. This reason is stored on the row and shown
    // in the admin panel; quoting the surviving names would put them straight
    // back into the database the gate just kept them out of. Whoever reviews the
    // hold reads `redactedText` below, with `survivors` marking where the model
    // saw something — ⚠ NOT the original, which `lib/holdReview.ts` deliberately
    // never returns.
    return hold(
      'verify',
      `La verificación encontró ${real.length} dato(s) personal(es) que siguen en el texto, así que no se ingirió nada. Revisa el documento original.`,
      {
        redactedText: applied.text,
        // 🔴 OFFSETS, NEVER THE STRINGS — and they only mean anything against the
        // `redactedText` on this same object. See `SurvivorSpan`.
        survivors: survivorSpans(applied.text, real),
      },
    )
  }

  return { status: 'ready', redactedText: applied.text, report: report() }
}
