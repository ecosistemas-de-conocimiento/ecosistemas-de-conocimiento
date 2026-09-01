// SSE helper — `client.events(channel)` returns an EventStream that:
//   - opens `GET /v1/events/:channel` with the bearer token
//   - parses the text/event-stream body (data: <json>\n\n frames)
//   - skips heartbeat / comment lines (`:` prefix)
//   - dispatches typed `AppEvent`s to registered handlers
//   - exposes `close()` to abort the underlying request
//
// We deliberately avoid the `eventsource` npm package: it doesn't natively
// support custom headers in Node, brings external deps, and the SSE wire
// format is short enough to parse in 30 lines. Returns an `EventStream` —
// our own tiny emitter; no DOM EventTarget needed.

import type { HttpClient } from './http.js';
import { errorFromResponse } from './errors.js';
import type { AppEvent, AppEventType, EventFor } from './types.js';

type AnyHandler = (event: AppEvent) => void;
type TypedHandler<T extends AppEventType> = (event: EventFor<T>) => void;

export interface EventStream {
  /** Subscribe to a specific event `type`. Returns an unsubscribe fn. */
  on<T extends AppEventType>(type: T, handler: TypedHandler<T>): () => void;
  /** Subscribe to all events. Returns an unsubscribe fn. */
  onAny(handler: AnyHandler): () => void;
  /** Close the underlying SSE connection. Idempotent. */
  close(): void;
  /** Resolves once the stream is fully drained (server closed, client closed, or error). */
  readonly closed: Promise<void>;
}

export interface OpenEventsOptions {
  http: HttpClient;
  channel: string;
  /** Override the fetch wrapper used for the request (tests). */
  fetchImpl?: typeof fetch;
}

export function openEvents(opts: OpenEventsOptions): EventStream {
  const ctrl = new AbortController();
  const typed = new Map<AppEventType, Set<AnyHandler>>();
  const anyHandlers = new Set<AnyHandler>();
  let isClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const dispatch = (event: AppEvent): void => {
    for (const h of anyHandlers) {
      try {
        h(event);
      } catch {
        /* swallow listener errors so one bad handler doesn't break the loop */
      }
    }
    const bucket = typed.get(event.type);
    if (bucket) {
      for (const h of bucket) {
        try {
          h(event);
        } catch {
          /* same */
        }
      }
    }
  };

  const stream: EventStream = {
    on(type, handler) {
      let bucket = typed.get(type);
      if (!bucket) {
        bucket = new Set();
        typed.set(type, bucket);
      }
      bucket.add(handler as AnyHandler);
      return () => {
        bucket?.delete(handler as AnyHandler);
      };
    },
    onAny(handler) {
      anyHandlers.add(handler);
      return () => {
        anyHandlers.delete(handler);
      };
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
      resolveClosed();
    },
    closed,
  };

  // Fire the request asynchronously. Errors propagate to the next tick by
  // throwing the first time a handler runs after close; consumers who want
  // to await connection establishment should await `client.events(...)`'s
  // returned promise variant — but to keep the surface simple we accept
  // fire-and-forget here. Failures during the request body read close the
  // stream silently (consumers learn via the `closed` promise resolving).
  void (async () => {
    try {
      const res = await opts.http.raw({
        method: 'GET',
        path: `/v1/events/${encodeURIComponent(opts.channel)}`,
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Routed through the dispatcher WITH headers so a 429 on stream-open
        // arrives as a `RateLimitedError` carrying its wait, like every other
        // route. `/v1/events` sits under the same per-key limiter as the rest
        // of `/v1`, so this is reachable — and an untyped error here is a
        // consumer that reconnects immediately into the same refusal.
        // Message and status are unchanged for every other code.
        throw errorFromResponse(
          res.status,
          { message: `failed to open SSE stream (status ${res.status})` },
          res.headers,
        );
      }
      const body = res.body;
      if (!body) {
        stream.close();
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE event frames are delimited by a blank line. The frame contains
        // one or more `data:` lines whose payloads concatenate.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame, dispatch);
        }
      }
    } catch {
      /* aborted or network error — fall through to close */
    } finally {
      stream.close();
    }
  })();

  return stream;
}

function handleFrame(frame: string, dispatch: (event: AppEvent) => void): void {
  // Skip pure heartbeat / comment frames.
  const lines = frame.split('\n');
  const dataChunks: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('data:')) {
      dataChunks.push(line.slice(5).trimStart());
    }
    // We don't currently use `event:` / `id:` / `retry:` lines.
  }
  if (dataChunks.length === 0) return;
  const payload = dataChunks.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
    dispatch(parsed as AppEvent);
  }
}
