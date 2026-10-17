// Zod schema for POST /v1/route — the capability router surface.
//
// GENERIC by design: the caller supplies the candidate surfaces at call time
// (id + description + optional schema). ai-service does NOT know any product's
// concrete capabilities — it just maps a question onto one of the supplied
// candidate ids via a single cheap LLM classification, and is FAIL-SAFE (any
// error / ambiguity → defaultRouteId, else candidates[0].id).
//
// Stays project-agnostic per ADR-0001: no product capability names here.

import { z } from './zod.js';

// One conversational turn — mirrors the loose chat-message shape products use.
// `content` is the only field the router actually consumes; role is advisory.
export const routeChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })
  .strict();
export type RouteChatMessageInput = z.infer<typeof routeChatMessageSchema>;

// One routable surface. `description` is what the classifier reasons over;
// `schema` is an optional structural hint (e.g. a table's columns) the prompt
// renders but does not validate against.
export const routeCandidateSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    schema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RouteCandidateInput = z.infer<typeof routeCandidateSchema>;

export const routeRequestSchema = z
  .object({
    question: z.string().min(1),
    candidates: z.array(routeCandidateSchema).min(1).max(50),
    history: z.array(routeChatMessageSchema).max(50).optional(),
    /**
     * Returned (with a fallback reason) on any error / ambiguity / invalid
     * routeId. When omitted the fail-safe target is `candidates[0].id`.
     */
    defaultRouteId: z.string().min(1).optional(),
    /** Optional override of the resolved effort tier (defaults to `quick`). */
    effortLevel: z.enum(['quick', 'standard', 'deep', 'maximum']).optional(),
    /** Optional explicit model override (rare; the registry/effort tier wins). */
    modelOverride: z.string().optional(),
  })
  .strict()
  // defaultRouteId, when supplied, must be one of the candidate ids — a typo'd
  // default would silently route everything to a non-existent surface.
  .refine(
    (v) => v.defaultRouteId === undefined || v.candidates.some((c) => c.id === v.defaultRouteId),
    { message: 'defaultRouteId must match one of the candidate ids', path: ['defaultRouteId'] },
  );
export type RouteRequestInput = z.infer<typeof routeRequestSchema>;

// Response shape — also the structured-output target forced on the LLM.
export interface RouteDecision {
  /** Always one of the supplied candidate ids (re-validated server-side). */
  routeId: string;
  /** One-sentence justification, or a fallback explanation when degraded. */
  reason: string;
  /** True when the default route was used instead of a model choice. */
  fallback?: boolean;
  /** Why the fallback happened. Present only when `fallback` is true. */
  fallbackCause?: RouteFallbackCause;
}

/**
 * Why `/v1/route` degraded to the default route:
 *  - `router_call_failed`: the call threw — provider 4xx/5xx, budget refusal,
 *    an unresolvable or unrenderable spec.
 *  - `router_unparseable`: the model answered but no `{ routeId }` could be read.
 *  - `router_invalid_route`: the model named an id that was not offered.
 */
export const ROUTE_FALLBACK_CAUSES = [
  'router_call_failed',
  'router_unparseable',
  'router_invalid_route',
] as const;
export type RouteFallbackCause = (typeof ROUTE_FALLBACK_CAUSES)[number];
