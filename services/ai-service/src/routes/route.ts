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
import { routeRequestSchema } from '../schemas/route.js';

/** Registry unit-type projects register to override the router prompt/model. */
export const ROUTER_UNIT_TYPE = 'capability-router';

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
    // socket closes, abort the upstream provider call.
    const abortCtrl = new AbortController();
    const onClose = (): void => {
      if (!reply.sent) abortCtrl.abort();
    };
    req.raw.once('close', onClose);

    try {
      // Resolve the router spec. The built-in is the FLOOR (`specDefault`): a
      // registered `capability-router` unit-type (prompt/model/effort) wins
      // over it via the resolve precedence chain, and with no registered row
      // the built-in Spanish prompt + cheapest (`quick`) tier are used —
      // byte-identical to the pre-floor behaviour.
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
      req.log.info(
        { event: 'route.decided', routeId: decision.routeId, fellBack: decision.reason.startsWith('fallback:') },
        'capability route decided',
      );
      return decision;
    } catch (err) {
      // Client disconnected mid-call — socket is gone, nothing to send.
      if ((err as Error)?.name === 'AbortError' || abortCtrl.signal.aborted) {
        reply.code(499);
        return reply.send();
      }
      // FAIL-SAFE: any provider/budget/spec error degrades to the fallback
      // rather than surfacing a 5xx. The consumer always gets a routeId.
      req.log.warn({ err }, 'capability router call failed; returning fallback route');
      return fallbackDecision(
        candidates,
        defaultRouteId,
        `router call failed (${(err as Error)?.name ?? 'error'})`,
      );
    } finally {
      req.raw.removeListener('close', onClose);
    }
  });
};

export default routeRoutes;
