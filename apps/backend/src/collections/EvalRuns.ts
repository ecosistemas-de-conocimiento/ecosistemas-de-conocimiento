/**
 * EVAL RUNS — one execution of an ecosistema's eval set, from `/admin/evals`.
 *
 * The web app's background runner (`apps/web/src/lib/server/evals/runner.ts`)
 * creates the row `queued`, flips it `running`, writes progress, then `done`
 * (or `failed`) with the per-item results, the metrics, the measured cost, the
 * model ids and the commit it ran on.
 *
 * 🔴 PLATFORM ADMIN ONLY, FAIL CLOSED — same rule as `EvalItems`.
 *
 * ⚠ `results` NEVER holds a privacy text or the gate's output: a privacy item
 * records each planted term and whether it survived, nothing else. Chat items
 * record the answer and the judge verdicts; those come from the published
 * corpus, which every member of the ecosistema reads anyway.
 */
import type { CollectionConfig } from 'payload'

import { isPlatformAdmin } from '../access'

export const EVAL_RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number]

export const EvalRuns: CollectionConfig = {
  slug: 'eval-runs',
  admin: { group: 'Evaluaciones', defaultColumns: ['organization', 'status', 'costUsd', 'createdAt'] },
  access: { read: isPlatformAdmin, create: isPlatformAdmin, update: isPlatformAdmin, delete: isPlatformAdmin },
  fields: [
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'queued',
      index: true,
      options: EVAL_RUN_STATUSES.map((value) => ({ value, label: value })),
    },
    { name: 'triggeredBy', type: 'relationship', relationTo: 'users' },
    { name: 'startedAt', type: 'date' },
    { name: 'finishedAt', type: 'date' },
    /** The estimate shown before the confirm, in USD. Inferred, never measured. */
    { name: 'estimateUsd', type: 'number' },
    /**
     * Measured, but NOT every cost the run causes. It is the sum, over the
     * run's questions, of what ai-service reported for:
     *   · each answer (`POST /api/generate`'s `costUsd`);
     *   · its query expansion (`generationMeta.expansionCostUsd`; one that
     *     outlives its 5 s deadline is missed);
     *   · each citation and style judge call.
     * NOT counted (no cost reaches the runner): the privacy items' gate
     * (detector) calls, $0 on the Spark but billed on a hosted fallback; each
     * turn's condense call, embeddings and rerank. A turn ai-service answers
     * from its prompt cache reports $0.
     */
    { name: 'costUsd', type: 'number' },
    /** `{ done, total }` while running. */
    { name: 'progress', type: 'json' },
    /** `{ chat: string[], judge: string[], gate: string[] }` as the calls reported them. */
    { name: 'models', type: 'json' },
    { name: 'commitSha', type: 'text' },
    /** The run's eval conversation (`/api/evals/session`), so a run lost to a restart can still have it deleted. */
    { name: 'sessionId', type: 'text' },
    { name: 'metrics', type: 'json' },
    { name: 'results', type: 'json' },
    { name: 'error', type: 'text' },
  ],
}
