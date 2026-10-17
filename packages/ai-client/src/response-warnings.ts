// Log ai-service's advisory `warnings?: {code, message}[]` once, at `warn`.
//
// Every budget-reserving response (`/v1/generate`, `/v1/generate/sync`,
// `/v1/embed`, the stream `done` frame) may carry it. Today the one code is
// `BUDGET_SOFT_CAP`, sent when an org drops below 10% of its budget — the last
// quiet signal before the hard 402. Wiring an alert to it stays the product's job.

import type { ResponseWarning } from './types.js';

/** Logger shape for {@link logResponseWarnings} (pino / Payload compatible). */
export interface ResponseWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Message of each log line {@link logResponseWarnings} emits. */
export const RESPONSE_WARNING_LOG_MESSAGE = 'ai-service warning';

/**
 * Log each warning as `{ aiWarningCode, aiWarningMessage, surface }` at `warn`.
 *
 * A no-op when there are none (the usual case) or no logger. Tolerates an
 * untrusted shape — a non-array, null entries, non-string fields — because the
 * field is often read off raw JSON or an SSE frame.
 */
export function logResponseWarnings(
  logger: ResponseWarningLogger | null | undefined,
  warnings: readonly ResponseWarning[] | null | undefined,
  surface: string,
): void {
  if (!logger || !Array.isArray(warnings)) return;
  for (const w of warnings as readonly unknown[]) {
    if (!w || typeof w !== 'object') continue;
    const { code, message } = w as Record<string, unknown>;
    logger.warn(
      {
        aiWarningCode: typeof code === 'string' ? code : '',
        aiWarningMessage: typeof message === 'string' ? message : '',
        surface,
      },
      RESPONSE_WARNING_LOG_MESSAGE,
    );
  }
}
