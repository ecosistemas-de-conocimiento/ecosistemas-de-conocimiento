/**
 * The I/O half of the Miembros screen: thin calls to the backend's
 * `/api/miembros`, which owns every authorization rule (see its header in
 * `apps/backend/src/endpoints/miembros.ts`). This file decides nothing.
 */

import { backendFetch } from '$lib/server/auth';
import { parseMembers, type Member } from '$lib/miembros';

export const MEMBERS_MANAGE = 'members:manage';

export type MembersResult =
  | { state: 'ready'; myRole: string; members: Member[] }
  | { state: 'forbidden' }
  | { state: 'unavailable' };

export type WriteResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

const GENERIC = 'No se pudo guardar.';

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: unknown }> } | null;
  const message = body?.errors?.[0]?.message;
  return typeof message === 'string' && message ? message : GENERIC;
}

export async function listMembers(token: string | undefined, organizationId: string): Promise<MembersResult> {
  try {
    const qs = new URLSearchParams({ organization: organizationId });
    const res = await backendFetch(token, `/api/miembros?${qs.toString()}`, { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { state: 'forbidden' };
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json().catch(() => null)) as { myRole?: unknown; members?: unknown } | null;
    return {
      state: 'ready',
      myRole: typeof body?.myRole === 'string' ? body.myRole : '',
      members: parseMembers(body?.members),
    };
  } catch (err) {
    console.warn('[miembros] could not list members', err);
    return { state: 'unavailable' };
  }
}

async function write<T>(
  token: string | undefined,
  path: string,
  init: RequestInit,
  pick: (body: Record<string, unknown>) => T,
): Promise<WriteResult<T>> {
  try {
    const res = await backendFetch(token, path, init);
    if (!res.ok) return { ok: false, status: res.status, message: await errorMessage(res) };
    const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { ok: true, value: pick(body) };
  } catch (err) {
    console.warn('[miembros] write failed', err);
    return { ok: false, status: 503, message: GENERIC };
  }
}

export interface Added {
  email: string;
  /**
   * Always present: the backend answers known and unknown emails alike, so
   * this works only if the person had no account. Shown once, never stored.
   */
  temporaryPassword: string | null;
}

export function addMember(
  token: string | undefined,
  input: { organization: string; email: string; name: string; role: string },
): Promise<WriteResult<Added>> {
  return write(
    token,
    '/api/miembros',
    { method: 'POST', body: JSON.stringify(input) },
    (body) => ({
      email: String((body.member as { email?: unknown } | undefined)?.email ?? input.email),
      temporaryPassword: typeof body.temporaryPassword === 'string' ? body.temporaryPassword : null,
    }),
  );
}

export function changeRole(token: string | undefined, id: string, role: string): Promise<WriteResult<null>> {
  return write(
    token,
    `/api/miembros/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({ role }) },
    () => null,
  );
}

export function removeMember(token: string | undefined, id: string): Promise<WriteResult<null>> {
  return write(token, `/api/miembros/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => null);
}
