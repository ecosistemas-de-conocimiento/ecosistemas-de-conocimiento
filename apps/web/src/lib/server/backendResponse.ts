// Passing a backend status through to the browser, with what a 429 needs.
//
// The routes under `/api/**` hand a backend error status straight on
// (`json(body, { status: res.status })`). On a 429 that dropped the backend's
// `Retry-After`, so the browser saw "too many requests" with no wait to honour
// (backend POST /api/sessions limits session creation, for one). The login
// route builds its own `Retry-After` from `signIn`; it does not use this.

import { json } from '@sveltejs/kit';
import { isUnsafeText } from '$lib/errorSummary';

/**
 * The headers a passed-through backend status needs: on a 429, the backend's
 * `Retry-After` (when it sent one) and `Cache-Control: no-store`, so no cache
 * keeps the refusal. Nothing on any other status.
 */
export function rateLimitHeaders(res: Response): Record<string, string> {
  if (res.status !== 429) return {};
  const retryAfter = res.headers.get('Retry-After');
  // Lower case, so a caller's own `cache-control` key merges instead of doubling.
  return { 'cache-control': 'no-store', ...(retryAfter ? { 'retry-after': retryAfter } : {}) };
}

/** `json(body)` with the backend response's status, and its 429 headers. */
export function backendJson(body: unknown, res: Response): Response {
  return json(body, { status: res.status, headers: rateLimitHeaders(res) });
}

/**
 * What of a backend error body may go on to the browser as `detail`: Payload's
 * own `errors[].message` on a 4xx (a validation error names the field, a hook
 * writes its refusal for the user), and nothing else.
 *
 * ⚠ Never the raw body. A 5xx, a body that is not Payload's JSON or a message
 * in drizzle's shape can quote a row; `data` can echo the values sent.
 */
export function backendErrorDetail(status: number, raw: string, max = 300): string {
  if (status < 400 || status >= 500) return '';
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return '';
  }
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return '';
  const messages = errors
    .map((e) => (e as { message?: unknown } | null)?.message)
    .filter((m): m is string => typeof m === 'string' && m !== '' && !isUnsafeText(m));
  return messages.join('; ').slice(0, max);
}
