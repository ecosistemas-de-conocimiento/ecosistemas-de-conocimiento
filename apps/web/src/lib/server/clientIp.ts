// The browser's IP, forwarded to the backend so its per-IP limits see one
// bucket per browser instead of one for the whole web (audit 2026-11-10, A-08).
//
// Chain on dev and staging (inferred from `infra/docker-compose.yml` and
// `infra/fleet/env-manifests.md`, not measured on the box): browser → Traefik →
// web → `http://backend:3002` on the compose network. Traefik puts the address
// it saw at the RIGHT of `X-Forwarded-For`; whatever a client pre-seeded sits
// to its left. So the rightmost entry is the one to trust — exactly one proxy,
// the same count the backend's `IDENTITY_TRUSTED_PROXY_HOPS` and ai-service use.
// With no header (a bare local `pnpm dev`), the socket peer is the browser.
//
// The web then sends the backend ONE entry. The backend reads the rightmost
// entry too, so it gets this one; a caller on the public `api.*` host goes
// through Traefik, which appends, and cannot choose its bucket either.
//
// ⚠ Like the backend, this trusts the header because the container is
// reachable only through Traefik (`expose`, no published port). A caller that
// could reach the web directly could pick its own bucket.

import { getRequestEvent } from '$app/server';
import type { RequestEvent } from '@sveltejs/kit';

/** The browser's IP for this request, or null when it cannot be told. */
export function clientIpOf(event: Pick<RequestEvent, 'request' | 'getClientAddress'>): string | null {
  const forwarded = event.request.headers.get('x-forwarded-for');
  const last = forwarded
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .at(-1);
  if (last) return last;
  try {
    return event.getClientAddress() || null;
  } catch {
    return null;
  }
}

/** The IP of the request being served, or null outside one (tests, boot). */
export function currentClientIp(): string | null {
  try {
    return clientIpOf(getRequestEvent());
  } catch {
    return null;
  }
}

/** Set `X-Forwarded-For` on a backend call, when there is a browser to name. */
export function forwardClientIp(headers: Headers): Headers {
  const ip = currentClientIp();
  if (ip) headers.set('X-Forwarded-For', ip);
  return headers;
}
