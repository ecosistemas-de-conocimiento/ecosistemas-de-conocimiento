/**
 * M3 Step 5 — in-process typed event bus.
 *
 * Ported from a prototype `events/bus.ts`. Backed by `mitt` for the wildcard channel
 * plus per-type subscriptions. Preserves discriminated-union narrowing on
 * `AppEvent` so subscribers get the correctly-narrowed variant for the type
 * they listened for.
 *
 * The singleton is stashed on `globalThis` (not module scope) so HMR-style
 * re-instantiation in dev can't end up with multiple bus instances —
 * `/api/generate` and the SSE route must share one.
 */

import mittDefault, {
  type Emitter,
  type Handler,
  type WildcardHandler,
} from 'mitt';

import type { AppEvent, AppEventType, EventFor } from './types.js';

/**
 * Workaround: under `module: "NodeNext"` + `verbatimModuleSyntax: true`, the
 * default import of `mitt` is typed as a namespace (the runtime value IS the
 * factory function, but TS surfaces a synthetic-namespace shape because of
 * how mitt's `index.d.ts` is packaged). Re-cast through the namespace's
 * `default` member to recover the call signature.
 */
const mitt = mittDefault as unknown as typeof mittDefault.default;

/** Per-type handler — receives the narrowed event variant. */
export type EventHandler<T extends AppEventType> = (event: EventFor<T>) => void;

/** Wildcard handler — receives every event in the union. */
export type AnyEventHandler = (event: AppEvent) => void;

/**
 * The mitt event-record. Each `AppEventType` key maps to its narrowed payload.
 * This is what gives `on('trace.started', h)` the correct `h` parameter type.
 */
type AppEventRecord = {
  [K in AppEventType]: EventFor<K>;
};

export interface EventBus {
  /**
   * `event: AppEvent` (not generic). The discriminated union forces every
   * call site to satisfy a concrete variant — missing or extra fields fail
   * at the call expression itself.
   */
  emit(event: AppEvent): void;
  on<T extends AppEventType>(type: T, handler: EventHandler<T>): () => void;
  off<T extends AppEventType>(type: T, handler: EventHandler<T>): void;
  /** Subscribe to every event. Returns an unsubscribe fn. */
  onAny(handler: AnyEventHandler): () => void;
  /**
   * Count of registered listeners. Pass a specific type for that channel,
   * omit for the wildcard channel.
   */
  listenerCount(type?: AppEventType): number;
}

/**
 * Build a fresh, typed bus. Test code calls this directly to avoid singleton
 * bleed across cases.
 */
export function createEventBus(): EventBus {
  const emitter: Emitter<AppEventRecord> = mitt<AppEventRecord>();

  return {
    emit(event) {
      // mitt's emit signature widens to `unknown`; we re-narrow via the union.
      emitter.emit(
        event.type as AppEventType,
        event as AppEventRecord[AppEventType],
      );
    },

    on(type, handler) {
      emitter.on(type, handler as Handler<AppEventRecord[typeof type]>);
      return () => {
        emitter.off(type, handler as Handler<AppEventRecord[typeof type]>);
      };
    },

    off(type, handler) {
      emitter.off(type, handler as Handler<AppEventRecord[typeof type]>);
    },

    onAny(handler) {
      const wildcard: WildcardHandler<AppEventRecord> = (_type, event) => {
        handler(event as AppEvent);
      };
      emitter.on('*', wildcard);
      return () => {
        emitter.off('*', wildcard);
      };
    },

    listenerCount(type) {
      const key: keyof AppEventRecord | '*' = type ?? '*';
      const handlers = emitter.all.get(key);
      return handlers ? handlers.length : 0;
    },
  };
}

/**
 * Process-wide singleton. Stored on `globalThis` so HMR / multiple module
 * loads in dev can't fragment the bus.
 */
const BUS_KEY = '__ai_service_event_bus__';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: EventBus };

export function getEventBus(): EventBus {
  const g = globalThis as GlobalWithBus;
  if (!g[BUS_KEY]) g[BUS_KEY] = createEventBus();
  return g[BUS_KEY];
}

/** Test-only: reset the singleton so each test gets a clean bus. */
export function resetEventBusForTests(): void {
  delete (globalThis as GlobalWithBus)[BUS_KEY];
}
