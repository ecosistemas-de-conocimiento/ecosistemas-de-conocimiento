/**
 * 🔴 The per-resource upload consent (Etapa 1 correction, 2026-11-12). ONE
 * place for the wording and its version, so what the uploader ticks (the
 * five entry points) and what the constancia reproduces
 * (`/documentos/[id]/constancia`) are read side by side.
 *
 * It records that THE PERSON UPLOADING declared, on this version of the text,
 * that the material may be treated as the privacy notice describes (and, for
 * a testimonio, that the speaker gave informed consent outside the system).
 * It never records whose words they are (ADR-0019).
 *
 * CHANGE THE WORDING → BUMP {@link UPLOAD_CONSENT_VERSION}, and the backend's
 * `apps/backend/src/lib/uploadConsent.ts` (its test compares the two).
 */
export const UPLOAD_CONSENT_VERSION = 1;

/** Where the checkbox's link points. Public route. */
export const PRIVACY_PATH = '/privacidad';

/** What the material is; mirrors the backend's `documents.contentKind`. */
export type UploadConsentKind = 'documento' | 'testimonio' | 'conversacion';

/** The checkbox line, split around its link so the UI can render the link. */
export interface ConsentLine {
  before: string;
  link: string;
  after: string;
}

const LINES: Record<number, { documento: ConsentLine; testimonio: ConsentLine }> = {
  1: {
    documento: {
      before: 'Leí el ',
      link: 'aviso de privacidad',
      after: ' y acepto que este material se trate como ahí se describe.',
    },
    testimonio: {
      before: 'Leí el ',
      link: 'aviso de privacidad',
      after: ' y la persona que da este testimonio dio su consentimiento informado.',
    },
  },
};

/** The checkbox line for a kind; `conversacion` uses the `documento` text. */
export function uploadConsentLine(
  kind: UploadConsentKind,
  version: number = UPLOAD_CONSENT_VERSION,
): ConsentLine | null {
  const v = LINES[version];
  if (!v) return null;
  return kind === 'testimonio' ? v.testimonio : v.documento;
}

/** The same line as plain text (constancia, tests). */
export function uploadConsentText(
  kind: UploadConsentKind,
  version: number = UPLOAD_CONSENT_VERSION,
): string | null {
  const l = uploadConsentLine(kind, version);
  return l ? `${l.before}${l.link}${l.after}` : null;
}
