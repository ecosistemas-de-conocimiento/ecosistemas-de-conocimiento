// SSE parsing test — feed a stream of bytes that includes a heartbeat plus
// a real event frame, then assert the typed handler fires with the correct
// payload.

import { describe, expect, it } from 'vitest';

import { AIClient } from './index.js';
import type { AppEvent } from './types.js';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe('AIClient.events', () => {
  it('parses SSE frames, skips heartbeats, dispatches typed events', async () => {
    const requestId = '11111111-1111-1111-1111-111111111111';
    const completedEvent = {
      type: 'generation.request.completed',
      requestId,
      org: 'o',
      status: 'completed',
      totalCostUsd: 0.01,
    } satisfies AppEvent;

    const stream = sseStream([
      ': ok\n\n',
      `data: ${JSON.stringify({
        type: 'generation.request.started',
        requestId,
        org: 'o',
        totalJobs: 1,
        estimatedCostUsd: 0.01,
      })}\n\n`,
      ': ping\n\n',
      `data: ${JSON.stringify(completedEvent)}\n\n`,
    ]);
    const fetchImpl: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });

    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl,
    });

    const received: AppEvent[] = [];
    const completed: AppEvent[] = [];
    const sse = client.events(`request:${requestId}:generations`);
    sse.onAny((e) => received.push(e));
    sse.on('generation.request.completed', (e) => completed.push(e));

    await sse.closed;

    expect(received).toHaveLength(2);
    expect(received[0]?.type).toBe('generation.request.started');
    expect(received[1]?.type).toBe('generation.request.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: 'generation.request.completed',
      requestId,
      status: 'completed',
    });
  });

  it('handles a frame split across chunks', async () => {
    const requestId = '22222222-2222-2222-2222-222222222222';
    const payload = JSON.stringify({
      type: 'generation.request.started',
      requestId,
      org: 'o',
      totalJobs: 1,
      estimatedCostUsd: 0.01,
    });
    // Break the data frame across two chunks.
    const chunks = [`data: ${payload.slice(0, 20)}`, `${payload.slice(20)}\n\n`];
    const stream = sseStream(chunks);
    const fetchImpl: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });

    const client = new AIClient({
      baseUrl: 'http://x',
      apiKey: 't',
      fetch: fetchImpl,
    });
    const received: AppEvent[] = [];
    const sse = client.events(`request:${requestId}:generations`);
    sse.onAny((e) => received.push(e));
    await sse.closed;
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('generation.request.started');
  });
});
