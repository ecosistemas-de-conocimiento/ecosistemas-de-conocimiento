// POST /v1/route — capability router. A peer of /v1/generate and /v1/retrieve.
//
// Single cheap LLM classification: given a question + a GENERIC candidate list,
// pick exactly one candidate id. Reuses the sync-generate plumbing (resolveSpec
// → renderPrompt → router.route) with a forced structured-output schema, the
// caller's bearer scope, budget reservation, and the model registry.
//
// FAIL-SAFE (non-negotiable): any error / ambiguity / invalid routeId →
// `defaultRouteId` (else candidates[0].id) with an explanatory reason. The
// endpoint NEVER 500s on a routable request — a routing failure must not break
// the consumer's chat turn.
//
// Project-agnostic per ADR-0001: candidates are supplied at call time. Projects
// override the router prompt/model by registering the `capability-router`
// unit-type (ROUTER_UNIT_TYPE) in the registry; absent that, the built-in
// spec (DEFAULT_ROUTER_PROMPT + quick effort) is used.
//
// ⚠ The built-in goes in `resolveSpec`'s `specDefault` (FLOOR) slot, never in
// `specOverride` (CEILING). It shipped in the ceiling slot from this file's
// first commit, which made every registered `capability-router` row resolve and
// then get discarded — the exact inverse of the sentence above, and of the
// published OpenAPI description. Regression cover lives in `route.test.ts`
// ("registry precedence — real resolveSpec"), which must NOT mock `resolveSpec`.

import type { FastifyPluginAsync } from 'fastify';

import { db } from '../db/client.js';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  GENERATE_RATE_LIMIT_MAX,
  V1_RATE_LIMIT_WINDOW,
} from '../server-limits.js';
import { resolveSpec } from '../services/registry/resolve.js';
import { renderPrompt } from '../services/render/handlebars.js';
import { createOpenRouter } from '../services/ai/router/openrouter.js';
import {
  DEFAULT_ROUTER_PROMPT,
  ROUTE_RESPONSE_SCHEMA,
  decideRoute,
  fallbackDecision,
  renderCandidates,
  renderHistory,
} from '../services/routing/decide.js';
import { routeRequestSchema } from '../contract/route.js';
import { isAiServiceError } from '../errors/base.js';
import { recordRouteFallback } from '../metrics/llm.js';

/** Registry unit-type projects register to override the router prompt/model. */
export const ROUTER_UNIT_TYPE = 'capability-router';

/**
 * The router's built-in model for the `quick` tier — the BOTTOM of the model
 * precedence, so no project setting regresses. Highest first:
 *   1. request `modelOverride`
 *   2. registered `capability-router` row: `model`
 *   3. registered row: `effortProfiles[level].model`
 *   4. `project_configs.defaultModel`
 *   5. `project_configs.effortProfiles[level].model`
 *   6. the tier's built-in model: this constant for `quick` (the router's
 *      default tier), `EFFORT_PROFILES[level].model` for any other level.
 * It reaches resolveSpec as `defaultEffortProfiles.quick.model`, not as
 * `specDefault.model`, which would outrank 4 and 5. A prompt-only row (model
 * null) and no row at all both get it.
 *
 * Was deepseek-chat-v3.1. Routing sits in front of every answer, and the user
 * waits on it. Evidence, measured by REPLAYING the rendered router prompt through
 * /v1/generate/sync: 14 questions, identical messages plus one line naming JSON. deepseek-chat-v3.1 p50 4.3 s,
 * max 9.6 s, 14/14 correct; gpt-4o-mini p50 1.4 s, max 2.0 s, 14/14 correct,
 * about 40 % of the cost. gpt-4o-mini needs the JSON-mode hint in
 * `services/ai/router/adapters/openrouter.ts`.
 */
export const ROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

// Same tighter rate-limit cap as the generate surface — this hits the provider.
const ROUTE_ROUTE_CONFIG = {
  bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  config: {
    rateLimit: {
      max: GENERATE_RATE_LIMIT_MAX,
      timeWindow: V1_RATE_LIMIT_WINDOW,
    },
  },
} as const;

const routeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', ROUTE_ROUTE_CONFIG, async (req, reply) => {
    const parsed = routeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // A malformed REQUEST (bad body) is a 400 — there is nothing to route.
      // This is distinct from the fail-safe: once we have a valid candidate
      // list, we never error out, we degrade to the fallback.
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { question, candidates, history, defaultRouteId, effortLevel, modelOverride } =
      parsed.data;

    // Client-abort propagation (same pattern as /v1/generate/sync): if the
    // connection closes, abort the upstream provider call.
    //
    // 🔴 THE LISTENER GOES ON `reply.raw`, NEVER ON `req.raw`. The request
    // stream's `'close'` reports the BODY being consumed, not the client
    // hanging up — it can fire after this line while the client is still
    // waiting. On `req.raw` every /v1/route call aborted itself and answered
    // 499 (measured: 15/15), and consumers silently fell back
    // to their default route. The ServerResponse is the object whose `'close'`
    // means "the connection went away". See the note in generate.ts.
    const abortCtrl = new AbortController();
    const onClose = (): void => {
      if (!reply.sent && !reply.raw.writableEnded) abortCtrl.abort();
    };
    reply.raw.once('close', onClose);

    try {
      // Resolve the router spec. The built-in is the FLOOR (`specDefault`): a
      // registered `capability-router` unit-type (prompt/model/effort) wins
      // over it via the resolve precedence chain, and with no registered row
      // the built-in Spanish prompt and the `quick` tier are used, with
      // ROUTER_DEFAULT_MODEL as that tier's model.
      const spec = await resolveSpec(db, {
        org: req.auth.org,
        project: req.auth.project,
        unitType: ROUTER_UNIT_TYPE,
        unitKey: ROUTER_UNIT_TYPE,
        specDefault: {
          promptTemplate: DEFAULT_ROUTER_PROMPT,
          effortLevel: 'quick',
          responseSchema: ROUTE_RESPONSE_SCHEMA,
        },
        requestOverrides: {
          ...(effortLevel ? { effortLevel } : {}),
          ...(modelOverride ? { modelOverride } : {}),
        },
        // Bottom of the model precedence — see ROUTER_DEFAULT_MODEL.
        defaultEffortProfiles: { quick: { model: ROUTER_DEFAULT_MODEL } },
      });

      const rendered = renderPrompt(spec.promptTemplate, {
        question,
        candidates: renderCandidates(candidates),
        history: renderHistory(history),
      });

      const router = createOpenRouter();
      const result = await router.route({
        label: `route:${ROUTER_UNIT_TYPE}`,
        unitKey: ROUTER_UNIT_TYPE,
        unitType: ROUTER_UNIT_TYPE,
        org: req.auth.org,
        project: req.auth.project,
        messages: [{ role: 'user', content: rendered }],
        model: spec.model,
        effortLevel: spec.effortLevel,
        effortProfile: spec.effortProfile,
        signal: abortCtrl.signal,
        // Force structured output regardless of what the registry entry carries
        // — the route contract is fixed at { routeId, reason }.
        responseSchema: ROUTE_RESPONSE_SCHEMA,
        ...(spec.registryEntryId ? { registryEntryId: spec.registryEntryId } : {}),
        ...(spec.registryEntryVersion ? { promptVersion: spec.registryEntryVersion } : {}),
      });

      // Pure, fail-safe mapping. Re-validates the chosen id against the list.
      const decision = decideRoute(
        { text: result.content, parsed: result.parsed },
        candidates,
        defaultRouteId,
      );
      if (decision.fallback) {
        req.log.warn(
          { event: 'route.fallback', cause: decision.fallbackCause, routeId: decision.routeId, model: spec.model, reason: decision.reason },
          'capability router fell back to the default route',
        );
        recordRouteFallback(decision.fallbackCause ?? 'router_unparseable');
      } else {
        req.log.info({ event: 'route.decided', routeId: decision.routeId }, 'capability route decided');
      }
      return decision;
    } catch (err) {
      // OUR provider timeout is NOT degraded to the fallback: a fallback 200
      // would hide a cut-off call, which is what the decision (audit
      // §3 item 5) rules out on every transport. 504, unbilled, `truncated`.
      // Before this, the deadline arrived as an `AbortError` and answered 499
      // as if the client had hung up.
      if (isAiServiceError(err) && err.code === 'ERR_PROVIDER_TIMEOUT') {
        req.log.warn({ err }, 'capability router call hit the provider timeout');
        return reply.code(err.status).send(err.toBody());
      }
      // Client disconnected mid-call — socket is gone, nothing to send.
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        reply.code(499);
        return reply.send();
      }
      // FAIL-SAFE, BUT LOUD: any provider/budget/spec error still answers 200
      // with the default route (consumers depend on always getting a routeId),
      // and the answer says `fallback: true` + `fallbackCause`, a warn line is
      // logged and `ai_route_fallback_total` ticks. A provider
      // 400 on every call hid behind 14/14 silent fallbacks.
      const errorName = (err as Error)?.name ?? 'error';
      const decision = fallbackDecision(
        candidates,
        defaultRouteId,
        `router call failed (${errorName})`,
        'router_call_failed',
      );
      req.log.warn(
        { event: 'route.fallback', cause: 'router_call_failed', errorName, routeId: decision.routeId, err },
        'capability router call failed; returning fallback route',
      );
      recordRouteFallback('router_call_failed');
      return decision;
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  });
};

export default routeRoutes;
