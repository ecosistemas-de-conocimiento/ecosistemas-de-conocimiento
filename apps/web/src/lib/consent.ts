/**
 * The student's "share my activity" consent (`/estudiante`). ONE place for
 * the wording, so what the student agrees to and what the report shows
 * (`/seguimiento`, backend `endpoints/estudiante.ts`) are read side by side.
 */

/** `studentTestimonios` off (the default): documents only. */
export const CONSENT_ACTIVITY = 'Compartir mi actividad con el equipo del ecosistema';

/**
 * `studentTestimonios` on: a SEPARATE consent line (owner ruling Q20), shown
 * only while the switch is on. Accepting it records `shareTestimoniosAt`; an
 * activity consent given without it does not show testimonios. Wording
 * approved by the owner (ruling Q19).
 *
 * ⚠ Readers in fact: the ecosistema's responsable(s), its investigadores and
 * every platform admin (`canAdminOrg`), not only "docentes e investigadores".
 */
export const CONSENT_ACTIVITY_WITH_TESTIMONIOS =
  'Compartir mi actividad con el equipo del ecosistema. Mis docentes e investigadores también verán mis testimonios, solo en versión anonimizada.';
