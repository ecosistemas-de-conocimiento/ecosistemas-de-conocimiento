// Callback-delivery metrics. EMIT SIDE ONLY — same contract as `./llm.ts` and
// `./pii.ts`: definitions plus never-throwing helpers, registered on the ONE
// registry `./registry.ts` exports (never the client by package name).
//
// WHY THESE EXIST. A `callback_deliveries` row that ends `dead_letter`,
// `failed` or `auth_failed` is a document the consumer was never told about.
// Before these, the only way to see one was `GET /v1/admin/callbacks`, which a
// human has to think of running. The three series below make that loss
// alertable, and the sweeper timestamp makes a DEAD sweeper distinguishable
// from an idle one (the defect `fix/sweeper-logger` documented).
//
// ⚠ LABEL CARDINALITY. `status` is the five-value delivery enum, `event` is the
// fixed contract event list, `project` is bounded by the API_KEYS map. No
// delivery id, no org-supplied text.

import { client, reuse } from './registry.js';

const { Counter, Gauge } = client;

/** The five `callback_delivery_status` enum values (db/schema). */
export const CALLBACK_DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'failed',
  'auth_failed',
  'dead_letter',
] as const;
export type CallbackDeliveryStatus = (typeof CALLBACK_DELIVERY_STATUSES)[number];

/** The statuses that mean "the consumer was not told". The dead-letter queue. */
export const DLQ_STATUSES: readonly CallbackDeliveryStatus[] = [
  'dead_letter',
  'failed',
  'auth_failed',
];

export const CALLBACK_TRANSITIONS_METRIC = 'aiservice_callback_delivery_transitions_total';
export const CALLBACK_DELIVERIES_METRIC = 'aiservice_callback_deliveries';
export const CALLBACK_SWEEPER_LAST_RUN_METRIC = 'aiservice_callback_sweeper_last_run_timestamp_seconds';
export const CALLBACK_EMIT_SKIPPED_METRIC = 'aiservice_callback_emit_skipped_total';

/** Every transition of a delivery row into a terminal status. */
export const callbackTransitionsTotal = reuse(
  CALLBACK_TRANSITIONS_METRIC,
  () =>
    new Counter({
      name: CALLBACK_TRANSITIONS_METRIC,
      help: 'Callback delivery rows entering a terminal status, by status, event and project.',
      labelNames: ['status', 'event', 'project'] as const,
    }),
);

/** Rows per status in `callback_deliveries`, refreshed by each sweeper tick. */
export const callbackDeliveriesGauge = reuse(
  CALLBACK_DELIVERIES_METRIC,
  () =>
    new Gauge({
      name: CALLBACK_DELIVERIES_METRIC,
      help: 'callback_deliveries rows by status, as counted by the last successful sweeper tick.',
      labelNames: ['status'] as const,
    }),
);

/** Unix seconds of the last sweep that completed without throwing. */
export const callbackSweeperLastRun = reuse(
  CALLBACK_SWEEPER_LAST_RUN_METRIC,
  () =>
    new Gauge({
      name: CALLBACK_SWEEPER_LAST_RUN_METRIC,
      help: 'Unix time of the last callback sweeper tick that completed. Stale = sweeper dead or failing.',
    }),
);

/**
 * A callback that should have been emitted and was not, because its source
 * row was missing (plan A6). Not a delivery transition: no row ever existed.
 */
export const callbackEmitSkippedTotal = reuse(
  CALLBACK_EMIT_SKIPPED_METRIC,
  () =>
    new Counter({
      name: CALLBACK_EMIT_SKIPPED_METRIC,
      help: 'Callbacks not emitted because their source bookkeeping row was missing, by reason.',
      labelNames: ['reason'] as const,
    }),
);

/** Never throws: a metrics fault must not fail a delivery write. */
export function recordCallbackTransition(
  status: CallbackDeliveryStatus,
  event: string,
  project: string | null | undefined,
): void {
  try {
    callbackTransitionsTotal.inc({ status, event, project: project ?? '' });
  } catch {
    // See the doc comment.
  }
}

/** Set the per-status gauge from a `status → count` map; absent statuses read 0. */
export function setCallbackDeliveryCounts(counts: Readonly<Partial<Record<string, number>>>): void {
  try {
    for (const status of CALLBACK_DELIVERY_STATUSES) {
      callbackDeliveriesGauge.set({ status }, counts[status] ?? 0);
    }
  } catch {
    // See `recordCallbackTransition`.
  }
}

export function markSweeperRun(now: Date): void {
  try {
    callbackSweeperLastRun.set(now.getTime() / 1000);
  } catch {
    // See `recordCallbackTransition`.
  }
}

export function recordCallbackEmitSkipped(reason: string): void {
  try {
    callbackEmitSkippedTotal.inc({ reason });
  } catch {
    // See `recordCallbackTransition`.
  }
}
