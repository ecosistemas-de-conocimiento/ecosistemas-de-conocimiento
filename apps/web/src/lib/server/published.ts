/**
 * Published testimonios a reviewer may reject after the fact (owner rule,
 * 2026-10-24: participants' contributions publish automatically, review is
 * occasional). Backend: `GET /api/published`, `POST /api/published/:id`
 * (`apps/backend/src/lib/rejectPublished.ts`). Same result shape as
 * `$lib/server/holds.ts`; a 404 is the backend's one refusal.
 */

import { safeErrMessage } from '$lib/errorSummary';
import { backendFetch } from '$lib/server/auth';
import type { HoldsResult } from '$lib/server/holds';

export interface PublishedSummary {
  id: string;
  /** Generated from redacted text, or a neutral label. Never the filename. */
  title: string;
  updatedAt: string | null;
}

export function parsePublishedList(raw: unknown): PublishedSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .filter((r) => typeof r.id === 'string' && typeof r.title === 'string')
    .map((r) => ({
      id: r.id as string,
      title: r.title as string,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
    }));
}

export async function listPublished(
  token: string | undefined,
  organizationId: string,
): Promise<HoldsResult<PublishedSummary[]>> {
  const qs = new URLSearchParams({ organization: organizationId });
  try {
    const res = await backendFetch(token, `/api/published?${qs.toString()}`, { method: 'GET' });
    if (res.status === 404 || res.status === 401) return { state: 'not-found' };
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json().catch(() => null)) as { items?: unknown } | null;
    return { state: 'ready', value: parsePublishedList(body?.items) };
  } catch (err) {
    console.warn('[published] could not list', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}

export async function rejectPublishedDoc(
  token: string | undefined,
  id: string,
  note?: string,
): Promise<HoldsResult<{ id: string }>> {
  try {
    const res = await backendFetch(token, `/api/published/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', ...(note ? { note } : {}) }),
    });
    if (res.status === 404 || res.status === 401) return { state: 'not-found' };
    if (!res.ok) return { state: 'unavailable' };
    return { state: 'ready', value: { id } };
  } catch (err) {
    console.warn('[published] could not reject', safeErrMessage(err));
    return { state: 'unavailable' };
  }
}
