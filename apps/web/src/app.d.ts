// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // Structured error body thrown by `$lib/server/deny.ts` (denyAccess /
    // notFound) and read by the top-level `+error.svelte` boundary. ALL fields
    // beyond `message` are optional so a bare `throw error(status, 'string')`
    // and SvelteKit-internal errors (which only provide `message`) still
    // satisfy this type.
    interface Error {
      message: string;
      /**
       * Machine-readable failure tag. Today only `ai_unavailable`, thrown by
       * the ai-service routes for a budget failure so the UI can render the
       * canonical wording without matching on message text.
       */
      code?: string;
      kind?: 'access-denied' | 'not-found' | 'generic';
      module?: string;
      reason?: string;
      cta?: { label: string; href: string };
    }
    interface Locals {
      user: import('$lib/server/auth').BackendUser | null;
      token: string | undefined;
      /**
       * Server-only: set by the evals runner (`$lib/server/evals/runner`) on
       * the event it hands to `POST /api/generate`. A browser request never
       * carries it — `locals` is built by `hooks.server.ts`, never from input.
       */
      evalTap?: (turn: import('$lib/server/evals/types').EvalTurnTap) => void;
    }
    interface PageData {
      user: import('$lib/server/auth').BackendUser | null;
      /**
       * ⚠ Presentation only — it decides whether the menu offers `/revision`.
       * The control is `routes/revision/+page.server.ts` plus the backend's
       * 404. Computed in `routes/+layout.server.ts`.
       */
      canReviewHolds?: boolean;
      /** ⚠ Presentation only — whether the menu offers `/miembros`. */
      canManageMembers?: boolean;
      /** ⚠ Presentation only — whether the menu offers `/ajustes`. */
      canEditFeatures?: boolean;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
