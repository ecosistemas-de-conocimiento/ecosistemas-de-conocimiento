// Fatal access-control helpers (Part 2 of the FE error-hardening mechanism).
//
// These are for GENUINE access gates — "you are not allowed here" or "this
// thing does not exist" — NOT for the degrade-to-empty case (see
// `./degrade.ts` for that). They throw SvelteKit `error(...)` with a
// STRUCTURED body so the top-level `+error.svelte` boundary can branch on
// `kind` and render the right copy + an escape-hatch CTA, instead of dumping a
// bare status string.
//
// Both helpers return `never`: TypeScript then knows control flow stops, so
// callers can write `const row = found ?? denyAccess({ module: 'chat' });`.
//
// NOTE on the Part-1 interaction: these throw a SvelteKit `HttpError`, not a
// backend/transient error. `hooks.server.ts handleError` only fires for
// *uncaught* errors and SvelteKit never routes thrown `HttpError`s through it —
// so deny throws render the boundary directly and never trip the Part-1 net.

import { error } from '@sveltejs/kit';

/** Optional call-to-action the boundary renders as an escape hatch. */
export interface ErrorCta {
  label: string;
  href: string;
}

export interface DenyAccessInput {
  /** Logical area the denial happened in (e.g. 'chat', 'document'). */
  module: string;
  /** Machine reason for logs / analytics (e.g. 'cross-user', 'forbidden'). */
  reason?: string;
  /** Human copy to show. Falls back to a generic message in the boundary. */
  message?: string;
  /** Override the default "back to chat" escape hatch. */
  cta?: ErrorCta;
}

export interface NotFoundInput {
  /** What was being looked up (e.g. 'chat', 'document'). Used in copy. */
  entity?: string;
  module?: string;
  message?: string;
  cta?: ErrorCta;
}

/**
 * Throw a structured 403. Use when a user is authenticated but genuinely not
 * allowed to touch this resource (e.g. it belongs to another user).
 *
 * If you instead want to HIDE a resource's existence, prefer `notFound()` so
 * you don't leak that the id is real.
 */
export function denyAccess(input: DenyAccessInput): never {
  throw error(403, {
    message: input.message ?? "You don't have access to this.",
    kind: 'access-denied',
    module: input.module,
    reason: input.reason,
    cta: input.cta,
  });
}

/**
 * Throw a structured 404. Use for resources that don't exist — or that you
 * want to PRESENT as non-existent to avoid leaking their existence
 * (403-as-404 existence-hiding). The boundary renders "not found" copy.
 */
export function notFound(input: NotFoundInput = {}): never {
  const entity = input.entity ?? 'page';
  throw error(404, {
    message: input.message ?? `We couldn't find that ${entity}.`,
    kind: 'not-found',
    module: input.module ?? entity,
    cta: input.cta,
  });
}
