/**
 * Server half of `/documentos/[id]/anonimizacion`: the two calls to the
 * backend's `GET|PATCH /api/documents/:id/anonimizacion`, with the caller's JWT.
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

export type SaveResult = { ok: true; view: AnonView | null; regate: Regate | null } | { ok: false; status: number };

export async function saveAnonimizacion(token: string | undefined, id: string, body: PatchBody): Promise<SaveResult> {
  try {
    const res = await backendFetch(token, path(id), { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, status: res.status };
    const raw = (await res.json().catch(() => null)) as { regate?: unknown } | null;
    return { ok: true, view: parseView(raw), regate: parseRegate(raw?.regate) };
  } catch {
    return { ok: false, status: 502 };
  }
}
