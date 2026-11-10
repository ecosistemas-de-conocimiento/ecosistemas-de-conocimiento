/**
 * Server read of `GET /api/lenguas` — the languages an ecosistema's published
 * documentos are about. See `$lib/lengua.ts` for the rules and
 * `apps/backend/src/endpoints/lenguas.ts` for why this is a route of its own
 * (`where[lengua]` is refused over REST, by design).
 *
 * ⚠ The organization id must come from `resolveEcosystem` or from the session
 * row, never from the browser. The backend re-checks membership anyway.
 */

import { safeErrMessage } from '$lib/errorSummary';
import { backendFetch } from '$lib/server/auth';
import { EMPTY_LENGUA_INDEX, parseLenguaIndex, type LenguaIndex } from '$lib/lengua';

export interface LenguaIndexResult {
  /** `false` ⇒ the read failed. Not the same as "no documento records a lengua". */
  ok: boolean;
  index: LenguaIndex;
}

export async function fetchLenguaIndex(
  token: string | undefined,
  organizationId: string | number,
): Promise<LenguaIndexResult> {
  try {
    const qs = new URLSearchParams({ organization: String(organizationId) });
    const res = await backendFetch(token, `/api/lenguas?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[lenguas] backend answered ${res.status}`);
      return { ok: false, index: EMPTY_LENGUA_INDEX };
    }
    return { ok: true, index: parseLenguaIndex(await res.json().catch(() => null)) };
  } catch (err) {
    console.warn('[lenguas] read failed', safeErrMessage(err));
    return { ok: false, index: EMPTY_LENGUA_INDEX };
  }
}
