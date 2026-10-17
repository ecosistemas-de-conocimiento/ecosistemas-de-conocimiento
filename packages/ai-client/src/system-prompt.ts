// Fail loud when a consumer sent standing instructions and ai-service did not
// apply them as a real `system` message.
//
// The failure is SILENT without this: a deployment that predates
// system-prompt support, or a request builder that stopped sending
// `unit.systemPrompt`, still validates and still answers — in the right shape,
// without its rules. ai-service reports `systemPromptApplied: true` only when a
// real `system` message reached the model, so the check is `=== true`: an
// ABSENT flag (the old-deployment case) fails exactly like an explicit `false`.
//
// This keeps a typed error and a log-before-throw — some call sites
// swallow errors, and a swallowed throw must still leave a trace — without
// hard-coding `console`: pass a logger to get the line.

/** Logger shape for {@link assertSystemPromptApplied} (pino / Payload compatible). */
export interface SystemPromptGuardLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface AssertSystemPromptAppliedArgs {
  /** The system prompt the request carried. Falsy means none was sent: no-op. */
  sentSystemPrompt: string | null | undefined;
  /** `systemPromptApplied` from the response, read as-is (it may be absent). */
  applied: unknown;
  /** The consumer's label for the call: a unit key or a product surface. */
  surface: string;
  /** Optional: which endpoint answered, e.g. `/v1/generate/sync`. */
  endpoint?: string;
  /** Optional: logs one `error` line before the throw. */
  logger?: SystemPromptGuardLogger | null;
}

export class SystemPromptNotAppliedError extends Error {
  readonly surface: string;
  readonly endpoint: string | undefined;
  readonly applied: unknown;
  constructor(args: { surface: string; endpoint?: string; applied: unknown }) {
    const where = args.endpoint ? ` (${args.endpoint})` : '';
    super(
      `ai-service did not apply the system prompt for "${args.surface}"${where}: ` +
        `systemPromptApplied=${args.applied === undefined ? 'undefined' : JSON.stringify(args.applied)}. ` +
        'Either the ai-service deployment predates system-prompt support, or the ' +
        'request stopped sending unit.systemPrompt. The model ran WITHOUT its ' +
        'standing instructions — refusing to trust the output.',
    );
    this.name = 'SystemPromptNotAppliedError';
    this.surface = args.surface;
    this.endpoint = args.endpoint;
    this.applied = args.applied;
  }
}

/** Message of the log line {@link assertSystemPromptApplied} emits. */
export const SYSTEM_PROMPT_NOT_APPLIED_LOG_MESSAGE = 'ai-service did not apply the system prompt';

/**
 * Throw {@link SystemPromptNotAppliedError} when a system prompt was sent and
 * the response does not report `systemPromptApplied === true`.
 *
 * ```ts
 * const res = await client.generate.sync(req);
 * assertSystemPromptApplied({
 *   sentSystemPrompt: req.unit.systemPrompt,
 *   applied: res.systemPromptApplied,
 *   surface: 'extraction',
 * });
 * ```
 */
export function assertSystemPromptApplied(args: AssertSystemPromptAppliedArgs): void {
  if (!args.sentSystemPrompt) return;
  if (args.applied === true) return;
  const err = new SystemPromptNotAppliedError(args);
  args.logger?.error(
    {
      surface: args.surface,
      ...(args.endpoint ? { endpoint: args.endpoint } : {}),
      systemPromptApplied: args.applied,
      err: err.message,
    },
    SYSTEM_PROMPT_NOT_APPLIED_LOG_MESSAGE,
  );
  throw err;
}
