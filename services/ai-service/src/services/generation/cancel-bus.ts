// Redis pub/sub channel for fast-path cancel propagation across worker pods.
//
// Design (see plan/cancellation-cost-accounting.md): cancelGeneration writes
// status='cancelled' to Postgres FIRST — that's the authoritative cancel.
// AFTER the DB commit, it publishes the requestId on the `gen:cancel` channel.
// Every worker pod subscribes; whichever has the in-flight AbortController
// for that requestId aborts it. The worker's post-LLM-call parent.status
// re-read remains in place as the safety net for missed messages.
//
// Failure modes (all degrade to today's behaviour, never below):
//   - Publish throws → swallowed; DB write already won the race.
//   - Redis disconnected on subscriber → ioredis auto-reconnects; messages
//     during the gap are lost forever (pub/sub has no replay) → post-call
//     re-read still catches the cancel.
//   - Pod restart → in-flight map is per-pod ephemeral state; new pod picks
//     up from BullMQ and registers its own controller.

import { Redis } from 'ioredis';

export const CANCEL_CHANNEL = 'gen:cancel';

export type CancelHandler = (requestId: string) => void;

export interface CancelBus {
  /** Subscribe + start receiving. Idempotent across calls. */
  start(): Promise<void>;
  /** Publish a cancel hint. Best-effort: errors are swallowed + logged. */
  publish(requestId: string): Promise<void>;
  /** Register a callback for incoming cancel messages. */
  onCancel(handler: CancelHandler): () => void;
  /** Tear down both connections. */
  stop(): Promise<void>;
}

/**
 * Production-grade implementation. Uses two ioredis connections:
 *   - `pub` — duplexed; can issue any command including PUBLISH.
 *   - `sub` — switched into subscribe-mode on `start()`; can only SUBSCRIBE /
 *     UNSUBSCRIBE / receive messages, per Redis protocol.
 *
 * Two connections is the documented ioredis pattern for pub/sub — the
 * subscribe-state connection cannot also run normal commands.
 *
 * Exported so the integration test suite can construct two bus instances
 * pointing at the same Redis (simulating two worker pods) and assert
 * cross-instance message delivery. Production goes through `Runtime.cancelBus`
 * (`src/runtime.ts`) — ONE bus per process, shared by the HTTP cancel route and
 * the in-process generation worker, which is what makes the fast path work at
 * all: the route publishes on the same object the worker subscribed with.
 */
export class RedisCancelBus implements CancelBus {
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private handlers = new Set<CancelHandler>();
  private started = false;
  private stopped = false;

  constructor(private readonly redisUrl: string) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.pub = new Redis(this.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.sub = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null, // subscriber stays connected; let ioredis reconnect indefinitely
      enableReadyCheck: true,
    });

    // Loud logging so a flaky subscriber is visible — the post-call re-read
    // hides the symptom, so we'd never notice the fast-path is degraded.
    this.sub.on('error', (err) => {
      console.warn(`[cancel-bus] subscriber error: ${err.message}`);
    });
    this.sub.on('reconnecting', () => {
      console.warn('[cancel-bus] subscriber reconnecting');
    });
    this.sub.on('ready', () => {
      // After reconnect ioredis re-subscribes automatically, but log so we
      // can correlate windows of missed messages with deploy / Redis blips.
      console.info('[cancel-bus] subscriber ready');
    });

    this.sub.on('message', (channel, message) => {
      if (channel !== CANCEL_CHANNEL) return;
      if (typeof message !== 'string' || message.length === 0) return;
      for (const h of this.handlers) {
        try {
          h(message);
        } catch (err) {
          console.error(
            `[cancel-bus] handler threw for requestId=${message}: ${(err as Error).message}`,
          );
        }
      }
    });

    await this.sub.subscribe(CANCEL_CHANNEL);
  }

  async publish(requestId: string): Promise<void> {
    if (!this.pub || this.stopped) return;
    try {
      await this.pub.publish(CANCEL_CHANNEL, requestId);
    } catch (err) {
      // The DB write already happened; pub/sub is just the wake-up hint.
      // Post-LLM-call re-read is the correctness safety net.
      console.warn(
        `[cancel-bus] publish failed for requestId=${requestId}: ${(err as Error).message}`,
      );
    }
  }

  onCancel(handler: CancelHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.handlers.clear();
    const closers: Promise<unknown>[] = [];
    if (this.sub) closers.push(this.sub.quit().catch(() => undefined));
    if (this.pub) closers.push(this.pub.quit().catch(() => undefined));
    await Promise.allSettled(closers);
    this.sub = null;
    this.pub = null;
  }
}

// ── construction ────────────────────────────────────────────────────────────
//
// 🔴 WAS A SINGLETON (`getCancelBus()` + `resetCancelBusForTests()`). The
// module-scope cache meant "which bus does this cancel publish on?" was decided
// by import order, and a test could only swap it by resetting global state.
// `createCancelBus(config)` returns a value; `createRuntime()` calls it once.

export function createCancelBus(config: { REDIS_URL: string }): CancelBus {
  return new RedisCancelBus(config.REDIS_URL);
}
