/**
 * The student's "share my activity" consent (`/estudiante`). ONE place for
 * the wording, so what the student agrees to and what the report shows
 * (`/seguimiento`, backend `endpoints/estudiante.ts`) are read side by side.
 */

/** `studentTestimonios` off (the default): documents only. */
export const CONSENT_ACTIVITY = 'Compartir mi actividad con el equipo del ecosistema';

/**
 * `studentTestimonios` on: a SEPARATE consent line (owner ruling Q20), shown
 * only while the switch is on. Accepting it records `shareTestimoniosAt` and
 * the {@link TESTIMONIO_CONSENT_VERSION} below; an activity consent given
 * without it does not show testimonios. It names every reader: the
 * ecosistema's responsables and investigadores, and every platform admin
 * (`canAdminOrg`) — owner, 2026-10-28.
 */
export const CONSENT_ACTIVITY_WITH_TESTIMONIOS =
  'Compartir mi actividad con el equipo del ecosistema. El equipo del ecosistema (docentes, investigadores y responsables) y la administración de la plataforma también verán mis testimonios publicados, solo en versión anonimizada.';

/**
 * 🔴 The version of {@link CONSENT_ACTIVITY_WITH_TESTIMONIOS}. The page sends
 * it when the student accepts; the backend refuses any other and counts only
 * consents on its own current version (owner ruling Q20: a consent covers only
 * the wording shown). CHANGE THE WORDING → BUMP THIS, and the backend's
 * `lib/student/testimonioConsent.ts` (its test compares the two).
 */
export const TESTIMONIO_CONSENT_VERSION = 2;

/** Shown when the backend refuses a consent given on an older wording (409). */
export const CONSENT_CHANGED = 'El texto del consentimiento cambió. Recarga la página y léelo de nuevo.';
