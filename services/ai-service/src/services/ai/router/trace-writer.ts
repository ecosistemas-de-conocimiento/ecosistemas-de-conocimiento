// Persist trace + usage rows for each router call.
//
// Ported from a prototype's `services/ai/router/trace-writer.ts`. Writes go directly
// through Drizzle into the ai-service's own `traces` / `usage_logs` tables
// (a prototype wrote through Payload's Local API). Three changes from a prototype:
//   1. `surfaceToTraceType` is gone — `traces.label` is an opaque free-form
//      tag; the consumer's taxonomy lives there.
//   2. Cross-org check on `parentTraceId` is comparison on the opaque `org`
//      text (no numeric Payload id), throwing a plain Error so route handlers
//      can map it to 403 if needed.
//   3. Router-internal status enum maps `'started' → 'running'`, everything
//      else identity, into the `trace_status` pg enum.

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../../db/client.js';
import { traces, usageLogs } from '../../../db/schema/index.js';

type AnyDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type TraceStatusIn = 'started' | 'completed' | 'failed' | 'aborted';

type PersistedTraceStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

function mapStatus(s: TraceStatusIn): PersistedTraceStatus {
  // A prototype had `'completed' → 'ready'` etc. against an older trace enum; the
  // ai-service `trace_status` enum already matches the router vocabulary —
  // `'started'` is the only outlier (router-internal, not in the enum).
  return s === 'started' ? 'running' : s;
}

export interface WriteTraceInput {
  org: string;
  project?: string | null;
  /** Free-form grouping tag — what a prototype spread across `surface`/`traceType`. */
  label?: string;
  status: TraceStatusIn;
  model?: string;
  provider?: string;

  generationRequestId?: string;
  generationJobId?: string;
  registryEntryId?: string;
  parentTraceId?: string;

  promptVersion?: string;
  actorUserId?: string;

  inputPayload?: unknown;
  outputPayload?: unknown;
  tokenUsage?: unknown;
  durationMs?: number;

  effort?: 'quick' | 'standard' | 'deep' | 'maximum';
  effortProfileUsed?: unknown;

  estimatedCostUsd?: number;
  actualCostUsd?: number;
  costBreakdown?: unknown;

  metadata?: unknown;
}

export interface WriteUsageInput {
  org: string;
  project?: string | null;
  traceId?: string;
  generationRequestId?: string;
  generationJobId?: string;
  userId?: string;

  provider?: string;
  model?: string;
  endpoint?: string;

  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;

  status: 'completed' | 'failed' | 'aborted';

  metadata?: unknown;
}

function usdString(v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  // numeric(12, 6) — keep enough decimals.
  return v.toFixed(6);
}

export class TraceWriter {
  constructor(private readonly db: AnyDb) {}

  /**
   * Assert the parent trace (by id) belongs to `callerOrg`. Throws
   * `Error('cross-org parent trace rejected')` on mismatch / missing row.
   * No-op when `parentTraceId` is undefined.
   */
  async assertParentTraceOrg(opts: {
    parentTraceId?: string;
    callerOrg: string;
  }): Promise<void> {
    if (!opts.parentTraceId) return;
    const rows = await this.db
      .select({ org: traces.org })
      .from(traces)
      .where(eq(traces.id, opts.parentTraceId))
      .limit(1);
    const parent = rows[0];
    if (!parent || parent.org !== opts.callerOrg) {
      throw new Error('cross-org parent trace rejected');
    }
  }

  /** Insert a new `traces` row. Returns the persisted row id. */
  async writeTrace(input: WriteTraceInput): Promise<{ id: string }> {
    const values: typeof traces.$inferInsert = {
      org: input.org,
      project: input.project ?? null,
      label: input.label,
      status: mapStatus(input.status),
      model: input.model,
      provider: input.provider,
      generationRequestId: input.generationRequestId,
      generationJobId: input.generationJobId,
      registryEntryId: input.registryEntryId,
      parentTraceId: input.parentTraceId,
      promptVersion: input.promptVersion,
      actorUserId: input.actorUserId,
      inputPayload: input.inputPayload as object | undefined,
      outputPayload: input.outputPayload as object | undefined,
      tokenUsage: input.tokenUsage as object | undefined,
      durationMs: input.durationMs,
      effort: input.effort,
      effortProfileUsed: input.effortProfileUsed as object | undefined,
      estimatedCostUsd: usdString(input.estimatedCostUsd),
      actualCostUsd: usdString(input.actualCostUsd),
      costBreakdown: input.costBreakdown as object | undefined,
      metadata: input.metadata as object | undefined,
    };
    const inserted = await this.db
      .insert(traces)
      .values(values)
      .returning({ id: traces.id });
    const row = inserted[0];
    if (!row) throw new Error('TraceWriter.writeTrace: insert returned no row');
    return { id: row.id };
  }

  /** Append a `usage_logs` row. */
  async writeUsage(input: WriteUsageInput): Promise<{ id: string }> {
    const values: typeof usageLogs.$inferInsert = {
      org: input.org,
      project: input.project ?? null,
      userId: input.userId,
      generationRequestId: input.generationRequestId,
      generationJobId: input.generationJobId,
      traceId: input.traceId,
      provider: input.provider,
      model: input.model,
      endpoint: input.endpoint,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimatedCostUsd: usdString(input.estimatedCostUsd),
      actualCostUsd: usdString(input.actualCostUsd),
      status: input.status,
      metadata: input.metadata as object | undefined,
    };
    const inserted = await this.db
      .insert(usageLogs)
      .values(values)
      .returning({ id: usageLogs.id });
    const row = inserted[0];
    if (!row) throw new Error('TraceWriter.writeUsage: insert returned no row');
    return { id: row.id };
  }
}

// `sql` import retained for forward-compat (e.g. raw count queries during
// trace replay) — not currently used.
void sql;
