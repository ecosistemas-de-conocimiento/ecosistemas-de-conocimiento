import { z } from 'zod';

// Mirrors ai-service/src/schemas/generate.ts + consumer-contract.md v0.3 §2/§3.
// Field names and `.strict()` boundaries match the deployed Zod gates verbatim;
// when the contract firms further, only this file should need to change.

export const validatorSchema = z.union([
  z.string().min(1),
  z.object({ type: z.string().min(1) }).passthrough(),
]);
export type ValidatorRule = z.infer<typeof validatorSchema>;

const mmrSchema = z.union([z.number(), z.object({ lambda: z.number() }).strict()]);

export const includeContextItemSchema = z.union([
  z
    .object({
      corpus: z.string().min(1),
      query: z.string().min(1),
      topK: z.number().int().positive(),
      mmr: mmrSchema.optional(),
    })
    .strict(),
  z.object({ name: z.string().min(1) }).strict(),
]);
export type IncludeContextItem = z.infer<typeof includeContextItemSchema>;

export const inlineSpecOverrideSchema = z
  .object({
    promptTemplate: z.string().min(1).optional(),
    metaPromptTemplate: z.string().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effortLevel: z.string().optional(),
    effortProfile: z.record(z.string(), z.unknown()).optional(),
    responseSchema: z.unknown().optional(),
    validators: z.array(validatorSchema).optional(),
    renderer: z.string().nullable().optional(),
    contentKind: z.string().nullable().optional(),
  })
  .strict();
export type InlineSpecOverride = z.infer<typeof inlineSpecOverrideSchema>;

export const unitSchema = z
  .object({
    unitKey: z.string().min(1),
    unitType: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    dependsOn: z.record(z.string(), z.string()).optional(),
    specOverride: inlineSpecOverrideSchema.optional(),
    /**
     * Real system prompt for this unit — LITERAL text, never Handlebars-
     * rendered, sent to the model as a genuine `system` message. Highest
     * precedence of ai-service's four system-prompt sources. `min(1)`: send
     * `undefined`, never `''`.
     */
    systemPrompt: z.string().min(1).optional(),
  })
  .strict();
export type Unit = z.infer<typeof unitSchema>;

export const generateRequestSchema = z
  .object({
    units: z.array(unitSchema).min(1).max(100),
    effortLevel: z.string().optional(),
    promptOverride: z.string().optional(),
    modelOverride: z.string().optional(),
    effortOverrides: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
    includeContext: z.array(includeContextItemSchema).optional(),
    clientRequestId: z.string().min(1).max(200).optional(),
    callbackUrl: z.string().url().optional(),
    requestedBy: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

/**
 * Non-fatal advisory from ai-service, carried alongside a SUCCESSFUL response.
 *
 * Today the only code emitted is `BUDGET_SOFT_CAP` (fired at 10% budget
 * remaining) — the early warning that the hard 402 is coming. Treat unknown
 * codes as informational rather than rejecting them, so a new ai-service
 * warning never breaks an older chat deployment.
 *
 * ⚠ These MUST be declared explicitly on every response schema that can carry
 * them: zod v4 STRIPS unknown keys from a bare `z.object`, so an undeclared
 * `warnings` was silently deleted at the parse boundary and the operator never
 * saw the run-up to an outage.
 */
export const aiWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type AIWarning = z.infer<typeof aiWarningSchema>;

export const generateResponseSchema = z.object({
  requestId: z.string(),
  channel: z.string(),
  totalJobs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number(),
  warnings: z.array(aiWarningSchema).optional(),
});
export type GenerateResponse = z.infer<typeof generateResponseSchema>;

export const generateSyncRequestSchema = z
  .object({
    unit: unitSchema,
    effortLevel: z.string().optional(),
    modelOverride: z.string().optional(),
    includeContext: z.array(includeContextItemSchema).optional(),
    requestedBy: z.string().optional(),
  })
  .strict();
export type GenerateSyncRequest = z.infer<typeof generateSyncRequestSchema>;

export const generateSyncResponseSchema = z.object({
  text: z.string(),
  parsed: z.unknown().optional(),
  modelUsed: z.string().optional(),
  provider: z.string().optional(),
  costUsd: z.number().optional(),
  traceId: z.string().optional(),
  /**
   * `true` iff a real `system` message reached the model on this call. Optional
   * on purpose: an ai-service predating system-prompt support omits it, and the
   * client asserts `!== true` so that case fails LOUDLY instead of silently
   * dropping chat's instructions. Never treat "absent" as success.
   */
  systemPromptApplied: z.boolean().optional(),
  /** Non-fatal advisories (e.g. `BUDGET_SOFT_CAP`). See `aiWarningSchema`. */
  warnings: z.array(aiWarningSchema).optional(),
});
export type GenerateSyncResponse = z.infer<typeof generateSyncResponseSchema>;

const jobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const unitSnapshotSchema = z.object({
  unitKey: z.string(),
  unitType: z.string().nullable(),
  status: jobStatusSchema,
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  estimatedCostUsd: z.number().nullable(),
  actualCostUsd: z.number().nullable(),
  registryEntryId: z.string().nullable(),
  traceId: z.string().nullable(),
  finishedAt: z.union([z.string(), z.date(), z.null()]),
});
export type UnitSnapshot = z.infer<typeof unitSnapshotSchema>;

// Wrapper for GET /v1/generate/units/:unitKey/latest, which returns `{ unit }`.
export const latestUnitResponseSchema = z.object({ unit: unitSnapshotSchema });

export const generationRequestSnapshotSchema = z.object({
  requestId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'partial', 'cancelled']),
  totalJobs: z.number().int().nonnegative(),
  completedJobs: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number(),
  actualCostUsd: z.number(),
  createdAt: z.union([z.string(), z.date()]),
  startedAt: z.union([z.string(), z.date(), z.null()]).optional(),
  finishedAt: z.union([z.string(), z.date(), z.null()]).optional(),
  cancelledAt: z.union([z.string(), z.date(), z.null()]).optional(),
  units: z.array(unitSnapshotSchema),
});
export type GenerationRequestSnapshot = z.infer<typeof generationRequestSnapshotSchema>;

export const cancelResponseSchema = z.object({
  cancelled: z.boolean(),
  removedJobs: z.number().int().nonnegative(),
});
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

// M7 — RAG retrieve. Used directly by the BFF only for the race-mitigation
// "is the corpus visible yet?" probe; the actual context attachment happens
// via `IncludeContextItem` on the generate request below.
export const retrieveRequestSchema = z
  .object({
    corpus: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().positive().optional(),
    mmr: mmrSchema.optional(),
  })
  .strict();
export type RetrieveRequest = z.infer<typeof retrieveRequestSchema>;

export const retrievedChunkSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  ordinal: z.number(),
  text: z.string(),
  score: z.number(),
  // Per-leg scores ai-service adds on hybrid and rerank retrieves. Without
  // them zod strips the keys and a caller cannot tell a cross-encoder `score`
  // from a cosine. Optional: a plain dense retrieve sends none.
  denseScore: z.number().optional(),
  lexicalScore: z.number().optional(),
  rerankScore: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// No `warnings` here on purpose: `/v1/retrieve` reserves no budget and emits no
// warnings (verified in ai-service — `BUDGET_SOFT_CAP` is raised only by the
// generation orchestrator and `/v1/embed`). An optional field that can never
// arrive would just imply a contract we do not have.
export const retrieveResponseSchema = z.object({
  chunks: z.array(retrievedChunkSchema),
});
export type RetrieveResponse = z.infer<typeof retrieveResponseSchema>;

export const budgetResponseSchema = z.object({
  org: z.string(),
  limitUsd: z.number(),
  remainingUsd: z.number(),
  spentUsd: z.number(),
  currency: z.string(),
});
export type BudgetResponse = z.infer<typeof budgetResponseSchema>;

// The auth ping returns the bearer's identity. The exact shape isn't pinned in
// the contract; we treat anything 2xx-with-JSON as success and surface the body
// as-is to callers that want to introspect.
export const pingResponseSchema = z
  .object({
    org: z.string().optional(),
    project: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();
export type PingResponse = z.infer<typeof pingResponseSchema>;

// AppEvent (SSE payload) — shape varies across event types in ai-service.
// We require only the discriminator + an optional requestId so consumers can
// route on `type`; everything else passes through.
export const appEventSchema = z
  .object({
    type: z.string(),
    requestId: z.string().optional(),
  })
  .passthrough();
export type AppEvent = z.infer<typeof appEventSchema>;
