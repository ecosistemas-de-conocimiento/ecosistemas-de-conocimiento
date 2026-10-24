/**
 * The review screen for HELD documents, as pure data.
 *
 * ── 🔴 WHAT THIS SCREEN IS ──────────────────────────────────────────────────
 *
 * Uploaded testimonies and conversations pass through an anonymisation gate
 * before they can enter the corpus. The gate is fail-closed: it replaces names,
 * emails, CURPs, phones and addresses, then re-reads its own output and HOLDS
 * the document if anything identifying is still standing. There is deliberately
 * no automatic override — see `apps/backend/src/lib/holdReview.ts`, which is the
 * authority for every rule restated here.
 *
 * So a person has to look. This module is the half of that screen a test can
 * assert: `apps/web` runs vitest in `node` with no DOM, so nothing rendered can
 * be checked. Every rule and every load-bearing sentence therefore lives here,
 * and the `.svelte` files only lay it out.
 *
 * ── 🔴 THE THREE THINGS THIS SCREEN MUST NOT DO ─────────────────────────────
 *
 *  1. NAME THE SPEAKER. Nothing in this file, and nothing in the components,
 *     may show or reconstruct who a testimony is about. The backend does not
 *     store it — `subject`, `speaker`, `onBehalf` and `consent` exist in
 *     `apps/backend/src` only inside comments explaining why they do not exist —
 *     and the uploader is deliberately not returned by the API. We do not fetch
 *     them either. There is no "compartido por" line here and there must never
 *     be one.
 *
 *  2. IMPROVE THE TITLE. `title` arrives NEUTRAL — "Testimonio retenido" — or,
 *     for a testimonio, as the system-proposed `generatedTitle` the backend made
 *     from the gate's redacted output (owner ruling 2026-10-24). A filename like
 *     "Testimonio de María López.mp3" is a handle on whose words these are, so
 *     the backend never sends one. See {@link isNeutralTitle}: we render what
 *     we are given and reconstruct nothing from any other field.
 *
 *  3. DRAW STALE HIGHLIGHTS. `survivors` are OFFSETS into the `heldText` from
 *     the SAME response. The moment the reviewer edits the text, those numbers
 *     point at the wrong characters. {@link highlightsAreStale} exists so the
 *     screen says so instead of underlining an innocent word.
 */

// ---------------------------------------------------------------------------
// The wire shape — mirrors `apps/backend/src/lib/holdReview.ts`
// ---------------------------------------------------------------------------

/** What kind of thing was held. Mirrors the backend's `ContentKind`. */
export type HoldContentKind = 'documento' | 'testimonio' | 'conversacion';

/** The detector's category for one survivor. A LABEL, never the matched text. */
export type SurvivorType = 'persona' | 'lugar' | 'contacto' | 'identificador' | 'otro';

/**
 * Where the verify stage found something still standing.
 *
 * ⚠ Offsets, not strings, and meaningful ONLY against the `heldText` they
 * arrived with. See the file header, rule 3.
 */
export interface SurvivorSpan {
  start: number;
  end: number;
  type: SurvivorType;
}

/** One row in the queue. ⚠ Carries NO text — the list endpoint does not send any. */
export interface HeldSummary {
  id: string;
  /**
   * 🔴 What the row is called: the system-proposed title when there is one,
   * else the gate's NEUTRAL title. Never a filename. See the header, rule 2.
   */
  title: string;
  /**
   * The system-proposed title (backend `documents.testimonioTitle`, made from
   * the gate's REDACTED held output, owner ruling 2026-10-24), or `null`.
   */
  generatedTitle: string | null;
  /** The neutral kind label, shown under a generated title. */
  label: string;
  contentKind: HoldContentKind;
  /** Which stage refused: `structural | deterministic | content | verify`. */
  stage: string | null;
  /** The gate's own words. Counts only — it never quotes what it found. */
  reason: string | null;
  survivorCount: number;
  updatedAt: string | null;
}

/** Everything needed to decide about one document. */
export interface HeldDetail extends HeldSummary {
  /** 🔴 The gate's REFUSED output. Never the original. `null` for a structural hold. */
  heldText: string | null;
  survivors: SurvivorSpan[];
  /** Per-stage counts and rule names. ⚠ No removed text, ever. */
  report: GateReport | null;
}

export interface GateStageReport {
  stage: string;
  removed: Array<{ label: string; count: number }>;
  note?: string;
}

export interface GateReport {
  stages: GateStageReport[];
  pseudonyms: number;
  addresses?: number;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Parsing what the BFF returns
// ---------------------------------------------------------------------------

const CONTENT_KINDS: readonly HoldContentKind[] = ['documento', 'testimonio', 'conversacion'];
const SURVIVOR_TYPES: readonly SurvivorType[] = [
  'persona',
  'lugar',
  'contacto',
  'identificador',
  'otro',
];

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

function parseKind(raw: unknown): HoldContentKind {
  return typeof raw === 'string' && (CONTENT_KINDS as readonly string[]).includes(raw)
    ? (raw as HoldContentKind)
    : 'documento';
}

/**
 * ⚠ An unknown category folds to `otro`, it does not drop the span. A detector
 * type the backend added and this build has not learned yet is still a place a
 * reviewer must look — silently not highlighting it is the failure this screen
 * exists to prevent.
 */
function parseSurvivorType(raw: unknown): SurvivorType {
  return typeof raw === 'string' && (SURVIVOR_TYPES as readonly string[]).includes(raw)
    ? (raw as SurvivorType)
    : 'otro';
}

export function parseSurvivors(raw: unknown): SurvivorSpan[] {
  if (!Array.isArray(raw)) return [];
  const out: SurvivorSpan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as { start?: unknown; end?: unknown; type?: unknown };
    if (typeof s.start !== 'number' || typeof s.end !== 'number') continue;
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    out.push({ start: s.start, end: s.end, type: parseSurvivorType(s.type) });
  }
  return out;
}

/**
 * A queue row.
 *
 * 🔴 `title` IS TAKEN VERBATIM AND NEVER SUBSTITUTED. A row whose title is
 * missing falls back to another NEUTRAL string, not to a name, an id or a
 * filename — there is no field on this object that would be safe to fall back
 * to. Rows with no id are dropped: they cannot be opened.
 */
export function parseHeldSummary(raw: unknown): HeldSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id =
    typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
  if (!id) return null;
  const kind = parseKind(row.contentKind);
  const count = typeof row.survivorCount === 'number' ? row.survivorCount : 0;
  const label = str(row.label) ?? fallbackTitle(kind);
  // ⚠ Only a testimonio carries one, and never a bracket (a placeholder).
  const generated = kind === 'testimonio' ? str(row.generatedTitle)?.trim() ?? null : null;
  const generatedTitle = generated && !/[[\]]/.test(generated) ? generated : null;
  const rawTitle = str(row.title);
  return {
    id,
    // ⚠ A bracketed title (a placeholder) is never shown; the label stands in.
    title: generatedTitle ?? (rawTitle && !/[[\]]/.test(rawTitle) ? rawTitle : label),
    generatedTitle,
    label,
    contentKind: kind,
    stage: str(row.stage),
    reason: str(row.reason),
    survivorCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    updatedAt: str(row.updatedAt),
  };
}

export function parseHeldList(raw: unknown): HeldSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseHeldSummary).filter((r): r is HeldSummary => r !== null);
}

export function parseHeldDetail(raw: unknown): HeldDetail | null {
  const summary = parseHeldSummary(raw);
  if (!summary) return null;
  const row = raw as Record<string, unknown>;
  return {
    ...summary,
    heldText: str(row.heldText),
    survivors: parseSurvivors(row.survivors ?? row.anonymisationSurvivors),
    report: (row.report as GateReport | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// 🔴 The neutral title
// ---------------------------------------------------------------------------

/**
 * The same neutral strings the backend produces, used ONLY as a fallback when
 * the API sent no title at all.
 *
 * ⚠ Not a place to be clever. Every branch returns a sentence about the KIND of
 * thing, never about whose it is.
 */
export function fallbackTitle(kind: HoldContentKind): string {
  if (kind === 'testimonio') return 'Testimonio retenido';
  if (kind === 'conversacion') return 'Conversación retenida';
  return 'Documento retenido';
}

/** Every title this screen is allowed to show. */
export const NEUTRAL_TITLES: readonly string[] = [
  'Testimonio retenido',
  'Conversación retenida',
  'Documento retenido',
];

/**
 * Is this a title the gate produced, rather than something that leaked?
 *
 * ⚠ A TEST HOOK, NOT A FILTER. Nothing calls this to sanitise output — a screen
 * that repaired a leaked filename at render time would hide the leak instead of
 * failing on it. It exists so `holds.test.ts` can state the rule out loud.
 */
export function isNeutralTitle(title: string): boolean {
  return NEUTRAL_TITLES.includes(title);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * What each detector category means, in words a reviewer reads once and knows.
 *
 * ⚠ Plain Spanish nouns, not the machine word. "identificador" tells a reviewer
 * nothing; "CURP, RFC u otro número de identidad" tells them what to look for.
 */
export const SURVIVOR_LABELS: Record<SurvivorType, string> = {
  persona: 'Nombre de una persona',
  lugar: 'Domicilio o lugar exacto',
  contacto: 'Teléfono o correo',
  identificador: 'CURP, RFC u otro número de identidad',
  otro: 'Otro dato que puede identificar a alguien',
};

export function survivorLabel(type: SurvivorType): string {
  return SURVIVOR_LABELS[type] ?? SURVIVOR_LABELS.otro;
}

/**
 * Which step of the gate refused, said plainly.
 *
 * ⚠ The backend's stage names are English machine words that reach this screen
 * unchanged (`structural`, `deterministic`, `content`, `verify`). An unknown
 * one falls back to a sentence that is still true, rather than printing the
 * machine word at a person.
 */
export const STAGE_LABELS: Record<string, string> = {
  structural: 'No se pudo leer el archivo',
  deterministic: 'Las reglas de datos personales',
  content: 'La lectura del modelo',
  verify: 'La segunda lectura de verificación',
};

export function stageLabel(stage: string | null): string {
  if (!stage) return 'La revisión automática';
  return STAGE_LABELS[stage] ?? 'La revisión automática';
}

/** `1 dato` / `3 datos`. Spanish agrees in number; the copy has to as well. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How many things the gate still found, as a sentence for the queue row. */
export function survivorCountLabel(count: number): string {
  if (count <= 0) return 'Sin datos señalados';
  return plural(count, 'dato señalado', 'datos señalados');
}

/** `2026-08-27T15:02:06Z` → `27 ago 2026`. Empty string when unparseable. */
export function formatHoldDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

// ---------------------------------------------------------------------------
// 🔴 Highlighting the survivors
// ---------------------------------------------------------------------------

/** One run of characters, either flagged or not. */
export interface TextSegment {
  text: string;
  /** `null` ⇒ ordinary text. Otherwise the category the gate flagged. */
  type: SurvivorType | null;
}

/**
 * Cut `text` into flagged and unflagged runs.
 *
 * 🔴 THE OFFSETS ARE TREATED AS UNTRUSTED. They came from a model's output via
 * two hops of JSON, and a span that runs past the end of the string, starts
 * after it ends, or overlaps its neighbour is not a reason to render nothing —
 * a reviewer with no highlights hunts through forty minutes of transcript by
 * hand. So: clamp to the string, drop the empty ones, sort, and MERGE overlaps
 * rather than nesting them.
 *
 * ⚠ MERGED SPANS TAKE THE FIRST CATEGORY. Two detectors disagreeing about the
 * same characters is rare and the disagreement is not worth a UI; what matters
 * is that the characters are marked. Never split the difference by drawing one
 * span inside another — nested marks are what produce off-by-one highlights.
 */
export function segmentHeldText(
  text: string,
  survivors: readonly SurvivorSpan[],
): TextSegment[] {
  if (!text) return [];

  const spans = survivors
    .map((s) => ({
      start: Math.max(0, Math.min(Math.floor(s.start), text.length)),
      end: Math.max(0, Math.min(Math.floor(s.end), text.length)),
      type: s.type,
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }

  const out: TextSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) out.push({ text: text.slice(cursor, span.start), type: null });
    out.push({ text: text.slice(span.start, span.end), type: span.type });
    cursor = span.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), type: null });
  return out;
}

/**
 * 🔴 HAVE THE HIGHLIGHTS STOPPED MEANING ANYTHING?
 *
 * The offsets index the `heldText` that arrived in the SAME response. One typed
 * character shifts every position after it, so the marks would sit on the wrong
 * words — and a wrong highlight is worse than none: it tells a reviewer "the
 * gate flagged this" about a word the gate never saw, and implicitly tells them
 * the real survivor is clean.
 *
 * So the screen stops drawing them and says why, rather than guessing. There is
 * no attempt to re-map the offsets through a diff: the gate is the only thing
 * entitled to say where an identifier is, and re-running it is what approving
 * the edit does anyway.
 */
export function highlightsAreStale(shownText: string | null, currentText: string): boolean {
  if (shownText === null) return false;
  return shownText !== currentText;
}

/** Counts per category, most common first. For the "what did it find" list. */
export function survivorBreakdown(
  survivors: readonly SurvivorSpan[],
): Array<{ type: SurvivorType; label: string; count: number }> {
  const counts = new Map<SurvivorType, number>();
  for (const s of survivors) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, label: survivorLabel(type), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type Decision = 'approve' | 'reject';

export interface DecisionInput {
  decision: Decision;
  /** What is in the editor right now. */
  text: string;
  /** The `heldText` the server sent. Used to tell "edited" from "as-is". */
  originalText: string | null;
  note: string;
}

export interface DecisionBody {
  decision: Decision;
  text?: string;
  note?: string;
}

/** The backend truncates at 1000; the box should not let people overrun it. */
export const MAX_NOTE_LENGTH = 1000;

/**
 * Turn what is on screen into the POST body.
 *
 * ⚠ AN UNCHANGED TEXT IS OMITTED, NOT ECHOED. The server already holds its own
 * refused output and uses it when `text` is absent. Sending the string back
 * would make an "approve as-is" indistinguishable from an edit that happens to
 * match, and `textEdited` on the audit row is the field that tells a later
 * reader whether a human actually changed anything.
 *
 * 🔴 A REJECTION SENDS NO TEXT AT ALL. The server clears `heldText` on a
 * rejection; posting a body carrying the text alongside "reject" reads, to
 * anyone auditing later, as though the text might have been kept.
 */
export function decisionBody(input: DecisionInput): DecisionBody {
  const note = input.note.trim().slice(0, MAX_NOTE_LENGTH);
  const body: DecisionBody = { decision: input.decision };
  if (note) body.note = note;
  if (input.decision === 'reject') return body;
  if (input.originalText !== null && input.text !== input.originalText) body.text = input.text;
  if (input.originalText === null) body.text = input.text;
  return body;
}

/**
 * Can this decision be sent, and if not, what does the person need to fix?
 *
 * ⚠ The same refusals the backend makes, said BEFORE the round trip and in
 * Spanish. This is not the control — `decideOnHold` refuses an empty approval
 * itself — it is so the person finds out while their cursor is still in the
 * box.
 */
export function decisionProblem(input: DecisionInput): string | null {
  if (input.decision === 'reject') return null;
  if (input.text.trim() === '') {
    return 'No puedes aprobar un texto vacío. Escribe la versión corregida, o rechaza el documento.';
  }
  return null;
}

/** `true` ⇒ the person changed the redaction and that change is what gets saved. */
export function wasEdited(input: Pick<DecisionInput, 'text' | 'originalText'>): boolean {
  if (input.originalText === null) return true;
  return input.text !== input.originalText;
}

// ---------------------------------------------------------------------------
// 🔴 The copy
// ---------------------------------------------------------------------------
//
// Every user-facing sentence on this screen is here, so a test can state what
// the screen promises and a refactor cannot quietly soften it. Short sentences,
// everyday words: the people reading this are researchers, but the product's
// whole discipline is that nothing on screen requires a second reading.

export const REVIEW_TITLE = 'Documentos retenidos';

export const REVIEW_INTRO =
  'Antes de entrar a la biblioteca, cada documento pasa por una revisión automática que quita nombres, correos, teléfonos, CURP y domicilios. Cuando queda algo que puede identificar a una persona, el documento se detiene aquí y alguien tiene que leerlo.';

/** ⚠ Said out loud, because an empty queue and a broken queue look the same. */
export const QUEUE_EMPTY = 'No hay documentos retenidos en este ecosistema.';
export const QUEUE_EMPTY_HINT = 'Cuando la revisión automática detenga uno, aparecerá aquí.';
export const QUEUE_UNAVAILABLE =
  'No pudimos leer la lista de documentos retenidos. Vuelve a intentarlo en un momento.';
export const DETAIL_UNAVAILABLE =
  'No pudimos abrir este documento. Puede que alguien ya lo haya revisado.';

/** ⚠ The list carries no text on purpose. Say so, so nobody looks for it. */
export const QUEUE_NO_TEXT_NOTE = 'La lista no muestra el texto. Ábrelo para leerlo.';

/**
 * 🔴 THE SENTENCE THAT MAKES THE EDITOR HONEST.
 *
 * The reviewer never sees the original, and must not think they do. What is in
 * the box is the gate's own output, with the identifiers already replaced — so
 * "edit" here means "finish the redaction", never "restore the words".
 */
export const EDITING_REDACTED_NOTICE =
  'Estás leyendo la versión ya tachada, no el original. Los datos que la revisión alcanzó a quitar aparecen como [Persona 1], [Domicilio 1] o [Dato omitido]. El original no se muestra aquí y nunca entra a la biblioteca.';

export const EDIT_HINT =
  'Si quedó un dato que identifica a alguien, quítalo aquí. Lo que dejes escrito es lo que se guarda.';

/** 🔴 The stale-offsets warning. See {@link highlightsAreStale}. */
export const STALE_HIGHLIGHTS_NOTICE =
  'Cambiaste el texto, así que ya no marcamos dónde estaban los datos. Las marcas solo sirven para el texto tal como te lo mostramos.';

export const SURVIVORS_TITLE = 'Datos que la revisión encontró';
export const SURVIVORS_HINT = 'Está resaltado en el texto de abajo.';
export const NO_SURVIVORS =
  'La revisión no señaló posiciones concretas en este documento.';

/** A `structural` hold produced nothing to read. Do not pretend otherwise. */
export const NO_TEXT_NOTICE =
  'Este documento no llegó a producir texto, así que no hay nada que leer ni que aprobar. Puedes rechazarlo.';

// ── Approving ──────────────────────────────────────────────────────────────
//
// 🔴 APPROVING IS OVERRIDING A SAFETY GATE. The button may not say "Aprobar"
// and leave the person to guess what happens next. The label names the action
// and the sentence next to it names the consequence, including the part that is
// about them: it is recorded, with their name on it.

export const APPROVE_LABEL = 'Aprobar y agregar a la biblioteca';

export const APPROVE_CONSEQUENCE =
  'La revisión automática detuvo este documento porque encontró datos que pueden identificar a una persona. Si lo apruebas, estás diciendo que el texto de arriba ya se puede compartir: entra a la biblioteca y el chat podrá citarlo dentro de este ecosistema.';

export const APPROVE_RECORDED =
  'Queda registrado que tú lo aprobaste, en qué fecha y qué encontró la revisión. Ese registro no se borra.';

export const APPROVE_CONFIRM = '¿Aprobar este documento y dejar que entre a la biblioteca?';

// ── Rejecting ──────────────────────────────────────────────────────────────

export const REJECT_LABEL = 'Rechazar y borrar el texto retenido';

/** 🔴 Not undoable, and it destroys the text. Said before the click, not after. */
export const REJECT_CONSEQUENCE =
  'Si lo rechazas, el documento no entra a la biblioteca y el texto retenido se borra. Ya no se podrá volver a revisar aquí. Esto no se puede deshacer.';

export const REJECT_CONFIRM = '¿Rechazar este documento y borrar el texto retenido?';

export const CANCEL_LABEL = 'Cancelar';

// ── The note ───────────────────────────────────────────────────────────────

export const NOTE_LABEL = 'Nota sobre tu decisión (opcional)';

export const NOTE_PLACEHOLDER = 'Por qué lo apruebas o lo rechazas';

// ── Outcomes ───────────────────────────────────────────────────────────────

export const APPROVED_TOAST = 'Aprobado. El documento va a entrar a la biblioteca.';
export const REJECTED_TOAST = 'Rechazado. El texto retenido se borró.';
export const DECISION_FAILED =
  'No pudimos guardar tu decisión. El documento sigue retenido. Vuelve a intentarlo.';

/** Shown when `?eco=` names something the caller cannot see. */
export const ECOSYSTEM_NOT_FOUND =
  'No encontramos ese ecosistema, o no puedes revisar sus documentos retenidos.';

export const NO_ECOSYSTEM =
  'No perteneces a ningún ecosistema, así que no hay documentos retenidos que revisar.';

/** The refusal copy for someone without the capability. */
export const NOT_A_REVIEWER =
  'Esta sección es para quien revisa los documentos que la anonimización detuvo.';
