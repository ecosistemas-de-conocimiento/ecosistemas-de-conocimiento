/**
 * `/documentos/[id]/constancia` — the printable record of the upload consent
 * (contract §5: backend `GET /api/documents/:id/constancia`).
 *
 * 🔴 THE CONTROL IS THE BACKEND. It answers 404 to anyone but the uploader and
 * platform admin, and nulls `document.title` for whoever may not read the
 * original; this load passes that through and never re-derives it.
 */

import { error } from '@sveltejs/kit';

import { backendFetch } from '$lib/server/auth';
import { notFound } from '$lib/server/deny';
import type { UploadConsentKind } from '$lib/uploadConsent';
import type { PageServerLoad } from './$types';

export interface ConstanciaReceipt {
  id: number;
  folio: string;
  consentVersion: number;
  contentKind: UploadConsentKind;
  acceptedAt: string;
  ecosystem: { id: number; name: string } | null;
}

export interface ConstanciaDocument {
  kind: string;
  contentKind: UploadConsentKind;
  createdAt: string;
  title: string | null;
}

export interface Constancia {
  documentId: number;
  receipt: ConstanciaReceipt | null;
  document: ConstanciaDocument | null;
}

const KINDS: readonly string[] = ['documento', 'testimonio', 'conversacion'];
const kindOf = (raw: unknown): UploadConsentKind =>
  (typeof raw === 'string' && KINDS.includes(raw) ? raw : 'documento') as UploadConsentKind;
const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '');
const obj = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;

/** Shape the backend body; anything unexpected is dropped, not trusted. (`_`: SvelteKit only allows `_`-prefixed extra exports here.) */
export function _parseConstancia(raw: unknown): Constancia | null {
  const body = obj(raw);
  if (!body || typeof body.documentId !== 'number') return null;
  const r = obj(body.receipt);
  const d = obj(body.document);
  const eco = obj(r?.ecosystem);
  return {
    documentId: body.documentId,
    receipt:
      r && typeof r.folio === 'string'
        ? {
            id: Number(r.id),
            folio: r.folio,
            consentVersion: Number(r.consentVersion),
            contentKind: kindOf(r.contentKind),
            acceptedAt: str(r.acceptedAt),
            ecosystem: eco ? { id: Number(eco.id), name: str(eco.name) } : null,
          }
        : null,
    document: d
      ? {
          kind: str(d.kind),
          contentKind: kindOf(d.contentKind),
          createdAt: str(d.createdAt),
          title: typeof d.title === 'string' && d.title !== '' ? d.title : null,
        }
      : null,
  };
}

const UNAVAILABLE = 'No se pudo leer la constancia. Inténtalo de nuevo.';
const gone = (): never => notFound({ entity: 'document', module: 'constancia', cta: { label: 'Volver', href: '/documentos' } });

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) gone();
  const id = String(params.id ?? '');
  let res: Response;
  try {
    res = await backendFetch(locals.token, `/api/documents/${encodeURIComponent(id)}/constancia`, { method: 'GET' });
  } catch {
    throw error(502, UNAVAILABLE);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) gone();
  if (!res.ok) throw error(502, UNAVAILABLE);
  const constancia = _parseConstancia(await res.json().catch(() => null));
  if (!constancia) throw error(502, UNAVAILABLE);
  return { constancia };
};
