/**
 * What an upload IS — a `documento` or a Voz (`testimonio`) — and who may say so.
 *
 * Pure and client-safe, so the upload route, the layout load and `DocsPanel`
 * share one copy and vitest can assert it (this repo has no DOM tests).
 *
 * ── 🔴 WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The backend gates a testimonio through anonymisation before it reaches any
 * corpus, and refuses `contentKind: 'testimonio'` from anyone without
 * `voces:upload` in that ecosistema (`enforceVocesUploadRights` in
 * `apps/backend/src/collections/Documents.ts`). But the upload route never SENT
 * `contentKind`, so every upload from the UI landed as a `documento` and the
 * gate never ran on one. Found by the 2026-10-17 audit.
 *
 * ⚠ THE CHOICE IS PRESENTATION; THE BACKEND IS THE CONTROL. A caller without
 * the permission who forges the form field gets a 400 from the backend.
 */

/** The content kinds an upload form may name. `conversacion` never comes from a form. */
export const UPLOAD_CONTENT_KINDS = ['documento', 'testimonio'] as const;
export type UploadContentKind = (typeof UPLOAD_CONTENT_KINDS)[number];

/** Mirrors `PERMISSIONS.vocesUpload` in the backend. */
export const VOCES_UPLOAD = 'voces:upload';

/**
 * Read the form field. Absent or empty ⇒ `documento` (the backend default).
 * Anything else that is not a known kind ⇒ `null`, which the route refuses.
 */
export function parseUploadContentKind(raw: unknown): UploadContentKind | null {
  if (raw === null || raw === undefined || raw === '') return 'documento';
  return typeof raw === 'string' && (UPLOAD_CONTENT_KINDS as readonly string[]).includes(raw)
    ? (raw as UploadContentKind)
    : null;
}

/** The shape `$lib/server/holds.ts` `ReviewCapability` has. Kept structural. */
export interface PermissionGrant {
  isPlatformAdmin: boolean;
  slugs: string[];
  ok: boolean;
}

/**
 * May this person file a Voz in the ecosistema with this slug?
 *
 * ⚠ Per ecosistema: `voces:upload` is held IN an organization. Fails closed on
 * a failed identity read, a missing slug, or a missing grant.
 */
export function mayUploadVoces(
  grant: PermissionGrant | null | undefined,
  slug: string | null | undefined,
): boolean {
  if (!grant || !grant.ok) return false;
  if (grant.isPlatformAdmin) return true;
  if (!slug) return false;
  return grant.slugs.includes(slug);
}

/** May they file one ANYWHERE? The route's cheap pre-check before the file goes up. */
export function mayUploadVocesAnywhere(grant: PermissionGrant | null | undefined): boolean {
  return Boolean(grant?.ok && (grant.isPlatformAdmin || grant.slugs.length > 0));
}

/** Copy for the choice in `DocsPanel`. */
export const UPLOAD_KIND_LABELS: Record<UploadContentKind, string> = {
  documento: 'Documento',
  testimonio: 'Voz / testimonio',
};

export const UPLOAD_KIND_HINT =
  'Una voz es el testimonio de otra persona. Siempre es anónima: pasa por la anonimización antes de entrar al corpus, y las demás personas del ecosistema no verán el archivo original ni su nombre.';
