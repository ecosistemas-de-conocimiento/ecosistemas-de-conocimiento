// /v1/generate/* — generation orchestration HTTP surface.
//
// Mirrors `src/routes/registry.ts` in style: a Fastify plugin that delegates
// to the orchestrator + cancel modules in `src/services/generation/*`. The
// route layer's job is parse-and-translate: Zod-validate the body, map typed
// service errors to HTTP responses, and stamp every DB read with the caller's
// `{org, project}` (from `req.auth`, never the body).

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { generationJobs, generationRequests } from '../db/schema/index.js';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  GENERATE_RATE_LIMIT_MAX,
  V1_RATE_LIMIT_WINDOW,
} from '../server-limits.js';
import {
  BudgetExceededError,
  BudgetNotConfigured,
  CrossBatchDependencyError,
  DependencyCycleError,
  enqueueGeneration,
  IdempotencyConflictError,
  SpecResolutionError,
} from '../services/generation/orchestrator.js';
import { cancelGeneration } from '../services/generation/cancel.js';
import { resolveSpec } from '../services/registry/resolve.js';
import {
  resolveSystemPrompt,
  withSystemMessage,
} from '../services/generation/system-prompt.js';
import { renderPrompt, RenderError } from '../services/render/handlebars.js';
import { createOpenRouter } from '../services/ai/router/openrouter.js';
import { fetchContext } from '../services/context/fetch.js';
import {
  generateRequestSchema,
  generateSyncRequestSchema,
} from '../schemas/generate.js';

// Per-route overrides for both /v1/generate and /v1/generate/sync — these
// touch the LLM provider directly, so they get a tighter rate-limit cap and
// the default body-size budget (1 MiB) is plenty for prompt + variables.
const GENERATE_ROUTE_CONFIG = {
  bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  config: {
    rateLimit: {
      max: GENERATE_RATE_LIMIT_MAX,
      timeWindow: V1_RATE_LIMIT_WINDOW,
    },
  },
} as const;

const generateRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // POST /v1/generate — enqueue a batch.
  // -------------------------------------------------------------------------
  app.post('/', GENERATE_ROUTE_CONFIG, async (req, reply) => {
    const parsed = generateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    try {
      const result = await enqueueGeneration(parsed.data, {
        org: req.auth.org,
        project: req.auth.project,
        requestedBy: req.auth.apiKeyId,
        apiKeyId: req.auth.apiKeyId,
      });
      return result;
    } catch (err) {
      const mapped = mapGenerateError(err, reply, req);
      if (mapped !== undefined) return mapped;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/generate/sync — single-unit, inline, no queue.
  // -------------------------------------------------------------------------
  app.post('/sync', GENERATE_ROUTE_CONFIG, async (req, reply) => {
    const parsed = generateSyncRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { unit, effortLevel, modelOverride, systemPromptOverride, includeContext } =
      parsed.data;

    // Client-abort propagation: if the HTTP socket closes before we've sent
    // the response, abort the upstream OpenRouter fetch so the LLM provider
    // stops generating tokens we'd be billed for. The router already accepts
    // a `signal` and forwards it into the adapter's `fetch(..., { signal })`.
    const abortCtrl = new AbortController();
    const onClose = () => {
      if (!reply.sent) abortCtrl.abort();
    };
    req.raw.once('close', onClose);

    try {
      const spec = await resolveSpec(db, {
        org: req.auth.org,
        project: req.auth.project,
        unitType: unit.unitType,
        unitKey: unit.unitKey,
        specOverride: unit.specOverride,
        // FLOOR — a caller's built-in. Loses to an active registry row, unlike
        // `specOverride`. See `SpecDefault` in services/registry/resolve.ts.
        specDefault: unit.specDefault,
        requestOverrides: {
          ...(effortLevel ? { effortLevel } : {}),
          ...(modelOverride ? { modelOverride } : {}),
        },
      });
      // Resolve `includeContext` items into retrieved chunks and stash them
      // under `__context` so prompt templates can reference
      // `{{__context.<key>}}` — same shape the async orchestrator
      // produces (orchestrator.ts step 5). Prior to this, sync silently
      // dropped `includeContext` even though the schema accepted it.
      const contextMap = await fetchContext({
        org: req.auth.org,
        project: req.auth.project,
        ...(includeContext ? { includeContext } : {}),
      });
      const renderVars = {
        ...(unit.input ?? {}),
        __context: contextMap,
      };
      const rendered = renderPrompt(spec.promptTemplate, renderVars);
      // Shared precedence ladder — see services/generation/system-prompt.ts.
      // Absent at every level ⇒ `undefined` ⇒ the exact single-user-message
      // payload this route has always sent.
      const { systemPrompt } = resolveSystemPrompt({
        unitSystemPrompt: unit.systemPrompt,
        requestSystemPrompt: systemPromptOverride,
        spec,
        vars: renderVars,
      });
      const router = createOpenRouter();
      const result = await router.route({
        label: `sync:${unit.unitType ?? unit.unitKey}`,
        unitKey: unit.unitKey,
        ...(unit.unitType ? { unitType: unit.unitType } : {}),
        org: req.auth.org,
        project: req.auth.project,
        messages: withSystemMessage(systemPrompt, [{ role: 'user', content: rendered }]),
        model: spec.model,
        effortLevel: spec.effortLevel,
        effortProfile: spec.effortProfile,
        signal: abortCtrl.signal,
        ...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema } : {}),
        ...(spec.validators ? { validators: spec.validators } : {}),
        ...(spec.registryEntryId ? { registryEntryId: spec.registryEntryId } : {}),
        ...(spec.registryEntryVersion ? { promptVersion: spec.registryEntryVersion } : {}),
      });
      const warnings = result.softCap
        ? [
            {
              code: 'BUDGET_SOFT_CAP' as const,
              message: `Budget is below 10% remaining for org=${req.auth.org}`,
            },
          ]
        : undefined;
      return {
        text: result.content,
        parsed: result.parsed,
        modelUsed: result.model,
        provider: result.provider,
        costUsd: result.usage.estimatedCostUsd,
        traceId: result.traceId,
        // Verification handle: `true` iff a real `system` message was sent to
        // the model on this call. A migrating consumer asserts on this — if the
        // deployment it points at predates system-prompt support the field is
        // absent and the assertion fails LOUDLY, instead of the consumer
        // silently losing its instructions.
        systemPromptApplied: systemPrompt !== undefined,
        ...(warnings ? { warnings } : {}),
      };
    } catch (err) {
      // Two abort cases land here, both surfacing as `name === 'AbortError'`
      // (OpenRouterAbortError keeps that name):
      //   - client disconnect: our `abortCtrl` fired, socket is gone → 499,
      //     nothing actually lands on the wire.
      //   - wall-clock timeout: the router's internal backstop fired but the
      //     client is still connected (`abortCtrl` NOT aborted) → 504, so the
      //     caller gets a real "upstream timed out" response instead of a
      //     silent hang. The trace row already records `abortCause: 'timeout'`.
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        if (abortCtrl.signal.aborted) {
          reply.code(499);
          return reply.send();
        }
        return reply.code(504).send({
          error: 'ProviderTimeout',
          message: 'The upstream LLM provider exceeded the request timeout.',
        });
      }
      const mapped = mapGenerateError(err, reply, req);
      if (mapped !== undefined) return mapped;
      throw err;
    } finally {
      req.raw.removeListener('close', onClose);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/generate/stream — single-unit, inline, token-streamed over SSE.
  //
  // Same pipeline as /sync (resolveSpec → fetchContext → renderPrompt →
  // router.route), but the response is `text/event-stream`:
  //   data: {"type":"delta","text":"…"}      (repeated, in document order)
  //   data: {"type":"done","text":"…", …}    (terminal; same payload as /sync)
  //   data: {"type":"error","code":…,"message":…}  (terminal, post-header fail)
  //
  // Spec/context/render run BEFORE hijack so their failures map to clean HTTP
  // status codes (400 etc). Anything that throws after the first byte is
  // reported as a terminal `error` frame — the status line is already sent.
  // The `done` frame's `text` is authoritative: deltas are an optimistic
  // preview, and for cache hits no deltas fire (the full text lands in `done`).
  // -------------------------------------------------------------------------
  app.post('/stream', GENERATE_ROUTE_CONFIG, async (req, reply) => {
    const parsed = generateSyncRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { unit, effortLevel, modelOverride, systemPromptOverride, includeContext } =
      parsed.data;

    const abortCtrl = new AbortController();
    const onClose = (): void => {
      abortCtrl.abort();
    };
    req.raw.once('close', onClose);

    // Pre-hijack: resolve everything that can fail with a meaningful HTTP
    // status. If any of these throw, we still own the reply and can send JSON.
    let spec: Awaited<ReturnType<typeof resolveSpec>>;
    let rendered: string;
    let systemPrompt: string | undefined;
    let router: ReturnType<typeof createOpenRouter>;
    try {
      spec = await resolveSpec(db, {
        org: req.auth.org,
        project: req.auth.project,
        unitType: unit.unitType,
        unitKey: unit.unitKey,
        specOverride: unit.specOverride,
        // FLOOR — a caller's built-in. Loses to an active registry row, unlike
        // `specOverride`. See `SpecDefault` in services/registry/resolve.ts.
        specDefault: unit.specDefault,
        requestOverrides: {
          ...(effortLevel ? { effortLevel } : {}),
          ...(modelOverride ? { modelOverride } : {}),
        },
      });
      const contextMap = await fetchContext({
        org: req.auth.org,
        project: req.auth.project,
        ...(includeContext ? { includeContext } : {}),
      });
      const renderVars = {
        ...(unit.input ?? {}),
        __context: contextMap,
      };
      rendered = renderPrompt(spec.promptTemplate, renderVars);
      systemPrompt = resolveSystemPrompt({
        unitSystemPrompt: unit.systemPrompt,
        requestSystemPrompt: systemPromptOverride,
        spec,
        vars: renderVars,
      }).systemPrompt;
      router = createOpenRouter();
    } catch (err) {
      req.raw.removeListener('close', onClose);
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        reply.code(499);
        return reply.send();
      }
      const mapped = mapGenerateError(err, reply, req);
      if (mapped !== undefined) return mapped;
      throw err;
    }

    // Take over the socket and stream SSE frames.
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.write(': ok\n\n');

    const writeFrame = (obj: unknown): void => {
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* socket gone — abort fires via 'close' */
      }
    };

    try {
      const result = await router.route({
        label: `stream:${unit.unitType ?? unit.unitKey}`,
        unitKey: unit.unitKey,
        ...(unit.unitType ? { unitType: unit.unitType } : {}),
        org: req.auth.org,
        project: req.auth.project,
        messages: withSystemMessage(systemPrompt, [{ role: 'user', content: rendered }]),
        model: spec.model,
        effortLevel: spec.effortLevel,
        effortProfile: spec.effortProfile,
        signal: abortCtrl.signal,
        onDelta: (text) => writeFrame({ type: 'delta', text }),
        ...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema } : {}),
        ...(spec.validators ? { validators: spec.validators } : {}),
        ...(spec.registryEntryId ? { registryEntryId: spec.registryEntryId } : {}),
        ...(spec.registryEntryVersion ? { promptVersion: spec.registryEntryVersion } : {}),
      });
      const warnings = result.softCap
        ? [
            {
              code: 'BUDGET_SOFT_CAP' as const,
              message: `Budget is below 10% remaining for org=${req.auth.org}`,
            },
          ]
        : undefined;
      writeFrame({
        type: 'done',
        text: result.content,
        parsed: result.parsed,
        modelUsed: result.model,
        provider: result.provider,
        costUsd: result.usage.estimatedCostUsd,
        traceId: result.traceId,
        systemPromptApplied: systemPrompt !== undefined,
        ...(warnings ? { warnings } : {}),
      });
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted;
      if (!isAbort) {
        // A real generation failure (not an abort) — emit a terminal error frame.
        const { code, message } = classifyStreamError(err);
        req.log.error({ err }, 'streamed generation failed');
        writeFrame({ type: 'error', code, message });
      } else if (!abortCtrl.signal.aborted) {
        // Aborted, but NOT by the client (`abortCtrl` never fired) ⇒ the
        // wall-clock / stall backstop tripped while the socket is still open.
        // The client is listening, so tell it instead of silently ending.
        req.log.warn({ err }, 'streamed generation hit provider timeout backstop');
        writeFrame({
          type: 'error',
          code: 'ProviderTimeout',
          message: 'The upstream LLM provider exceeded the request timeout.',
        });
      }
      // else: genuine client disconnect — socket is gone, nothing to send.
    } finally {
      req.raw.removeListener('close', onClose);
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/generate/units/:unitKey/latest — most recent job for caller scope.
  // Declared BEFORE /:requestId so Fastify matches the literal segment first.
  // -------------------------------------------------------------------------
  app.get<{ Params: { unitKey: string } }>(
    '/units/:unitKey/latest',
    async (req, reply) => {
      const rows = await db
        .select()
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.org, req.auth.org),
            eq(generationJobs.project, req.auth.project),
            eq(generationJobs.unitKey, req.params.unitKey),
          ),
        )
        .orderBy(desc(generationJobs.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return reply.notFound(`no generation_jobs row for unitKey '${req.params.unitKey}'`);
      }
      return { unit: serializeJob(row) };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/generate/:requestId/cancel
  // -------------------------------------------------------------------------
  app.post<{ Params: { requestId: string } }>(
    '/:requestId/cancel',
    async (req, reply) => {
      const result = await cancelGeneration(req.params.requestId, {
        org: req.auth.org,
        project: req.auth.project,
      });
      if (!result.cancelled && result.removedJobs === 0) {
        return reply.notFound(`generation request '${req.params.requestId}' not found`);
      }
      return result;
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/generate/:requestId — request snapshot + per-unit jobs.
  // -------------------------------------------------------------------------
  app.get<{ Params: { requestId: string } }>('/:requestId', async (req, reply) => {
    const rows = await db
      .select()
      .from(generationRequests)
      .where(
        and(
          eq(generationRequests.id, req.params.requestId),
          eq(generationRequests.org, req.auth.org),
          eq(generationRequests.project, req.auth.project),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.notFound(`generation request '${req.params.requestId}' not found`);
    }
    const jobRows = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.generationRequestId, row.id));
    return {
      requestId: row.id,
      status: row.status,
      totalJobs: row.totalJobs,
      completedJobs: row.completedJobs,
      failedJobs: row.failedJobs,
      estimatedCostUsd: Number(row.estimatedCostUsd),
      actualCostUsd: Number(row.actualCostUsd),
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      cancelledAt: row.cancelledAt,
      units: jobRows.map(serializeJob),
    };
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JobRow = typeof generationJobs.$inferSelect;

function serializeJob(row: JobRow) {
  return {
    unitKey: row.unitKey,
    unitType: row.unitType,
    status: row.status,
    output: row.output,
    error: row.error,
    estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd),
    actualCostUsd: row.actualCostUsd === null ? null : Number(row.actualCostUsd),
    registryEntryId: row.registryEntryId,
    traceId: row.traceId,
    finishedAt: row.finishedAt,
  };
}

/**
 * Map a thrown orchestrator / resolver / cancel error onto a JSON response.
 * Returns the body to send (and stamps `reply.code(...)` for the matched
 * status) — or `undefined` when the error is unrecognised so the caller can
 * rethrow and let Fastify's 500 default kick in.
 */
function mapGenerateError(
  err: unknown,
  reply: FastifyReply,
  req: FastifyRequest,
): unknown | undefined {
  if (err instanceof SpecResolutionError) {
    reply.code(400);
    return {
      error: 'SpecResolutionError',
      cause: err.cause,
      message: err.message,
    };
  }
  if (err instanceof RenderError) {
    reply.code(400);
    return {
      error: 'RenderError',
      message: err.message,
    };
  }
  if (err instanceof IdempotencyConflictError) {
    reply.code(409);
    return {
      error: 'IdempotencyConflict',
      existingRequestId: err.existingRequestId,
      message: err.message,
    };
  }
  if (err instanceof DependencyCycleError) {
    reply.code(400);
    return {
      error: 'DependencyCycleError',
      cycle: err.cycle,
      message: err.message,
    };
  }
  if (err instanceof CrossBatchDependencyError) {
    reply.code(400);
    return {
      error: 'CrossBatchDependencyError',
      missing: err.missing,
      message: err.message,
    };
  }
  if (err instanceof BudgetNotConfigured) {
    reply.code(402);
    return {
      error: 'BudgetNotConfigured',
      org: err.org,
      message: err.message,
    };
  }
  if (err instanceof BudgetExceededError) {
    reply.code(402);
    return {
      error: 'BudgetExceeded',
      org: err.org,
      requested: err.requested,
      remaining: err.remaining,
      shortfallUsd: err.shortfallUsd,
      message: err.message,
    };
  }
  req.log.error({ err }, 'generation request failed');
  return undefined;
}

/**
 * Post-hijack error classification for the streamed route. We can't set an
 * HTTP status once the SSE headers are out, so map known errors to a stable
 * `code` string for the terminal `error` frame. Mirrors `mapGenerateError`'s
 * taxonomy; unknown errors collapse to `INTERNAL` with a generic message so we
 * don't leak internals over the wire.
 */
function classifyStreamError(err: unknown): { code: string; message: string } {
  if (err instanceof SpecResolutionError) return { code: 'SpecResolutionError', message: err.message };
  if (err instanceof RenderError) return { code: 'RenderError', message: err.message };
  if (err instanceof BudgetNotConfigured) return { code: 'BudgetNotConfigured', message: err.message };
  if (err instanceof BudgetExceededError) return { code: 'BudgetExceeded', message: err.message };
  // The router throws its own `BudgetExceeded` / `BudgetNotConfigured`
  // (services/budget/errors.js), distinct classes from the orchestrator's
  // re-exports above. Duck-type by name so a mid-stream budget rejection is
  // still legible.
  const name = err instanceof Error ? err.name : '';
  if (name === 'BudgetNotConfigured') {
    return { code: 'BudgetNotConfigured', message: err instanceof Error ? err.message : 'no budget configured' };
  }
  if (name === 'BudgetExceeded') {
    return { code: 'BudgetExceeded', message: err instanceof Error ? err.message : 'budget exceeded' };
  }
  return { code: 'INTERNAL', message: 'generation failed' };
}

export default generateRoutes;
