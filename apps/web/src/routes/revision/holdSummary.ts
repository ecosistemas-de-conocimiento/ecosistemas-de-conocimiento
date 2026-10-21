/**
 * The two sentences under a held document's title, on the queue and on the
 * detail page.
 *
 * ── WHY THIS DOES NOT JUST PRINT THE GATE'S REASON ─────────────────────────
 *
 * Seen on dev, 2026-10-21 (UX backlog #11): the badge said "7 datos
 * señalados" and the reason underneath said "encontró 4 dato(s) personal(es)
 * … así que no se ingirió nada. Revisa el documento original." Four problems:
 *
 *   · Two numbers. The badge counts highlights; the stored reason counted
 *     distinct findings. The gate now counts highlights too, but rows held
 *     before that fix keep their old reason forever.
 *   · "ingirió" is engineering jargon.
 *   · "Revisa el documento original" points at something this screen never
 *     shows, by design.
 *   · `stageLabel(stage) + " lo detuvo."` broke for two stages: "No se pudo
 *     leer el archivo lo detuvo." and "Las reglas … lo detuvo." (plural
 *     subject, singular verb). So the first sentence is written whole here.
 *
 * So when there are highlights, the sentence is built HERE from the same
 * `survivorCount` the badge uses, and the stored reason is not shown. Any
 * other hold (a file with no text, a check that could not finish) still shows
 * the gate's reason, with the old jargon rewritten.
 *
 * ⚠ Like the gate's reason, nothing here may ever quote the text.
 */

export const NOT_ADDED = 'Todavía no se agregó a la búsqueda.';

export interface HoldSummaryInput {
  stage: string | null;
  reason: string | null;
  survivorCount: number;
}

export interface HoldSummaryText {
  /** Why it stopped. Always present. */
  why: string;
  /** What that means for the document. */
  detail: string;
}

/** Old gate wording → plain Spanish. For rows held before the gate's copy changed. */
export function plainReason(reason: string): string {
  return reason
    .replace(/,?\s*así que no se ingirió nada\.?/g, `. ${NOT_ADDED}`)
    .replace(/así que no hay nada que ingerir/g, 'así que no hay nada que agregar a la búsqueda')
    .replace(/\s*Revisa el documento original\.?/g, '')
    .replace(/dato\(s\) personal\(es\)/g, 'datos personales')
    .trim();
}

export function holdSummary(hold: HoldSummaryInput): HoldSummaryText {
  const n = hold.survivorCount;
  if (n > 0) {
    return {
      why:
        n === 1
          ? 'La revisión automática lo detuvo: quedó 1 dato que podría identificar a alguien.'
          : `La revisión automática lo detuvo: quedaron ${n} datos que podrían identificar a alguien.`,
      detail: NOT_ADDED,
    };
  }
  const reason = hold.reason ? plainReason(hold.reason) : '';
  return {
    why:
      hold.stage === 'structural'
        ? 'No se pudo leer el texto del archivo.'
        : 'La revisión automática lo detuvo.',
    detail: reason || NOT_ADDED,
  };
}
