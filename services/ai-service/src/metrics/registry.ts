// THE ONE PROMETHEUS REGISTRY. Everything that counts anything in this service
// registers here, and `GET /metrics` (src/routes/metrics.ts) serves exactly
// this registry's output.
//
// 🔴 IMPORT THE CLIENT FROM THIS MODULE, NEVER FROM A PACKAGE NAME.
//
// A prometheus client keeps its "default registry" as module state, so TWO
// copies of the library in one process means TWO default registries — and a
// counter registered on the one nobody serves is invisible, with no error and
// no missing metric to notice. There are three interchangeable-looking
// packages in the wild right now:
//
//   prom-client              — DEPRECATED by its author ("has been replaced by
//                              @prometheus-io/client"); still the name most
//                              snippets and most of an LLM's memory reach for.
//   @prometheus-io/client    — the same codebase, donated to the Prometheus
//                              org (github.com/prometheus/client_js). THIS ONE.
//   @platformatic/prom-client— a third-party performance fork; `fastify-metrics`
//                              picks it up automatically IF it is installed,
//                              which is a good reason never to install it here
//                              by accident.
//
// `server.ts` passes the client below to `fastify-metrics` EXPLICITLY (its
// `promClient` option) rather than letting the plugin resolve its own, so the
// route histogram, the default process metrics and every counter this codebase
// declares land on one registry that cannot drift apart from the one served.
//
// If you arrived here because `import ... from 'prom-client'` failed to
// resolve: that is this comment working. Import from here instead.

import client from '@prometheus-io/client';

export { client };

/** The registry `GET /metrics` serves. */
export const registry = client.register;

/**
 * 🔴 THIS MODULE MUST SURVIVE BEING EVALUATED MORE THAN ONCE IN ONE PROCESS.
 *
 * A prometheus registry THROWS on a duplicate metric name, and vitest makes
 * that a certainty rather than a hypothetical: it re-executes SOURCE modules
 * for every test file, while `node_modules` dependencies are externalized and
 * loaded once per worker. So `client` — and therefore `client.register` — is a
 * singleton shared across ~109 test files, each of which re-runs the
 * declarations below. Measured before this guard existed: 13 tests in 3
 * unrelated files died on `A metric with the name
 * process_cpu_user_seconds_total has already been registered`.
 *
 * `reuse` returns whatever is already on the registry under that name, so a
 * second evaluation adopts the first one's metric (and its accumulated values)
 * instead of colliding. In production this module is evaluated once and every
 * lookup below misses.
 */
export function reuse<T>(name: string, create: () => T): T {
  return (registry.getSingleMetric(name) as T | undefined) ?? create();
}

/**
 * Node/process defaults (CPU, RSS, heap, event-loop lag, GC).
 *
 * There is no metric object to hand back here, so the guard is a sentinel: one
 * of the names `collectDefaultMetrics` itself registers. Present ⇒ the
 * collectors are already installed on this registry.
 */
const DEFAULT_METRICS_SENTINEL = 'process_cpu_user_seconds_total';
if (!registry.getSingleMetric(DEFAULT_METRICS_SENTINEL)) {
  client.collectDefaultMetrics({ register: registry });
}

/** Name of the BullMQ stall counter below. */
export const BULLMQ_STALLED_METRIC = 'ai_bullmq_stalled_total';

/**
 * BullMQ handed the same job to a second worker because the first stopped
 * renewing its lock.
 *
 * This is the counter for the failure mode `src/queue/queues.ts` documents at
 * length: a stall is the first externally visible sign that a worker is wedged
 * or gone. The log line already existed; it is only readable by a human who is
 * already looking. A counter is what an alert can watch.
 *
 * Declared here rather than in `queues.ts` so that module keeps its single
 * metrics touchpoint — one `inc()` inside `attachWorkerLifecycleLogging`.
 *
 * `queue` is the worker LABEL passed to `attachWorkerLifecycleLogging`
 * ("generation", "ingest"), i.e. bounded by the number of workers in the
 * image — never a job id, never a tenant. Cardinality is a metric's cost.
 */
export const bullmqStalledTotal = reuse(
  BULLMQ_STALLED_METRIC,
  () =>
    new client.Counter({
      name: BULLMQ_STALLED_METRIC,
      help: 'BullMQ jobs re-delivered after their worker lock expired, by queue.',
      labelNames: ['queue'] as const,
      registers: [registry],
    }),
);

/**
 * The metrics `fastify-metrics` declares for itself (its default names).
 * Named here because `server.ts` has to drop the previous instances before
 * re-registering the plugin — see the note there.
 *
 * Both, not just the histogram: the plugin CONSTRUCTS the summary even with
 * `routeMetrics.enabled.summary === false` (it only skips observing it), so a
 * second registration collides on that name first.
 */
export const FASTIFY_METRICS_METRICS = [
  'http_request_duration_seconds',
  'http_request_summary_seconds',
] as const;
