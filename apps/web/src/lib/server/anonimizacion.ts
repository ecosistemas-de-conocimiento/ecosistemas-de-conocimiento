/**
 * Server half of `/documentos/[id]/anonimizacion`: the calls to the backend's
 * `GET|PATCH /api/documents/:id/anonimizacion` and
 * `POST /api/documents/:id/anonimizacion/reintentar`, with the caller's JWT.
 *
 * ⚠ The backend decides who may read or change this (uploader, `holds:review`
 * in the document's ecosistema, platform admin). Nothing here re-derives it.
 */

import { backendFetch } from '$lib/server/auth';
import { parseRegate, parseView, type AnonView, type PatchBody, type Regate } from '$lib/anonimizacion';

const path = (id: string) => `/api/documents/${encodeURIComponent(id)}/anonimizacion`;

export type ReadResult =
  | { state: 'ready'; view: AnonView }
  | { state: 'forbidden' }
  | { state: 'not-found' }
  | { state: 'unavailable' };

export async function readAnonimizacion(token: string | undefined, id: string): Promise<ReadResult> {
  try {
    const res = await backendFetch(token, path(id), { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { state: 'forbidden' };
    if (res.status === 404) return { state: 'not-found' };
    if (!res.ok) return { state: 'unavailable' };
    const view = parseView(await res.json().catch(() => null));
    return view ? { state: 'ready', view } : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

/** `message`: the backend's `errors[0].message`, when it sent one. */
export type SaveResult =
  | { ok: true; view: AnonView | null; regate: Regate | null }
  | { ok: false; status: number; message: string | null };

async function send(token: string | undefined, url: string, init: RequestInit): Promise<SaveResult> {
  try {
    const res = await backendFetch(token, url, init);
    const raw = (await res.json().catch(() => null)) as { regate?: unknown; errors?: Array<{ message?: unknown }> } | null;
    if (!res.ok) {
      const message = raw?.errors?.[0]?.message;
      return { ok: false, status: res.status, message: typeof message === 'string' ? message : null };
    }
    return { ok: true, view: parseView(raw), regate: parseRegate(raw?.regate) };
  } catch {
    return { ok: false, status: 502, message: null };
  }
}

export const saveAnonimizacion = (token: string | undefined, id: string, body: PatchBody): Promise<SaveResult> =>
  send(token, path(id), { method: 'PATCH', body: JSON.stringify(body) });

/** Re-run a pending re-check, whatever the switches' origin (I-04). */
export const retryAnonimizacion = (token: string | undefined, id: string): Promise<SaveResult> =>
  send(token, `${path(id)}/reintentar`, { method: 'POST' });
