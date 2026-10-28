/**
 * The student's "share my activity" consent (`/estudiante`). ONE place for
 * the wording, so what the student agrees to and what the report shows
 * (`/seguimiento`, backend `endpoints/estudiante.ts`) are read side by side.
 */

/** `studentTestimonios` off (the default): documents only. */
export const CONSENT_ACTIVITY = 'Compartir mi actividad con el equipo del ecosistema';

/**
 * `studentTestimonios` on: the teacher's report also shows the student's
 * testimonios, anonymised (redacted text and a neutral title, never the
 * original or the file name).
 *
 * TODO-for-owner (Rodrigo): proposed wording, NOT approved. Not legal text —
 * confirm or replace before switching `studentTestimonios` on anywhere.
 */
export const CONSENT_ACTIVITY_WITH_TESTIMONIOS =
  'Compartir mi actividad con el equipo del ecosistema. Mis docentes e investigadores también verán mis testimonios, solo en versión anonimizada.';

export const consentActivityLabel = (testimoniosEnReporte: boolean | undefined): string =>
  testimoniosEnReporte === true ? CONSENT_ACTIVITY_WITH_TESTIMONIOS : CONSENT_ACTIVITY;
