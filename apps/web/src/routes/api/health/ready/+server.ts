import { json } from '@sveltejs/kit';
import { getReadiness } from '$lib/server/health';
import type { RequestHandler } from './$types';

// READINESS — "can this service do its job?"
//
// A frontend has no dependencies of its own, so its readiness is "can I reach
// my backend". We proxy one level down to the backend's own readiness route
// and surface its checks, sanitised.
//
// 🔴 Two states only: `ok`/200 or `down`/503. There is NO `degraded`
// (health-check-contract.md Rule 1).
//
// ⚠ Monitors: assert on `"status":"ok"`, never on a specific check name — the
// check names differ per service. Also treat a populated
// `error` field as a signal even when `status` is `ok`; Rule 4c's two-strike
// tolerance means the first failure is reported but not yet fatal.
//
// ⚠ Do NOT wire this route to a restart policy or to load-balancer rotation.
// Under Rule 1 a backend blip marks chat down, which is the honest answer for
// a MONITOR and a cascading-failure generator for an ORCHESTRATOR. Liveness
// (`/api/health`) is the route a restart policy may consume.
//
// All probing, caching, two-strike tolerance and — critically — redaction live
// in `$lib/server/health`.
export const GET: RequestHandler = async () => {
  const report = await getReadiness();
  return json(report, {
    status: report.status === 'ok' ? 200 : 503,
    // A cached 200 here would let an intermediary report a dead service as
    // healthy; the module already rate-limits real probes to one per 5s.
    headers: { 'cache-control': 'no-store' },
  });
};
