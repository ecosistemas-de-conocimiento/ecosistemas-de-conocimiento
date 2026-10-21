// Unit tests for `generateStream` — the client-side SSE reader.
//
// Mocks global `fetch` to return a `text/event-stream`-shaped Response whose
// body is a ReadableStream replaying `delta` / `done` / `error` frames (plus a
// heartbeat comment). No server, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateStream, AIServiceError } from './api';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const input = { sessionId: 's1', messages: [], docs: [] };

describe('generateStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onDelta in order and resolves with the authoritative done payload', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        ': ok\n\n',
        'data: {"type":"delta","text":"Hel"}\n\n',
        'data: {"type":"delta","text":"lo"}\n\n',
        ': ping\n\n',
        'data: {"type":"done","text":"Hello","modelUsed":"m","provider":"openrouter","costUsd":0.002,"traceId":"t1","messageId":"42"}\n\n',
      ]),
    );

    const deltas: string[] = [];
    const result = await generateStream(input, { onDelta: (t) => deltas.push(t) });

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result.text).toBe('Hello');
    expect(result.messageId).toBe('42');
    expect(result.modelUsed).toBe('m');
    expect(result.costUsd).toBe(0.002);
    expect(result.traceId).toBe('t1');
    // Posts to the streaming variant of the endpoint.
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/generate?stream=1');
  });

  it('UX #9: fires onOpen once, before the first delta; never on an HTTP failure', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"delta","text":"Hola"}\n\n',
        'data: {"type":"done","text":"Hola"}\n\n',
      ]),
    );
    const order: string[] = [];
    await generateStream(input, {
      onOpen: () => order.push('open'),
      onDelta: () => order.push('delta'),
    });
    expect(order).toEqual(['open', 'delta']);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, body: null, text: async () => '' });
    const onOpen = vi.fn();
    await expect(generateStream(input, { onOpen })).rejects.toBeInstanceOf(AIServiceError);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('throws AIServiceError on a terminal error frame', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"delta","text":"partial"}\n\n',
        'data: {"type":"error","code":"INTERNAL","message":"boom"}\n\n',
      ]),
    );

    const err = await generateStream(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIServiceError);
    expect((err as Error).message).toBe('boom');
  });

  it('throws when the stream ends without a done frame', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"type":"delta","text":"hi"}\n\n']),
    );
    await expect(generateStream(input)).rejects.toThrow('Stream ended without a completion');
  });

  it('surfaces a non-OK HTTP response as AIServiceError with the server message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
      text: () => Promise.resolve(JSON.stringify({ message: 'ai-service: down' })),
    } as unknown as Response);

    await expect(generateStream(input)).rejects.toThrow('ai-service: down');
  });

  it('propagates AbortError so callers can distinguish user cancel', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(generateStream(input)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
