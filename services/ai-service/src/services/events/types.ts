/**
 * M3 Step 5 — ai-service narrowed event union.
 *
 * Adapted from a prototype `types/events.ts`. Dropped all `brainstorm.*`, `story.*`,
 * `*.dimensions.updated`, `orgBudget.*`, and `trace.progress` events that
 * carried prototype-specific dimension/cluster semantics. What remains is the
 * narrow set the generation orchestrator + trace writer need to fan out over
 * SSE in ai-service.
 *
 * Conventions:
 * - `org` (not a prototype's `orgId`) — matches ai-service's auth/context naming.
 * - `project?` (optional) — generation requests are not always project-scoped.
 * - `flags: Flag[]` (validator flags) replaces a prototype's `SystemFlag`.
 */

import type { Flag } from '../ai/validators/types.js';

export type AppEvent =
  // ── Generation request lifecycle ──
  | {
      type: 'generation.request.started';
      requestId: string;
      org: string;
      project?: string;
      totalJobs: number;
      estimatedCostUsd: number;
    }
  | {
      type: 'generation.request.completed';
      requestId: string;
      org: string;
      project?: string;
      status: 'completed' | 'partial' | 'failed';
      totalCostUsd: number;
    }
  | {
      type: 'generation.request.cancelled';
      requestId: string;
      org: string;
      project?: string;
    }
  // ── Generation job lifecycle ──
  | {
      type: 'generation.job.started';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
    }
  | {
      type: 'generation.job.completed';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
      flags: Flag[];
      costUsd: number;
    }
  | {
      type: 'generation.job.failed';
      requestId: string;
      jobId: string;
      unitKey: string;
      org: string;
      project?: string;
      errorCode: string;
      errorMessage: string;
    }
  // ── Trace (router) lifecycle ──
  | {
      type: 'trace.started';
      traceId: string;
      org: string;
      project?: string;
    }
  | {
      type: 'trace.completed';
      traceId: string;
      org: string;
      project?: string;
      totalCostUsd: number;
    }
  | {
      type: 'trace.failed';
      traceId: string;
      org: string;
      project?: string;
      errorCode: string;
    };

export type AppEventType = AppEvent['type'];

export type EventFor<T extends AppEventType> = Extract<AppEvent, { type: T }>;
