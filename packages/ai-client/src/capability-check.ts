/**
 * The boot-time capability check, as a helper instead of a fourth copy.
 *
 * ── What was actually duplicated ─────────────────────────────────────────────
 * All four consumers already share the NEGOTIATION (`CapabilitiesAPI.negotiate`
 * in `./capabilities.ts`). What each one re-derived by hand is the WRAPPER
 * around it — 81 to 123 lines each, and the same five decisions every time:
 *
 *   1. run once per process, because Payload's `onInit` re-runs on every
 *      `next dev` hot-reload;
 *   2. skip when ai-service is not configured, because AI is optional
 *      fleet-wide (a product without ai-service must still boot);
 *   3. skip without a request when nothing is required — don't spend a
 *      round-trip confirming an empty list;
 *   4. read the mode from the environment (`capabilityModeFromEnv`);
 *   5. expose a reset seam so a test can run the check twice.
 *
 * The four copies had already drifted on (3): chat returns early on an empty
 * list, a consumer app and a consumer app do not, so a consumer that requires nothing still opens
 * a connection at every boot. Small, but it is the same drift mechanism that
 * produced three different callback verifiers.
 *
 * ── What stays in the product ────────────────────────────────────────────────
 * The required-capability LIST and the skip SENTENCE. Both are genuinely
 * per-product: the list must describe what that codebase actually does (an
 * aspirational entry blocks boots for nothing, a missing one lets the failure
 * through), and the skip message names the product's own supported offline mode
 * — frontend code's fixture path, chat's optional AI, a consumer app's `AI_SERVICE_ENABLED`
 * flag, a consumer app's "ai-service is REQUIRED, this is an ERROR". So they are
 * options, not defaults, and `skipLevel` exists because exactly one consumer
 * (a consumer app) treats an unconfigured ai-service as an error rather than a shrug.
 */

import {
  capabilityModeFromEnv,
  type CapabilityLogger,
  type CapabilityMode,
  type NegotiationResult,
} from './capabilities.js';

/** Just enough of `AIClient` to negotiate — so a test can pass a stub. */
export interface CapabilityNegotiator {
  capabilities: {
    negotiate(opts: {
      consumer: string;
      require: readonly string[];
      mode?: CapabilityMode;
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
   * The client to negotiate with, or `null`/`undefined` when ai-service is not
   * configured for this process. Also a function, for the same reason.
   */
  client: () => CapabilityNegotiator | null | undefined;
  /** What the log says when there is no client. Name the product's offline mode. */
  skipMessage: string;
  /**
   * Level for `skipMessage`. `info` for a product where AI is optional;
   * `error` where ai-service is a REQUIRED dependency and its absence is a
   * misconfiguration someone must fix (a consumer app). Never throws either way —
   * gating boot on a dependency crash-loops every replica, and readiness
   * reports it independently. Defaults to `info`.
   */
  skipLevel?: 'info' | 'error';
  /** Override the fleet rule (`strict` in production, `warn` elsewhere). */
  mode?: () => CapabilityMode;
}

/** A logger that may also carry `error` — a superset of `CapabilityLogger`. */
export interface CapabilityCheckLogger extends CapabilityLogger {
  error?(message: string): void;
}

export interface CapabilityCheck {
  /**
   * Run the check. Call from `onInit`.
   *
   *   - already run to a CONCLUSION in this process → returns immediately, no
   *     request. A run that threw, or that could not reach ai-service, learned
   *     nothing and does NOT latch: the next call checks again.
   *   - nothing required           → returns, no request.
   *   - no client configured       → logs `skipMessage`, returns.
   *   - reachable, missing         → THROWS in `strict`, warns in `warn`.
   *   - unreachable                → warns and continues, ALWAYS.
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

      const required = [...opts.require()];
      // Nothing required ⇒ nothing to ask. Don't spend a round-trip proving an
      // empty list is satisfied. Latched: the answer cannot change mid-process.
      if (required.length === 0) {
        alreadyChecked = true;
        return;
      }

      const client = opts.client();
      if (!client) {
        alreadyChecked = true;
        if (opts.skipLevel === 'error' && logger.error) logger.error(opts.skipMessage);
        else if (opts.skipLevel === 'error') logger.warn(opts.skipMessage);
        else if (logger.info) logger.info(opts.skipMessage);
        else logger.warn(opts.skipMessage);
        return;
      }

      const result = await client.capabilities.negotiate({
        consumer: opts.consumer,
        require: required,
        mode: (opts.mode ?? capabilityModeFromEnv)(),
        logger,
      });

      // 🔴 LATCHED AFTER THE AWAIT, AND ONLY WHEN WE LEARNED SOMETHING.
      //
      // Two ways the old `alreadyChecked = true` before the await was wrong,
      // and `unreachable` is the one that bites in `warn` mode (dev, local):
      //
      //   - `negotiate` THREW (strict, capability positively absent) — the
      //     latch is simply not reached, so the next boot attempt checks
      //     again. That is the point of refusing to start.
      //   - `negotiate` RESOLVED `unreachable` — it logs loudly and continues
      //     BY DESIGN, because an unreachable service is not evidence a
      //     capability is gone. But nothing was verified. Latching there
      //     consumed the one check the process would ever run: every later
      //     `onInit` (each `next dev` reload, each ai-service restart) short-
      //     circuited, and the guard read green having answered nothing.
      //
      // `missing` / `unsupported` in `warn` mode DO latch: the answer is
      // known, it was logged, and repeating it every reload is noise.
      if (result.status !== 'unreachable') alreadyChecked = true;
    },

    reset(): void {
      alreadyChecked = false;
    },
  };
}
