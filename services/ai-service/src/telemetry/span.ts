// Manual spans for the generation routes.
//
// Why manual and why HERE: the provider call itself lives in
// `src/services/ai/router/router.ts`, and the span wraps the whole route
// handler instead. That is the honest boundary — it measures what the caller
// waited for, which is the number an operator asks about first. A finer
// per-provider-call span is a later, additive change inside the router.
//
// Cost when telemetry is off: `trace.getTracer()` returns the API's no-op
// tracer, `startActiveSpan` runs the callback with a non-recording span, and
// every `setAttribute` is a no-op method call. There is no branch to skip and
// nothing to configure.
//
// 🔴 NEVER PUT A RAW BEARER TOKEN ON A SPAN. `apiKeyId` is the truncated
// SHA-256 fingerprint minted by `deriveApiKeyId` in `src/plugins/auth.ts`; it
// is the only key-shaped value allowed here, and it is one-way.

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { errSummary, safeErrMessage } from '../errors/log-safe.js';

import { serviceName } from './config.js';

/**
 * Attribute keys, in one place so a rename cannot drift across routes.
 *
 * 🔴 `httpRequestId` is `ai.http_request_id`, NOT `ai.request_id`. In this
 * codebase "requestId" already means `generation_requests.id` — it is on the
 * wire as `LaunchGenerationResult.requestId`, in the event-bus channel name
 * `request:<uuid>:generations`, and on the job. Fastify's per-HTTP-request id
 * is a DIFFERENT identifier with a different lifetime (one HTTP call, not one
 * batch), so it gets its own name at every layer.
 */
export const ATTR = {
  org: 'ai.org',
  project: 'ai.project',
  apiKeyId: 'ai.api_key_id',
  unitType: 'ai.unit_type',
  unitKey: 'ai.unit_key',
  model: 'ai.model',
  httpRequestId: 'ai.http_request_id',
} as const;

export interface RouteSpanContext {
  org: string;
  project?: string | undefined;
  /** SHA-256 fingerprint of the bearer token. Never the token. */
  apiKeyId?: string | undefined;
  unitType?: string | undefined;
  unitKey?: string | undefined;
  /** Fastify's `req.id` — the same value the request logger prints. */
  httpRequestId?: string | undefined;
}

/** Handle handed to the wrapped body for attributes only known mid-flight. */
export interface RouteSpanHandle {
  /** The resolved model, known only after `resolveSpec`. */
  setModel(model: string | undefined): void;
  /** Unit identity, known only after the request body validates. */
  setUnit(unitType: string | undefined, unitKey: string | undefined): void;
  span: Span;
}

function tracer() {
  return trace.getTracer(serviceName());
}

/**
 * Run `fn` inside an active span named `name`, stamped with the caller's
 * tenancy attributes. Records and re-throws on failure so an error is visible
 * on the span rather than only in the log.
 */
export async function withRouteSpan<T>(
  name: string,
  ctx: RouteSpanContext,
  fn: (handle: RouteSpanHandle) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    span.setAttribute(ATTR.org, ctx.org);
    if (ctx.project !== undefined) span.setAttribute(ATTR.project, ctx.project);
    if (ctx.apiKeyId !== undefined) span.setAttribute(ATTR.apiKeyId, ctx.apiKeyId);
    if (ctx.unitType !== undefined) span.setAttribute(ATTR.unitType, ctx.unitType);
    if (ctx.unitKey !== undefined) span.setAttribute(ATTR.unitKey, ctx.unitKey);
    if (ctx.httpRequestId !== undefined) span.setAttribute(ATTR.httpRequestId, ctx.httpRequestId);
    const handle: RouteSpanHandle = {
      span,
      setModel(model) {
        if (model !== undefined) span.setAttribute(ATTR.model, model);
      },
      setUnit(unitType, unitKey) {
        if (unitType !== undefined) span.setAttribute(ATTR.unitType, unitType);
        if (unitKey !== undefined) span.setAttribute(ATTR.unitKey, unitKey);
      },
    };
    try {
      return await fn(handle);
    } catch (err) {
      // Spans leave the process like log lines: a database error's message
      // and stack may quote a row, so the exception event carries only what
      // a log line may (`errors/log-safe.ts`).
      span.recordException({ name: errSummary(err), message: safeErrMessage(err) });
      span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrMessage(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap a Fastify handler in a route span AT THE REGISTRATION SITE.
 *
 * 🔴 WHY THIS EXISTS RATHER THAN AN INLINE `withRouteSpan(...)` INSIDE EACH
 * HANDLER: calling `withRouteSpan` in the handler body puts the whole handler
 * inside a callback, which re-indents every line of it. The first cut of this
 * change produced a 626-line diff on `routes/generate.ts` of which ~64 lines
 * were semantic — the reviewer's only options were to read 560 lines of moved
 * whitespace or to trust it. Applying the wrapper where the route is REGISTERED
 * leaves the handler body at its original indentation, so the diff shows the
 * behaviour change and nothing else. Keep it that way.
 *
 * The tenancy attributes come off `req` (auth runs at `onRequest`, so
 * `req.auth` is populated before any handler). Everything known only mid-flight
 * — the resolved model, the unit identity from the validated body — is set
 * through the `RouteSpanHandle` third argument.
 */
export function spanRoute<Req extends FastifyRequest, Rep extends FastifyReply, T>(
  name: string,
  handler: (req: Req, reply: Rep, otel: RouteSpanHandle) => Promise<T>,
): (req: Req, reply: Rep) => Promise<T> {
  return (req, reply) =>
    withRouteSpan(
      name,
      {
        org: req.auth.org,
        project: req.auth.project,
        apiKeyId: req.auth.apiKeyId,
        httpRequestId: req.id,
      },
      (otel) => handler(req, reply, otel),
    );
}
