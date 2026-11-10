// Unit tests for `runTurn` — one chat turn end to end on the client: stream,
// fall back to sync, and recover an answer the server saved after the
// browser lost the connection.
//
// The first case replays run 1 of the dev check on 2026-10-23: the
// stream request died before its headers, the sync fallback died too, and the
// server had still saved the answer. The user saw "No se pudo obtener la
// respuesta" for an answer that existed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runTurn,
  userFacingError,
  TURN_FAILED_MESSAGE,
  CONNECTION_LOST_MESSAGE,
  EMPTY_ANSWER_MESSAGE,
  AIServiceError,
  ConnectionLostError,
} from './api';

const input = { sessionId: 's1', turnId: 'turn-2', messages: [{ role: 'user' as const, content: 'hola' }] };
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
  generationMeta: { traceId: 't9', modelUsed: 'm', provider: 'p', costUsd: 0.001, turnId: 'turn-2' },
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
      .mockResolvedValueOnce(savedMessages([])) // looked once before asking again
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // sync fallback
      // Not saved yet on the first look, saved on the second.
      .mockResolvedValueOnce(savedMessages([{ id: 1, role: 'user', content: 'hola' }]))
      .mockResolvedValueOnce(savedMessages([{ id: 1, role: 'user', content: 'hola' }, savedAnswer]));

    const result = await runTurn(input, fast);

    expect(result.text).toBe('La respuesta guardada [1].');
    expect(result.messageId).toBe('99');
    expect(result.traceId).toBe('t9');
    expect(result.provenance).toEqual({ chunks: [] });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/sessions/s1/messages');
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/sessions/s1/messages');
  });

  it('ignores assistant messages of other turns', async () => {
    const old = { ...savedAnswer, id: 7, content: 'respuesta anterior', generationMeta: {} };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/generate')) throw new TypeError('Failed to fetch');
      return savedMessages([old]);
    });

    const err = await runTurn(input, fast).catch((e) => e);

    expect(err).toBeInstanceOf(ConnectionLostError);
    expect(userFacingError(err)).toBe(CONNECTION_LOST_MESSAGE);
    // stream + 1 look + sync + 3 looks + one more sync + 3 looks
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('🔴 audit: a late-saved answer of the PREVIOUS turn is never shown as this one', async () => {
    // Turn 1 failed in the browser; the server saved its answer (id 50)
    // afterwards, so the browser never learned that id.
    const saved = [
      { id: 1, role: 'user', content: 'pregunta 1' },
      { id: 50, role: 'assistant', content: 'RESPUESTA 1', generationMeta: { turnId: 'turn-1' } },
      { id: 2, role: 'user', content: 'hola' },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/generate')) throw new TypeError('Failed to fetch');
      return savedMessages(saved);
    });

    const err = await runTurn(input, fast).catch((e) => e);

    expect(err).toBeInstanceOf(AIServiceError);
  });

  it('🔴 gives the turn an id and sends the same one on the stream and on the sync retry', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'ok', messageId: '5' }));

    await runTurn({ sessionId: 's1', messages: input.messages }, fast);

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(typeof bodies[0].turnId).toBe('string');
    expect(bodies[0].turnId.length).toBeGreaterThan(8);
    expect(bodies[1].turnId).toBe(bodies[0].turnId);
  });

  it('🔴 audit: a dropped stream whose answer was saved is not asked again', async () => {
    fetchMock
      .mockResolvedValueOnce(sse(['data: {"type":"delta","text":"Hal"}\n\n'], { failAfter: true }))
      .mockResolvedValueOnce(savedMessages([{ id: 1, role: 'user', content: 'hola' }, savedAnswer]));
    const onRestart = vi.fn();

    const result = await runTurn(input, { ...fast, onRestart });

    expect(result.text).toBe('La respuesta guardada [1].');
    expect(result.messageId).toBe('99');
    expect(onRestart).not.toHaveBeenCalled();
    // No second /api/generate: no second paid answer, no second saved turn.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a stream that ends with no completion falls back to sync', async () => {
    fetchMock
      .mockResolvedValueOnce(sse([': ok\n\n']))
      .mockResolvedValueOnce(savedMessages([]))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'sync answer', messageId: '5' }));

    const result = await runTurn(input, fast);

    expect(result.text).toBe('sync answer');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/sessions/s1/messages');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/generate');
  });

  it('a connection lost mid-answer restarts the turn on sync instead of failing', async () => {
    fetchMock
      .mockResolvedValueOnce(sse(['data: {"type":"delta","text":"Hal"}\n\n'], { failAfter: true }))
      .mockResolvedValueOnce(savedMessages([]))
      .mockResolvedValueOnce(jsonResponse(200, { text: 'Hola completo', messageId: '6' }));
    const deltas: string[] = [];
    const onRestart = vi.fn();

    const result = await runTurn(input, {
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

    await expect(runTurn(input, fast)).rejects.toBeInstanceOf(
      AIServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a server-declared failure does not wait on the saved conversation', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { message: 'ai-service: boom' }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'ai-service: boom' }));

    await expect(runTurn(input, fast)).rejects.toBeInstanceOf(
      AIServiceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a cancel propagates as AbortError and never looks for a saved answer', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);

    await expect(runTurn(input, fast)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('🔴 dev 2026-10-24 session 180: stream and sync both drop, nothing saved, one more sync answers', async () => {
    // Measured on dev: ai-service saw the stream's client hang up
    // 3.2 s after the message, and the sync fallback never reached it. The
    // server never generated, so there was nothing saved to find.
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // stream
      .mockResolvedValueOnce(savedMessages([])) // one look
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // sync
      .mockResolvedValueOnce(savedMessages([]))
      .mockResolvedValueOnce(savedMessages([]))
      .mockResolvedValueOnce(savedMessages([])) // 3 looks: nothing
      .mockResolvedValueOnce(jsonResponse(200, { text: 'por fin', messageId: '8' })); // sync again

    const result = await runTurn(input, fast);

    expect(result.text).toBe('por fin');
    const generateBodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).startsWith('/api/generate'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(generateBodies).toHaveLength(3);
    // Same turn id: the server hands back a saved answer instead of paying twice.
    expect(new Set(generateBodies.map((b) => b.turnId))).toEqual(new Set(['turn-2']));
  });

  it('a server-declared failure reads as a failed answer, a lost connection as a lost connection', () => {
    expect(userFacingError(new AIServiceError('ai-service: boom'))).toBe(TURN_FAILED_MESSAGE);
    expect(userFacingError(new ConnectionLostError('Network error'))).toBe(CONNECTION_LOST_MESSAGE);
    expect(CONNECTION_LOST_MESSAGE).not.toBe(TURN_FAILED_MESSAGE);
  });

  // 🔴 dev 2026-11-10: 3 of 6 answers came back empty, and the person got an
  // empty bubble plus "No pudimos guardar esta respuesta".
  describe('an empty answer', () => {
    it('stream empty_answer frame: fails at once, no sync second wait', async () => {
      fetchMock.mockResolvedValueOnce(sse([`data: {"type":"error","code":"empty_answer","message":"x"}\n\n`]));
      const err = await runTurn(input, fast).catch((e) => e);
      expect(err).toBeInstanceOf(AIServiceError);
      expect(userFacingError(err)).toBe(EMPTY_ANSWER_MESSAGE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stream `done` with whitespace only: the same failure', async () => {
      fetchMock.mockResolvedValueOnce(sse([`data: {"type":"done","text":"  \\n ","messageId":null}\n\n`]));
      const err = await runTurn(input, fast).catch((e) => e);
      expect(userFacingError(err)).toBe(EMPTY_ANSWER_MESSAGE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sync answer with no text (the stream failed first): the same failure', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
        .mockResolvedValueOnce(jsonResponse(200, { text: '', messageId: null }));
      const err = await runTurn(input, fast).catch((e) => e);
      expect(userFacingError(err)).toBe(EMPTY_ANSWER_MESSAGE);
    });

    it('sync 502 empty_answer from the BFF: the same failure', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
        .mockResolvedValueOnce(jsonResponse(502, { code: 'empty_answer', message: 'x' }));
      const err = await runTurn(input, fast).catch((e) => e);
      expect(userFacingError(err)).toBe(EMPTY_ANSWER_MESSAGE);
    });

    it('an unknown error code reads as an ordinary failed answer', () => {
      expect(userFacingError(new AIServiceError('x', 'SOMETHING_NEW'))).toBe(TURN_FAILED_MESSAGE);
    });
  });
});
