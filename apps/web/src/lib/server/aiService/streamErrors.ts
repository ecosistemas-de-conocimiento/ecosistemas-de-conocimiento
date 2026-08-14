/**
 * Budget handling for the STREAMING transport.
 *
 * ⚠ This is a genuinely different seam from `httpStatusFor`, not a duplicate.
 * Once ai-service has flushed the SSE headers it can no longer set an HTTP
 * status, so it reports a budget rejection as a terminal `error` FRAME carrying
 * a `code` string instead (`classifyStreamError` in ai-service's
 * `routes/generate.ts`). A status-code check will never fire on this path.
 *
 * It matters because chat streams BY DEFAULT: this frame — not the HTTP error
 * path — is what a real user hits when the budget runs out. The upstream
 * message names the org and quotes its remaining balance, and it used to be
 * passed straight through to the chat bubble.
 *
 * Lives in `aiService/` (rather than beside the route) so it is unit-testable:
 * this directory imports nothing from `@edc/*`, whereas the route
 * module does and therefore cannot be loaded in a test today.
 */

import {
  BudgetExceededError,
  BudgetNotConfiguredError,
  httpStatusFor,
  logBudgetFailure,
} from './errors';
import { AI_UNAVAILABLE_CODE } from './messages';
import type { AIWarning } from './schemas';

/**
 * ai-service `code` values on a terminal `error` frame that mean "a budget
 * stopped this turn". Mirrors ai-service's `classifyStreamError`.
 */
export const STREAM_BUDGET_CODES = new Set(['BudgetNotConfigured', 'BudgetExceeded']);

export type StreamFrame = Record<string, unknown>;

/**
 * Rewrite a terminal SSE `error` frame so a budget failure reaches the browser
 * as the canonical message instead of ai-service's English text.
 *
 * Non-budget error frames pass through UNTOUCHED — this must not become a
 * general-purpose message rewriter, or genuine diagnostics stop reaching
 * developers.
 *
 * Side effect: logs the real cause via the shared `logBudgetFailure`, so the
 * streaming and sync transports emit identical operator logs.
 */
export function sanitizeStreamErrorFrame(
  evt: StreamFrame,
  opts: { requesterOrgKey?: string | null; surface?: string } = {},
): StreamFrame {
  const code = typeof evt.code === 'string' ? evt.code : undefined;
  if (!code || !STREAM_BUDGET_CODES.has(code)) return evt;

  const surface = opts.surface ?? 'generate:stream';
  const org = typeof evt.org === 'string' ? evt.org : undefined;
  const upstreamMessage = typeof evt.message === 'string' ? evt.message : '';

  // Rebuild the typed error so the ONE mapping table and the ONE logging path
  // stay authoritative for both transports.
  const err =
    code === 'BudgetNotConfigured'
      ? new BudgetNotConfiguredError(upstreamMessage, { status: 402, bodyError: code, org })
      : new BudgetExceededError(upstreamMessage, { status: 402, bodyError: code, org });

  logBudgetFailure(err, surface);

  const mapped = httpStatusFor(err, { requesterOrgKey: opts.requesterOrgKey ?? null });
  return {
    type: 'error',
    code: mapped.code ?? AI_UNAVAILABLE_CODE,
    message: mapped.message,
    status: mapped.status,
  };
}

/**
 * Log ai-service's non-fatal advisories ONCE, server-side.
 *
 * Today the only code is `BUDGET_SOFT_CAP` (10% of budget left) — the early
 * warning that the hard failure is coming. Deliberately NOT shown to the user:
 * a healthy answer was produced, and "the budget is nearly gone" is an operator
 * concern. Wiring this to a real alert is a separate task.
 */
export function logAIWarnings(warnings: unknown, surface: string): void {
  if (!Array.isArray(warnings)) return;
  for (const w of warnings as AIWarning[]) {
    if (!w || typeof w !== 'object') continue;
    console.warn('[generate] ai-service warning', {
      aiWarningCode: w.code,
      aiWarningMessage: w.message,
      surface,
    });
  }
}
