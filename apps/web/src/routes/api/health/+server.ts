import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// LIVENESS — "is this process alive?"
//
// 🔴 Checks NOTHING, and must keep checking nothing. A constant response that
// is 200 for as long as the process can serve a request.
//
// Two reasons this route exists in exactly this shape
// (health-check contract, Rule 2):
//
//  1. It is what a restart policy consumes. A dependency check here converts a
//     the backend blip into a restart CRASH-LOOP — strictly worse than the
//     outage it was reacting to, and much harder to diagnose.
//  2. Its ABSENCE was itself a defect. With no route here, apps/web's auth hook
//     caught the unmatched `/api/*` path and answered 401, so a monitor read
//     route-absence as an auth failure — a permanent false negative that no
//     amount of fixing auth would ever clear.
//
// Readiness — "can this service do its job?" — is the sibling route at
// `/api/health/ready`. Point monitors there, not here.
export const GET: RequestHandler = () =>
  json(
    { status: 'ok', service: 'chat' },
    // Never let a proxy or CDN serve a cached liveness answer for a process
    // that has since died.
    { headers: { 'cache-control': 'no-store' } },
  );
