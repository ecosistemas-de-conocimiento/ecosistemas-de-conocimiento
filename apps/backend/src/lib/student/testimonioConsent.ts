/**
 * 🔴 THE TESTIMONIO CONSENT IS VERSIONED (owner ruling Q20: a consent covers
 * only the wording the student was shown).
 *
 * The wording lives in ONE place, `apps/web/src/lib/consent.ts`
 * (`CONSENT_ACTIVITY_WITH_TESTIMONIOS`), next to the same version number. The
 * page sends the version it showed; `endpoints/estudiante.ts` refuses any
 * other and stores it in `student_profiles.share_testimonios_version`. Only a
 * consent on THIS version lets the report list testimonios
 * (`queries.ts` `testimoniosOf`, `estudiante.ts` `findProfile`).
 *
 * Versions:
 *   1  "…Mis docentes e investigadores también verán mis testimonios…".
 *      Never stored: those consents have `share_testimonios_version` NULL and
 *      no longer count (fail-closed). The student is asked again.
 *   2  2026-10-28: names every reader — the ecosistema's team (docentes,
 *      investigadores y responsables) and the platform's administration.
 *
 * ⚠ CHANGE THE WORDING → BUMP THE VERSION, here AND in `consent.ts`.
 * `testimonioConsent.test.ts` fails when the two numbers differ.
 */
export const TESTIMONIO_CONSENT_VERSION = 2

/** Is this stored consent on the current wording? */
export function isCurrentTestimonioConsent(row: { shareTestimoniosAt?: unknown; shareTestimoniosVersion?: unknown }): boolean {
  return (
    typeof row.shareTestimoniosAt === 'string' &&
    row.shareTestimoniosAt !== '' &&
    row.shareTestimoniosVersion === TESTIMONIO_CONSENT_VERSION
  )
}
