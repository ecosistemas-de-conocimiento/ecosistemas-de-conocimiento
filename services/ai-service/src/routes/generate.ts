// /v1/generate/* — generation orchestration HTTP surface.
//
// Mirrors `src/routes/registry.ts` in style: a Fastify plugin that delegates
// to the orchestrator + cancel modules in `src/services/generation/*`. The
// route layer's job is parse-and-translate: Zod-validate the body, map typed
// service errors to HTTP responses, and stamp every DB read with the caller's
// `{org, project}` (from `req.auth`, never the body).
//
// ⚠ "Map typed service errors to HTTP responses" holds for /v1/generate and
// /v1/generate/sync ONLY. /v1/generate/stream hijacks the reply before it
// calls the router, so everything the router refuses — budget (402) and
// breaker-open (503) alike — reaches that client as a terminal SSE `error`
// FRAME under a 200 status line. See the /stream block comment below.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { generationJobs, generationRequests } from '../db/schema/index.js';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  GENERATE_RATE_LIMIT_MAX,
  V1_RATE_LIMIT_WINDOW,
} from '../server-limits.js';
import { enqueueGeneration } from '../services/generation/orchestrator.js';
import {
  classifyStreamError,
  mapGenerateError,
  type MappedGenerateError,
} from '../errors/generate-map.js';
import { cancelGeneration } from '../services/generation/cancel.js';
import { assertSafeCallbackUrl } from '../services/callbacks/url-guard.js';
import { resolveSpec } from '../services/registry/resolve.js';
import {
  resolveSystemPrompt,
  withSystemMessage,
} from '../services/generation/system-prompt.js';
import { renderPrompt } from '../services/render/handlebars.js';
import { createOpenRouter } from '../services/ai/router/openrouter.js';
import { fetchContextWithTrace } from '../services/context/fetch.js';
import { projectWireUsage } from '../services/generation/wire-projection.js';
import {
  generateRequestSchema,
  generateSyncRequestSchema,
} from '../contract/generate.js';
import { withHttpRequestId } from '../telemetry/http-request-id.js';
import { spanRoute, type RouteSpanHandle } from '../telemetry/span.js';

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

/**
 * Log fields for a /sync call the client hung up on.
 *
 * `err.partial` is read by SHAPE, not `instanceof OpenRouterAbortError`: the
 * router rethrows that class unchanged, but an abort that lands before the
 * provider call (spec resolve, context fetch) has no partial at all, and the
 * fields then say so with zeros. Cost is what the router already settled on
 * the trace (partial spend kept, rest of the reserve refunded) before it threw.
 */
export function clientAbortLogFields(
  requestId: string,
  elapsedMs: number,
  err: unknown,
): Record<string, unknown> {
  const partial = (err as { partial?: { usage?: Record<string, unknown> } } | null)?.partial;
  const usage = partial?.usage ?? {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    event: 'generate.sync.client_abort',
    statusCode: 499,
    requestId,
    elapsedMs: Math.round(elapsedMs),
    reachedProvider: partial !== undefined,
    inputTokens: num(usage['promptTokens']),
    outputTokens: num(usage['completionTokens']),
    costSettledUsd: num(usage['costUsd']),
    ...(typeof usage['costSource'] === 'string' ? { costSource: usage['costSource'] } : {}),
  };
}

const generateRoutes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // POST /v1/generate — enqueue a batch.
  // -------------------------------------------------------------------------
  // Handlers are named consts and the span is applied at the REGISTRATION line
  // below (`spanRoute`), not around the body. See the note on `spanRoute` in
  // `src/telemetry/span.ts`: wrapping inline re-indents ~560 lines of this file
  // and buries the change.
  const enqueueHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = generateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    // SSRF guard (audit finding [HIGH] SSRF): validate the consumer-supplied
    // callbackUrl BEFORE the orchestrator persists it — refuse loopback/
    // private/link-local/metadata targets and non-allowlisted schemes with a
    // legible 400. `attemptDelivery` re-validates before every POST.
    // The guard's `CallbackUrlBlockedError` declares the 400 itself and is
    // rethrown, so the caller gets `{error:'CallbackUrlBlockedError', code,
    // message}` instead of fastify-sensible's generic `error: 'Bad Request'`.
    if (parsed.data.callbackUrl) {
      await assertSafeCallbackUrl(parsed.data.callbackUrl);
    }
    try {
      const result = await enqueueGeneration(
        parsed.data,
        // Carries Fastify's `req.id` into the orchestrator context so the queued
        // job — and the worker log lines it produces — can be joined back to
        // this HTTP request. Contract note in `telemetry/http-request-id.ts`:
        // lane A owns the orchestrator and adds the matching
        // `httpRequestId?: string` field; until then the value is carried and
        // dropped, which is why the id is ALSO on the request log lines, on the
        // span, and on the `x-request-id` response header.
        withHttpRequestId(
          {
            org: req.auth.org,
            project: req.auth.project,
            requestedBy: req.auth.apiKeyId,
            apiKeyId: req.auth.apiKeyId,
          },
          req.id,
        ),
        {
          logger: app.log,
          queue: app.runtime.queues.generation,
          flow: app.runtime.queues.flow,
        },
      );
      return result;
    } catch (err) {
      const mapped = mapGenerateError(err);
      if (mapped !== undefined) return sendMapped(reply, mapped);
      req.log.error({ err }, 'generation request failed');
      throw err;
    }
  };
  app.post('/', GENERATE_ROUTE_CONFIG, spanRoute('POST /v1/generate', enqueueHandler));

  // -------------------------------------------------------------------------
  // POST /v1/generate/sync — single-unit, inline, no queue.
  // -------------------------------------------------------------------------
  const syncHandler = async (req: FastifyRequest, reply: FastifyReply, otel: RouteSpanHandle) => {
    const parsed = generateSyncRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { unit, effortLevel, modelOverride, systemPromptOverride, includeContext } =
      parsed.data;
    // Known only now — the span was opened before the body was validated.
    otel.setUnit(unit.unitType, unit.unitKey);

    // Client-abort propagation: if the HTTP socket closes before we've sent
    // the response, abort the upstream OpenRouter fetch so the LLM provider
    // stops generating tokens we'd be billed for. The router already accepts
    // a `signal` and forwards it into the adapter's `fetch(..., { signal })`.
    //
    // 🔴 THE LISTENER GOES ON `reply.raw`, NEVER ON `req.raw`. See the long note
    // on the /stream handler below: by the time a handler runs, Fastify has
    // already read the body, so the IncomingMessage has ended and its `'close'`
    // has ALREADY FIRED — a `once('close')` registered here can never run. This
    // propagation was silently dead on both transports.
    const abortCtrl = new AbortController();
    const onClose = () => {
      if (!reply.sent && !reply.raw.writableEnded) abortCtrl.abort();
    };
    reply.raw.once('close', onClose);

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
      //
      // A missing corpus (404), an unknown recipe (400) or a budget refusal
      // (402) throws here and is mapped below — never an ungrounded 200.
      const { context: contextMap, retrievalTrace } = await fetchContextWithTrace({
        org: req.auth.org,
        project: req.auth.project,
        ...(includeContext ? { includeContext } : {}),
        logger: app.log,
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
      // Known only now: `resolveSpec` is what decides the model.
      otel.setModel(spec.model);
      const router = createOpenRouter();
      const result = await router.route(withHttpRequestId({
        label: `sync:${unit.unitType ?? unit.unitKey}`,
        unitKey: unit.unitKey,
        ...(unit.unitType ? { unitType: unit.unitType } : {}),
        org: req.auth.org,
        project: req.auth.project,
        messages: withSystemMessage(systemPrompt, [{ role: 'user', content: rendered }]),
        model: spec.model,
        effortLevel: spec.effortLevel,
        effortProfile: spec.effortProfile,
        // Client-disconnect OR process shutdown. `runtime.shutdownSignal` fires
        // when SHUTDOWN_GRACE_MS expires after a SIGTERM; without it in here the
        // grace bounded the BullMQ workers and nothing else, and `app.close()`
        // waited out the whole generation AFTER the window had already passed —
        // MEASURED at 25 s against a 2 s grace. The router adds its wall-clock
        // backstop as the third input (`services/ai/router/timeout-signal.ts`).
        signal: AbortSignal.any([abortCtrl.signal, app.runtime.shutdownSignal]),
        ...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema } : {}),
        ...(spec.responseSchemaStrict ? { responseSchemaStrict: true } : {}),
        ...(spec.validators ? { validators: spec.validators } : {}),
        ...(spec.registryEntryId ? { registryEntryId: spec.registryEntryId } : {}),
        ...(spec.registryEntryVersion ? { promptVersion: spec.registryEntryVersion } : {}),
      }, req.id));
      const warnings = result.softCap
        ? [
            {
              code: 'BUDGET_SOFT_CAP' as const,
              message: `Budget is below 10% remaining for org=${req.auth.org}`,
            },
          ]
        : undefined;
      // Token counts + finish reason are ADDITIVE and OPTIONAL: both are
      // omitted when the provider reported nothing, so every existing
      // consumer's required shape is unchanged.
      const usage = projectWireUsage(result.usage);
      return {
        text: result.content,
        parsed: result.parsed,
        modelUsed: result.model,
        provider: result.provider,
        costUsd: result.usage.estimatedCostUsd,
        ...(usage ? { usage } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        traceId: result.traceId,
        // Verification handle: `true` iff a real `system` message was sent to
        // the model on this call. A migrating consumer asserts on this — if the
        // deployment it points at predates system-prompt support the field is
        // absent and the assertion fails LOUDLY, instead of the consumer
        // silently losing its instructions.
        systemPromptApplied: systemPrompt !== undefined,
        ...(warnings ? { warnings } : {}),
        ...(retrievalTrace.length > 0 ? { retrievalTrace } : {}),
      };
    } catch (err) {
      // OUR provider timeout (deadline or stall, in ANY pass) is NOT an
      // `AbortError`: the router throws the `ProviderTimeout` taxonomy class,
      // and `mapGenerateError` below sends its 504 with `truncated: true`,
      // `reason: 'provider_timeout'`, unbilled (decision).
      //
      // Aborts that DO land here, surfacing as `name === 'AbortError'`
      // (OpenRouterAbortError keeps that name):
      //   - client disconnect: our `abortCtrl` fired, socket is gone → 499,
      //     nothing actually lands on the wire.
      //   - process shutdown (`runtime.shutdownSignal`), client still
      //     connected → the legacy hand-rolled 504 below. The partial IS billed
      //     on this path (a3a6a52): a shutdown is not a provider timeout.
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        if (abortCtrl.signal.aborted) {
          // One structured line per disconnect. Without it, an aborted call
          // left no access-log status a human recognises (the socket was gone)
          // and looked like a silent hang from both ends — measured:
          // a client-side 30 s abort, billed partial, no line here.
          req.log.warn(
            clientAbortLogFields(req.id, reply.elapsedTime, err),
            'generate/sync: client disconnected before the answer was sent',
          );
          reply.code(499);
          return reply.send();
        }
        return reply.code(504).send({
          error: 'ProviderTimeout',
          message: 'The upstream LLM provider exceeded the request timeout.',
        });
      }
      const mapped = mapGenerateError(err);
      if (mapped !== undefined) return sendMapped(reply, mapped);
      req.log.error({ err }, 'generation request failed');
      throw err;
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  };
  app.post('/sync', GENERATE_ROUTE_CONFIG, spanRoute('POST /v1/generate/sync', syncHandler));

  // -------------------------------------------------------------------------
  // POST /v1/generate/stream — single-unit, inline, token-streamed over SSE.
  //
  // Same pipeline as /sync (resolveSpec → fetchContext → renderPrompt →
  // router.route), but the response is `text/event-stream`:
  //   data: {"type":"delta","text":"…"}      (repeated, in document order)
  //   data: {"type":"done","text":"…", …}    (terminal; same payload as /sync)
  //   data: {"type":"error","code":…,"message":…,"errorCode"?:…,"retryAfterMs"?:…}
  //                                            (terminal, post-header fail)
  //
  // Spec/context/render run BEFORE hijack so their failures map to clean HTTP
  // status codes (400 etc). Anything that throws after the first byte is
  // reported as a terminal `error` frame — the status line is already sent.
  //
  // ⚠ WHICH FAILURES ARE A STATUS AND WHICH ARE A FRAME — this differs between
  // the two transports, and the difference is easy to get wrong:
  //   - /sync enforces budget and calls the provider while it still owns the
  //     reply, so a budget refusal is a real HTTP 402 body and a breaker-open
  //     is a real HTTP 503 + `Retry-After` (see `mapGenerateError`).
  //   - /stream reserves budget INSIDE `router.route()`, which runs AFTER
  //     `reply.hijack()` above. By then the status line is already on the wire
  //     as 200. A budget refusal therefore arrives as an SSE `error` FRAME
  //     with `code: "BudgetExceeded" | "BudgetNotConfigured" |
  //     "BudgetMisconfigured"` — NEVER as a 402 — and a breaker-open arrives
  //     as `code: "ProviderUnavailable"` with `retryAfterMs`, never as a 503.
  //     A stream client that only inspects the HTTP status sees success.
  // The `done` frame carries the optional `usage` / `finishReason` fields on
  // exactly the same terms as /sync — same projection helper, same omission
  // rules — because "same payload as /sync" is the contract above.
  // The `done` frame's `text` is authoritative: deltas are an optimistic
  // preview, and for cache hits no deltas fire (the full text lands in `done`).
  // -------------------------------------------------------------------------
  const streamHandler = async (req: FastifyRequest, reply: FastifyReply, otel: RouteSpanHandle) => {
    const parsed = generateSyncRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { unit, effortLevel, modelOverride, systemPromptOverride, includeContext } =
      parsed.data;
    // Known only now — the span was opened before the body was validated.
    otel.setUnit(unit.unitType, unit.unitKey);

    // ── 🔴 CLIENT-ABORT PROPAGATION: LISTEN ON `reply.raw`, NOT ON `req.raw` ──
    //
    // Measured, with timestamped probes on all three emitters:
    // at handler entry `req.raw` is already `complete: true, readableEnded:
    // true, destroyed: true`, because Fastify read and parsed the JSON body
    // before dispatching. Its `'close'` had therefore ALREADY FIRED, and
    // `once('close')` on an emitter whose event is in the past never runs.
    //
    // So `abortCtrl` was never aborted. The consequences were invisible and
    // expensive: a reader who pressed Stop dropped the socket, the provider
    // kept generating, and the trace closed as `completed` carrying the FULL
    // cost of an answer nobody received. The partial-cost accounting path in
    // `router.ts` — `OpenRouterAbortError` → `status: 'aborted'` → refund the
    // unspent reserve — was unreachable from a client disconnect on either
    // transport. Nothing logged, nothing failed, and the bill was simply wrong.
    //
    // The ServerResponse is the object with a future. It emits `'close'` when
    // the connection goes away: verified firing 1.37 s into an 8 s generation,
    // exactly when the browser aborted. The `finally` below removes this
    // listener BEFORE `reply.raw.end()`, so a NORMAL completion cannot trip it
    // on the way out.
    //
    // ⚠ Do not "simplify" this back to `req.raw`. It reads like the request's
    // business and it is not — and the failure is silent in both directions.
    const abortCtrl = new AbortController();
    const onClose = (): void => {
      abortCtrl.abort();
    };
    reply.raw.once('close', onClose);

    // Pre-hijack: resolve everything that can fail with a meaningful HTTP
    // status. If any of these throw, we still own the reply and can send JSON.
    let spec: Awaited<ReturnType<typeof resolveSpec>>;
    let rendered: string;
    let systemPrompt: string | undefined;
    let retrievalTrace: Awaited<ReturnType<typeof fetchContextWithTrace>>['retrievalTrace'];
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
      const fetched = await fetchContextWithTrace({
        org: req.auth.org,
        project: req.auth.project,
        ...(includeContext ? { includeContext } : {}),
        logger: app.log,
      });
      const contextMap = fetched.context;
      retrievalTrace = fetched.retrievalTrace;
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
      // Known only now: `resolveSpec` is what decides the model.
      otel.setModel(spec.model);
    } catch (err) {
      reply.raw.removeListener('close', onClose);
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        reply.code(499);
        return reply.send();
      }
      const mapped = mapGenerateError(err);
      if (mapped !== undefined) return sendMapped(reply, mapped);
      req.log.error({ err }, 'generation request failed');
      throw err;
    }

    // Take over the socket and stream SSE frames.
    // 🔴 `x-request-id` GOES HERE, NOT ON `reply`. The `onRequest` hook in
    // `server.ts` sets it via `reply.header(...)`, which only reaches the wire
    // through Fastify's own serializer — and `reply.hijack()` skips that
    // entirely. Without this line the two hijacking routes were the ONLY /v1
    // endpoints with no correlation id on the response, which is exactly where
    // a consumer needs one: a stream that died mid-flight.
    reply.raw.setHeader('x-request-id', req.id);
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
      const result = await router.route(withHttpRequestId({
        label: `stream:${unit.unitType ?? unit.unitKey}`,
        unitKey: unit.unitKey,
        ...(unit.unitType ? { unitType: unit.unitType } : {}),
        org: req.auth.org,
        project: req.auth.project,
        messages: withSystemMessage(systemPrompt, [{ role: 'user', content: rendered }]),
        model: spec.model,
        effortLevel: spec.effortLevel,
        effortProfile: spec.effortProfile,
        // Client-disconnect OR process shutdown. `runtime.shutdownSignal` fires
        // when SHUTDOWN_GRACE_MS expires after a SIGTERM; without it in here the
        // grace bounded the BullMQ workers and nothing else, and `app.close()`
        // waited out the whole generation AFTER the window had already passed —
        // MEASURED at 25 s against a 2 s grace. The router adds its wall-clock
        // backstop as the third input (`services/ai/router/timeout-signal.ts`).
        signal: AbortSignal.any([abortCtrl.signal, app.runtime.shutdownSignal]),
        onDelta: (text) => writeFrame({ type: 'delta', text }),
        ...(spec.responseSchema !== undefined ? { responseSchema: spec.responseSchema } : {}),
        ...(spec.responseSchemaStrict ? { responseSchemaStrict: true } : {}),
        ...(spec.validators ? { validators: spec.validators } : {}),
        ...(spec.registryEntryId ? { registryEntryId: spec.registryEntryId } : {}),
        ...(spec.registryEntryVersion ? { promptVersion: spec.registryEntryVersion } : {}),
      }, req.id));
      const warnings = result.softCap
        ? [
            {
              code: 'BUDGET_SOFT_CAP' as const,
              message: `Budget is below 10% remaining for org=${req.auth.org}`,
            },
          ]
        : undefined;
      // Same additive projection as /sync — the `done` frame is contractually
      // the same payload, so it goes through the same helper.
      const usage = projectWireUsage(result.usage);
      writeFrame({
        type: 'done',
        text: result.content,
        parsed: result.parsed,
        modelUsed: result.model,
        provider: result.provider,
        costUsd: result.usage.estimatedCostUsd,
        ...(usage ? { usage } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        traceId: result.traceId,
        systemPromptApplied: systemPrompt !== undefined,
        ...(warnings ? { warnings } : {}),
        ...(retrievalTrace.length > 0 ? { retrievalTrace } : {}),
      });
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted;
      if (!isAbort) {
        // A real generation failure (not an abort) — emit a terminal error frame.
        // Spread, don't destructure: the classification carries optional
        // fields (`errorCode`, `retryAfterMs`) that must be OMITTED rather
        // than serialised as `null` when they don't apply.
        const classified = classifyStreamError(err);
        req.log.error({ err }, 'streamed generation failed');
        writeFrame({ type: 'error', ...classified });
      } else if (!abortCtrl.signal.aborted) {
        // Aborted, but NOT by the client (`abortCtrl` never fired). Our own
        // deadline/stall no longer lands here — the router throws
        // `ProviderTimeout`, which takes the `classifyStreamError` arm above
        // with `truncated`/`reason`. What remains is the process SHUTDOWN
        // signal; the client is listening, so tell it instead of silently
        // ending. Frame kept byte-identical to before.
        req.log.warn({ err }, 'streamed generation hit provider timeout backstop');
        writeFrame({
          type: 'error',
          code: 'ProviderTimeout',
          message: 'The upstream LLM provider exceeded the request timeout.',
        });
      }
      // else: genuine client disconnect — socket is gone, nothing to send.
    } finally {
      reply.raw.removeListener('close', onClose);
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  };
  app.post('/stream', GENERATE_ROUTE_CONFIG, spanRoute('POST /v1/generate/stream', streamHandler));

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
      const result = await cancelGeneration(
        req.params.requestId,
        { org: req.auth.org, project: req.auth.project },
        { queue: app.runtime.queues.generation, cancelBus: app.runtime.cancelBus },
      );
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

/** Stamp a `MappedGenerateError` onto the reply and send its body. */
function sendMapped(reply: FastifyReply, mapped: MappedGenerateError) {
  reply.code(mapped.status);
  for (const [k, v] of Object.entries(mapped.headers ?? {})) reply.header(k, v);
  return reply.send(mapped.body);
}

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

export default generateRoutes;
