// Capability-router decision logic — PURE + synchronous, so it is trivially
// unit-testable without a network call. Project-agnostic:
// candidates are supplied at call time rather than a fixed 3-surface enum.
//
// The single invariant this module guarantees: the returned `routeId` is
// ALWAYS one of the supplied candidate ids. Any malformed model output, an
// id that isn't in the list, or a parse failure degrades to the fallback
// (defaultRouteId if provided, else candidates[0].id) with an explanatory
// reason. The router NEVER produces an unroutable decision.

import type { RouteCandidateInput, RouteDecision, RouteFallbackCause } from '../../contract/route.js';

/** Minimal slice of the generate result the decider reads. */
export interface RouterGenerateResult {
  text?: string;
  parsed?: unknown;
}

/** Resolve the fail-safe target id for a candidate list + optional default. */
export function fallbackRouteId(
  candidates: RouteCandidateInput[],
  defaultRouteId?: string,
): string {
  if (defaultRouteId && candidates.some((c) => c.id === defaultRouteId)) {
    return defaultRouteId;
  }
  // `candidates` is guaranteed non-empty by the Zod schema (min(1)).
  return candidates[0]!.id;
}

/** Build a fail-safe decision with an explanatory reason. */
export function fallbackDecision(
  candidates: RouteCandidateInput[],
  defaultRouteId: string | undefined,
  why: string,
  cause: RouteFallbackCause,
): RouteDecision {
  return {
    routeId: fallbackRouteId(candidates, defaultRouteId),
    reason: `fallback: ${why}`,
    fallback: true,
    fallbackCause: cause,
  };
}

// Extract a candidate object from the model output. Prefer the structured
// `parsed` field; fall back to JSON-parsing `text` (some providers return the
// object as fenced text even under a responseSchema). Returns null on any
// shape we can't read.
function extractObject(result: RouterGenerateResult): Record<string, unknown> | null {
  const p = result.parsed;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, unknown>;
  }
  const txt = (result.text ?? '').trim();
  if (!txt) return null;
  const cleaned = txt
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Map raw model output + the candidate list onto a SAFE {@link RouteDecision}.
 * Pure and synchronous. Guarantees `routeId` is one of the candidate ids.
 *
 * @param result         the (mocked or real) generate result
 * @param candidates     the candidate list the caller supplied (non-empty)
 * @param defaultRouteId optional fail-safe target id
 */
export function decideRoute(
  result: RouterGenerateResult,
  candidates: RouteCandidateInput[],
  defaultRouteId?: string,
): RouteDecision {
  const obj = extractObject(result);
  if (!obj) {
    return fallbackDecision(candidates, defaultRouteId, 'router produced unparseable output', 'router_unparseable');
  }

  const routeId = obj['routeId'];
  if (typeof routeId !== 'string' || !routeId.trim()) {
    return fallbackDecision(candidates, defaultRouteId, 'router omitted routeId', 'router_unparseable');
  }

  // Re-validate the chosen id against the supplied list — the model's string is
  // untrusted (it may hallucinate an id that was never offered).
  const matched = candidates.find((c) => c.id === routeId);
  if (!matched) {
    return fallbackDecision(
      candidates,
      defaultRouteId,
      `router chose '${routeId}', not one of the candidates`,
      'router_invalid_route',
    );
  }

  const reason = typeof obj['reason'] === 'string' && obj['reason'].trim()
    ? (obj['reason'] as string)
    : 'selected by capability router';
  return { routeId: matched.id, reason, fallback: false };
}

// JSON Schema forced as the structured-output target. Constrains the model to
// `{ routeId, reason }`. `routeId` is left as a free string here (not an enum)
// because the candidate ids are dynamic per request; `decideRoute` does the
// membership check. Kept narrow so cheap models comply reliably.
export const ROUTE_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['routeId', 'reason'],
  properties: {
    routeId: {
      type: 'string',
      description: 'El id EXACTO del candidato elegido, copiado TAL CUAL de la lista.',
    },
    reason: {
      type: 'string',
      description: 'Una frase corta que justifique la elección.',
    },
  },
} as const;

// Default router prompt template (Handlebars). Project-agnostic and in Spanish
// — every consumer's end users are Spanish-speaking, so an English fallback was
// the wrong default for the one prompt this service ships itself.
// Projects override prompt/model by registering a `capability-router`
// unit-type in the registry — `/v1/route` passes this constant in resolveSpec's
// `specDefault` (FLOOR) slot, so a registered row genuinely wins over it.
// `{{{candidates}}}` is pre-rendered by the route; `{{{history}}}` likewise.
//
// ⚠ TRIPLE stache on every interpolation. Handlebars HTML-escapes `{{ }}`, so
// a double stache would ship `it&#x27;s`, `&lt;`, `&amp;` and `&quot;` to the
// model — an escaping rule for web pages, applied to text no browser will ever
// render. `{{#if history}}` is a block helper, not an interpolation, and stays
// as-is.
export const DEFAULT_ROUTER_PROMPT = [
  'Enrutador de capacidades. Asignar la pregunta del usuario a EXACTAMENTE UNO de',
  'los candidatos de abajo y devolver su id. Tomar en cuenta la conversación previa.',
  '',
  'Reglas:',
  '- Copiar el id TAL CUAL de la lista; nunca inventar un id.',
  '- Ante la duda, elegir el candidato más general o más seguro.',
  '- Responder ÚNICAMENTE con el objeto estructurado { routeId, reason }.',
  '',
  'Candidatos:',
  '{{{candidates}}}',
  '{{#if history}}',
  'Conversación reciente:',
  '{{{history}}}',
  '{{/if}}',
  'Pregunta del usuario: {{{question}}}',
].join('\n');

/** Render the candidate list into the compact block the prompt expects. */
export function renderCandidates(candidates: RouteCandidateInput[]): string {
  return candidates
    .map((c) => {
      const schemaNote = c.schema
        ? ` [schema: ${JSON.stringify(c.schema)}]`
        : '';
      return `- ${c.id}: ${c.description}${schemaNote}`;
    })
    .join('\n');
}

/** Render history turns into a compact transcript block (most-recent last). */
export function renderHistory(
  history: Array<{ role: string; content: string }> | undefined,
): string {
  if (!history?.length) return '';
  return history.map((m) => `${m.role}: ${m.content}`).join('\n');
}
