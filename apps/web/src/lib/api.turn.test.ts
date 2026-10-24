// Unit tests for `runTurn` — one chat turn end to end on the client: stream,
// fall back to sync, and recover an answer the server saved after the
// browser lost the connection.
//
// The first case replays run 1 of the dev check on 2026-10-23 (47b140c): the
// stream request died before its headers, the sync fallback died too, and the
// server had still saved the answer. The user saw "No se pudo obtener la
// respuesta" for an answer that existed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTurn, userFacingError, TURN_FAILED_MESSAGE, AIServiceError } from './api';

const input = { sessionId: 's1', messages: [{ role: 'user' as const, content: 'hola' }] };
const fast = { recoverAttempts: 3, recoverIntervalMs: 0 };

function sse(frames: string[], opts: { failAfter?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const queue = [...frames];
  // Pull-based so the frames are read BEFORE the failure: `controller.error()`
  // discards anything still queued.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (opts.failAfter) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** The session's saved messages, as GET /api/sessions/:id/messages returns them. */
function savedMessages(docs: Record<string, unknown>[]): Response {
  return jsonResponse(200, { docs });
}

const savedAnswer = {
  id: 99,
  role: 'assistant',
  content: 'La respuesta guardada [1].',
  generationMeta: { traceId: 't9', modelUsed: 'm', provider: 'p', costUsd: 0.001 },
  provenance: { chunks: [] },
};

describe('runTurn', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('run 1 replay: both requests drop, the saved answer is shown instead of an error', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // stream
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // sync fallback
      // Not saved yet on the first look, saved on the second.
      .mockResolvedValueOnce(savedMessages([{ id: 1, role: 'user', content: 'hola' }]))
      .mockResolvedValueOnce(savedMessages([{ id: 1, role: 'user', content: 'hola' }, savedAnswer]));

    const result = await runTurn(input, { knownMessageIds: ['1'], ...fast });

    expect(result.text).toBe('La respuesta guardada [1].');
    expect(result.messageId).toBe('99');
    expect(result.traceId).toBe('t9');
    expect(result.provenance).toEqual({ chunks: [] });
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/sessions/s1/messages');
  });

  it('ignores assistant messages the conversation already had', async () => {
    const old = { ...savedAnswer, id: 7, content: 'respuesta anterior' };
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(savedMessages([old]));

    const err = await runTurn(input, { knownMessageIds: ['7'], ...fast }).catch((e) => e);

    expect(err).toBeInstanceOf(AIServiceError);
    expect(userFacingError(err)).toBe(TURN_FAILED_MESSAGE);
    // stream + sync + 3 looks at the saved conversation
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('a stream that ends with no completion falls back to sync', async () => {
    fetchMock
      .mockResolvedValueOnce(sse([': ok\n\n']))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'sync answer', messageId: '5' }));

    const result = await runTurn(input, { knownMessageIds: [], ...fast });

    expect(result.text).toBe('sync answer');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/generate');
  });

  it('a connection lost mid-answer restarts the turn on sync instead of failing', async () => {
    fetchMock
      .mockResolvedValueOnce(sse(['data: {"type":"delta","text":"Hal"}\n\n'], { failAfter: true }))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'Hola completo', messageId: '6' }));
    const deltas: string[] = [];
    const onRestart = vi.fn();

    const result = await runTurn(input, {
      knownMessageIds: [],
      onDelta: (t) => deltas.push(t),
      onRestart,
      ...fast,
    });

    expect(deltas).toEqual(['Hal']);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Hola completo');
  });

  it('a server error after part of the answer still fails, without a second generation', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        'data: {"type":"delta","text":"Hal"}\n\n',
        'data: {"type":"error","code":"ProviderTimeout","message":"timeout"}\n\n',
      ]),
    );

    await expect(runTurn(input, { knownMessageIds: [], ...fast })).rejects.toBeInstanceOf(
      AIServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a server-declared failure does not wait on the saved conversation', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { message: 'ai-service: boom' }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'ai-service: boom' }));

    await expect(runTurn(input, { knownMessageIds: [], ...fast })).rejects.toBeInstanceOf(
      AIServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a cancel propagates as AbortError and never looks for a saved answer', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);

    await expect(runTurn(input, { knownMessageIds: [], ...fast })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
