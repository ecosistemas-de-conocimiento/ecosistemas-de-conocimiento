/**
 * 🔴 A ROW HELD FOR CONSENT NEVER LEAVES FOR A MODEL FROM A CORPUS-WIDE JOB
 * (owner rule 2026-11-04: the Semiosis workshop stays unpublished until its
 * authors consent; audit `taller-2026-11-10/rutas.md` #6, #7).
 *
 * The ONE place the graph jobs ask. Today it answers `false` for every row:
 * the mark does not exist yet. edc-1 owns `collections/Documents.ts` and will
 * define it (a `consentHeld` column, or an id list). When it lands, wire it
 * here and nowhere else; the callers already skip on `true`:
 *
 *   · `lib/graph/backfill.ts` `runGraphBackfill` — per row, before any read of
 *     its text or any write (also the published re-extraction,
 *     `scripts/reextract-published-graph.ts`);
 *   · `lib/graph/reextractWikilinkNotes.ts` — per selected note, before its
 *     stamp is cleared.
 *
 * With a column, also add `{ consentHeld: { not_equals: true } }` to
 * `staleDocumentsWhere` / `publishedDocumentsWhere` and `consent_held IS NOT
 * TRUE` to the two SQL selections in `reextractWikilinkNotes.ts`, so held rows
 * are not even counted. Until then the backfill's own guard is "published
 * only" (`publicationStatus = 'published'`), which already keeps every draft —
 * the workshop's included — out.
 *
 * ⚠ When wiring: fail CLOSED. A row whose mark cannot be read is held.
 */
export function isConsentHeld(_row: unknown): boolean {
  return false
}
