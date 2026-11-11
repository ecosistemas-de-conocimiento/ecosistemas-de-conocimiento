// Cancel an in-flight `GenerationRequest`.
//
// Per plan/m3-step5-detailed-plan.md §D.2 and plan/cancellation-cost-accounting.md:
//   1. Cross-tenant + missing both surface as `{cancelled: false, removedJobs: 0}`
//      (route layer maps to 404 — never 403, no existence-leak).
//   2. Already-cancelled is idempotent: returns `alreadyCancelled: true`, emits
//      no new event.
//   3. Best-effort `queue.remove(queueJobId)` walks the recorded BullMQ IDs;
//      running jobs typically can't be removed and continue.
//   4. Inside a single transaction: mark the request `cancelled` and mark
//      `queued` jobs `cancelled`.
//   5. Emit `generation.request.cancelled` after the DB writes succeed.
//   6. Publish on the Redis cancel-bus AFTER the DB tx commits so any worker
//      pod with the in-flight AbortController for this requestId can abort
//      its router.route() call and stop paying for tokens past this point.
//      The publish is best-effort; the worker's post-LLM-call status re-read
//      remains the correctness safety net for missed messages.

import { and, eq, inArray } from 'drizzle-orm';

import { db as defaultDb, type Db } from '../../db/client.js';
import { generationJobs, generationRequests, projectConfigs } from '../../db/schema/index.js';
import {
  type GenerationQueueLike,
} from '../../queue/queues.js';
import { enqueueCallback } from '../callbacks/emit.js';
import { getEventBus, type EventBus } from '../events/bus.js';
import type { CancelBus } from './cancel-bus.js';
import { BudgetEnforcer } from '../budget/enforcer.js';
import { rootLogger } from '../../logger.js';
import {
  CANCELLED_LOST_ERROR,
  WORKER_LOST_CODE,
  lostWindowMs,
} from '../jobs/lost.js';
import {
  heldOrEstimatedReserveUsd,
  settleLostGenerationJob,
} from '../../workers/generation.worker.js';

export interface CancelResult {
  cancelled: boolean;
  removedJobs: number;
  alreadyCancelled?: boolean;
  /**
   * Jobs that were sitting at `running` past the lock window — their worker
   * died — and that this cancel settled. ADDITIVE: a sibling count, never
   * folded into `removedJobs`, which has always meant "removed from the BullMQ
   * queue" and is 0 for these (there is nothing left in the queue to remove).
   * Omitted when zero, so a consumer that has never heard of the field sees a
   * byte-identical response for every request that has no lost job.
   */
  lostJobs?: number;
}

export interface CancelDeps {
  db?: Db;
  /** The generation queue. Required — no module-scope singleton to fall back on. */
  queue: GenerationQueueLike;
  bus?: EventBus;
  cancelBus?: CancelBus;
  budget?: BudgetEnforcer;
  /** Lost-worker window override. Test seam only; see `lostWindowMs()`. */
  lostWindowMs?: number;
}

export async function cancelGeneration(
  requestId: string,
  ctx: { org: string; project: string },
  deps: CancelDeps,
): Promise<CancelResult> {
  const db = deps.db ?? defaultDb;
  const queue = deps.queue;
  const bus = deps.bus ?? getEventBus();
  // Optional, and absent means "do not publish". That is EXACTLY what the old
  // `?? getCancelBus()` did for a caller that passed none: the fallback bus was
  // never `start()`ed, so `RedisCancelBus.publish()` returned early on its null
  // `pub` client. Production always passes `app.runtime.cancelBus`.
  const cancelBus = deps.cancelBus;
  const budget = deps.budget ?? new BudgetEnforcer(db);

  // 1. Cross-tenant guard + existence probe in one query.
  const rows = await db
    .select()
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.id, requestId),
        eq(generationRequests.org, ctx.org),
        eq(generationRequests.project, ctx.project),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { cancelled: false, removedJobs: 0 };
  }

  // 2. Idempotent: already cancelled.
  if (row.status === 'cancelled') {
    return { cancelled: true, removedJobs: 0, alreadyCancelled: true };
  }

  // 3. Pull queued/running jobs with their queue IDs.
  const jobRows = await db
    .select({
      id: generationJobs.id,
      queueJobId: generationJobs.queueJobId,
      status: generationJobs.status,
    })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.generationRequestId, row.id),
        inArray(generationJobs.status, ['queued', 'running']),
      ),
    );

  // 4. Best-effort queue removal. BullMQ `remove` returns 1 if removed
  // (job was waiting/delayed) or 0 if active/missing.
  let removedJobs = 0;
  for (const j of jobRows) {
    if (!j.queueJobId) continue;
    const removed = await queue.remove(j.queueJobId).catch(() => 0);
    if (removed === 1) removedJobs += 1;
  }

  // 5. Transactional DB writes: mark request + queued jobs cancelled. Running
  // jobs stay running — the worker transitions them when it re-reads the
  // parent status (see §D.3).
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(generationRequests)
      .set({ status: 'cancelled', cancelledAt: now, finishedAt: now })
      .where(eq(generationRequests.id, row.id));
    await tx
      .update(generationJobs)
      .set({ status: 'cancelled', finishedAt: now })
      .where(
        and(
          eq(generationJobs.generationRequestId, row.id),
          eq(generationJobs.status, 'queued'),
        ),
      );
  });

  // 5b. Jobs left at 'running' by a DEAD worker. `/cancel` used to leave these
  // untouched forever: the transaction above only moves rows in 'queued', and
  // the comment said the worker transitions a running job when it re-reads the
  // parent — which is true of a LIVE worker and false of one that is gone. The
  // result was `{cancelled:true, removedJobs:0}` with the row still 'running',
  // and the router's reserve for it still held.
  //
  // A job running INSIDE the window is still handled the old way: the
  // cancel-bus publish at step 7 aborts its in-flight LLM call and the worker
  // settles its own row. Only rows past the window — where there is no worker
  // left to do that — are settled here.
  const windowMs = deps.lostWindowMs ?? lostWindowMs();
  let lostJobs = 0;
  for (const j of jobRows) {
    if (j.status !== 'running') continue;
    const settled = await settleLostGenerationJob(db, j.id, {
      windowMs,
      status: 'cancelled',
      error: CANCELLED_LOST_ERROR,
      code: WORKER_LOST_CODE,
    });
    if (!settled) continue;
    lostJobs += 1;
    // Same leak, same fix as the reaper: the reserve was taken and will never
    // be trued up. Guarded by the rowcount above, so a second cancel refunds
    // nothing.
    const refundUsd = await heldOrEstimatedReserveUsd(budget, j.id, settled);
    if (refundUsd > 0) {
      // `jobId` closes the ledger rows too — otherwise the reaper's next sweep
      // still sees a live hold for a job `/cancel` already settled.
      await budget.refund({ org: ctx.org, amountUsd: refundUsd, jobId: j.id }).catch((err: unknown) => {
        rootLogger.warn({ jobId: j.id, err }, 'cancel: refunding the lost reserve failed');
      });
    }
  }

  // 6. Emit after writes commit.
  bus.emit({
    type: 'generation.request.cancelled',
    requestId: row.id,
    org: ctx.org,
    project: ctx.project,
  });

  // 6b. Callback contract: `request.cancelled`. Use the same callbackUrl
  // resolution chain the worker uses for terminal transitions: row-level
  // override > project_configs default. Fire-and-forget.
  const callbackUrl =
    row.callbackUrl ?? (await resolveProjectCallbackUrl(db, ctx.org, ctx.project));
  if (callbackUrl) {
    const finalRows = await db
      .select({
        completedJobs: generationRequests.completedJobs,
        failedJobs: generationRequests.failedJobs,
        totalJobs: generationRequests.totalJobs,
        actualCostUsd: generationRequests.actualCostUsd,
      })
      .from(generationRequests)
      .where(eq(generationRequests.id, row.id))
      .limit(1);
    const counts = finalRows[0] ?? {
      completedJobs: 0,
      failedJobs: 0,
      totalJobs: 0,
      actualCostUsd: '0',
    };
    void enqueueCallback(
      {
        event: 'request.cancelled',
        emittedAt: now.toISOString(),
        requestId: row.id,
        clientRequestId: row.clientRequestId ?? null,
        totalJobs: counts.totalJobs,
        completedJobs: counts.completedJobs,
        failedJobs: counts.failedJobs,
        cancelledJobs: Math.max(0, counts.totalJobs - counts.completedJobs - counts.failedJobs),
        totalCostUsd: Number(counts.actualCostUsd),
      },
      {
        url: callbackUrl,
        apiKeyId: row.apiKeyId ?? null,
        source: 'generate',
        sourceId: row.id,
        itemKey: null,
        org: ctx.org,
        project: ctx.project,
      },
      { db },
    ).catch((err) => {
      rootLogger.warn({ err }, 'cancel: enqueueCallback (request.cancelled) failed');
    });
  }

  // 7. Best-effort pub/sub hint so worker pods can abort their in-flight LLM
  // call. The DB write at step 5 is the authoritative cancel; this just
  // shaves the latency from "until the LLM call finishes" to "tens of ms".
  await cancelBus?.publish(row.id);

  return { cancelled: true, removedJobs, ...(lostJobs > 0 ? { lostJobs } : {}) };
}

async function resolveProjectCallbackUrl(
  db: Db,
  org: string,
  project: string | null | undefined,
): Promise<string | null> {
  if (!project) return null;
  const rows = await db
    .select({ callbackUrl: projectConfigs.callbackUrl })
    .from(projectConfigs)
    .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
    .limit(1);
  return rows[0]?.callbackUrl ?? null;
}
