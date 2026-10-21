/**
 * The boot-time capability check, as a helper instead of a fourth copy.
 *
 * ── What was actually duplicated ─────────────────────────────────────────────
 * All four consumers already share the NEGOTIATION (`CapabilitiesAPI.negotiate`
 * in `./capabilities.ts`). What each one re-derived by hand is the WRAPPER
 * around it — the same decisions every time:
 *
 *   1. run once per process, because Payload's `onInit` re-runs on every
 *      `next dev` hot-reload;
 *   2. fail the boot when ai-service is not configured — it is a REQUIRED
 *      dependency, and a hard dependency fails boot (0.32.0);
 *   3. expose a reset seam so a test can run the check twice.
 *
 * ── Strict in every environment (0.32.0) ─────────────────────────────────────
 * There is no `warn` mode, no skip path and no `AI_CAPABILITY_MODE` override.
 * `run()` resolves only when ai-service is configured, reachable within the
 * startup window, and has every required capability. Anything else throws.
 * An empty `require` list still probes: it proves ai-service is reachable.
 *
 * ── What stays in the product ────────────────────────────────────────────────
 * The required-capability LIST. It must describe what that codebase actually
 * does: an aspirational entry blocks boots for nothing, a missing one lets the
 * failure through.
 */

import {
  type CapabilityLogger,
  type NegotiationResult,
} from './capabilities.js';

/** Just enough of `AIClient` to negotiate — so a test can pass a stub. */
export interface CapabilityNegotiator {
  capabilities: {
    negotiate(opts: {
      consumer: string;
      require: readonly string[];
      logger?: CapabilityLogger;
    }): Promise<NegotiationResult>;
  };
}

export interface CapabilityCheckOptions {
  /** Consumer name for the error message ("chat", "web", …). */
  consumer: string;
  /**
   * What this build cannot run without, read at CALL time.
   *
   * 🔴 A FUNCTION, not an array, on purpose. chat's list depends on
   * `PUBLIC_CHAT_BACKEND_URL`; a value captured at module scope is captured as
   * a side effect of `import`, before any test hook can change it.
   */
  require: () => readonly string[];
  /**
   * The client to negotiate with. Returning `null`/`undefined` (ai-service not
   * configured for this process) makes `run()` THROW. Also a function, for the
   * same reason as `require`.
   */
  client: () => CapabilityNegotiator | null | undefined;
}

/** A logger that may also carry `error` — a superset of `CapabilityLogger`. */
export interface CapabilityCheckLogger extends CapabilityLogger {
  error?(message: string): void;
}

export interface CapabilityCheck {
  /**
   * Run the check. Call from `onInit`.
   *
   *   - already passed in this process → returns immediately, no request.
   *   - no client configured           → THROWS.
   *   - unreachable after the window   → THROWS (`CapabilityNegotiationError`).
   *   - reachable, missing/unsupported → THROWS (`CapabilityNegotiationError`).
   *   - reachable, has everything      → resolves, and latches.
   *
   * A run that threw does NOT latch: the next call checks again.
   */
  run(logger: CapabilityCheckLogger): Promise<void>;
  /** Test seam: let the check run again in the same process. */
  reset(): void;
}

/**
 * Build a once-per-process capability check.
 *
 * The `alreadyChecked` latch is per returned object, not module-global, so two
 * checks in one process (a test and the app, say) do not silence each other —
 * which a shared module-level flag would do, and which is the kind of
 * cross-talk that makes a boot guard look green while never having run.
 */
export function createCapabilityCheck(opts: CapabilityCheckOptions): CapabilityCheck {
  let alreadyChecked = false;

  return {
    async run(logger: CapabilityCheckLogger): Promise<void> {
      if (alreadyChecked) return;

      const client = opts.client();
      if (!client) {
        throw new Error(
          `${opts.consumer}: ai-service is not configured (no client). ai-service is a ` +
            `required dependency; set AI_SERVICE_URL and its API key. Refusing to start.`,
        );
      }

      // Throws on every outcome except `ok`, so reaching the latch means the
      // check passed.
      await client.capabilities.negotiate({
        consumer: opts.consumer,
        require: [...opts.require()],
        logger,
      });
      alreadyChecked = true;
    },

    reset(): void {
      alreadyChecked = false;
    },
  };
}
