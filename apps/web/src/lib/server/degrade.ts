// Degradable backend reads (Part 1 of the FE error-hardening mechanism).
//
// This app is a client-hydrated SPA: the browser fetches lists from the
// SvelteKit `/api/**` server routes, which proxy Payload via `backendFetch`.
// The bug class this prevents, seen in production before: an org-scoped read
// returns a 403 when the tenant simply has ZERO rows, and that 403 bubbles up
// as a hard failure. For a "should just be empty / temporarily unavailable"
// list, that's the wrong outcome — we want to degrade to an empty list with an
// observable signal, not blow up.
//
// `degradeListResponse` takes the upstream `Response` from a Payload list read
// and the already-parsed body, and returns the JSON the route should hand
// back to the browser:
//
//   - 401  → caller should pass through as a real 401. The browser's session
//            layer (hooks.server.ts) turns that into a /sign-in redirect on
//            navigations; we never degrade a genuine session expiry. This
//            helper signals that via `kind: 'unauthorized'`.
//   - 403  → degrade: return the empty-list fallback with `degraded: true` +
//            `reason: 'forbidden'`, and `console.warn` so a REAL authz
//            regression stays visible in logs (we do NOT blanket-swallow).
//   - 404 / 5xx / other 4xx → degrade with `reason: 'unavailable'`.
//   - ok   → pass the body straight through.
//
// Payload list bodies are shaped `{ docs: [...], totalDocs, ... }`. The
// degraded fallback mirrors that with `docs: []` so the client store's
// existing `data.docs ?? []` mapping keeps working unchanged.

export type DegradeReason = 'forbidden' | 'unavailable';

export interface DegradeResult {
  /** What the route should do with this upstream response. */
  kind: 'ok' | 'degraded' | 'unauthorized';
  /** HTTP status the route should respond with. */
  status: number;
  /** JSON body the route should return. For degraded reads this is the
   *  empty-list fallback annotated with `degraded`/`reason`. */
  body: Record<string, unknown>;
  reason?: DegradeReason;
}

/**
 * Decide how to surface a Payload list-read response to the browser.
 *
 * @param res     the upstream `Response` from `backendFetch`.
 * @param body    the already-parsed JSON body (or `{}` on parse failure).
 * @param ctx     a short label for logs (e.g. 'sessions', 'messages').
 */
export function degradeListResponse(
  res: Response,
  body: unknown,
  ctx: string,
): DegradeResult {
  if (res.ok) {
    return {
      kind: 'ok',
      status: res.status,
      body: (body && typeof body === 'object' ? body : { docs: [] }) as Record<string, unknown>,
    };
  }

  // Genuine session expiry — never degraded. Caller passes the 401 through so
  // the browser's session layer can redirect to /sign-in.
  if (res.status === 401) {
    return { kind: 'unauthorized', status: 401, body: { error: 'unauthorized' } };
  }

  const why: DegradeReason = res.status === 403 ? 'forbidden' : 'unavailable';

  // Keep the signal: a 403 here is usually "empty tenant", but it can also be a
  // real authz regression — warn so it stays observable in logs rather than
  // silently swallowed.
  console.warn(
    `[degrade] ${ctx}: backend returned ${res.status}; degrading to empty list (reason=${why})`,
  );

  return {
    kind: 'degraded',
    // Respond 200 so the browser treats it as a successful (empty) read; the
    // `degraded` flag drives the non-fatal banner.
    status: 200,
    body: { docs: [], totalDocs: 0, degraded: true, reason: why },
    reason: why,
  };
}
