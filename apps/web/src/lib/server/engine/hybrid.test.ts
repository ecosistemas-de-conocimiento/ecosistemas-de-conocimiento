/**
 * `CHAT_RETRIEVAL_MODE` and the `metadataFilterIn` capability gate.
 * Hybrid runs only when the switch is on AND ai-service says it has `$in`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hybridRetrievalForTurn, parseRetrievalMode, resetHybridCapabilityCache } from './hybrid';

const ENV = {
  CHAT_RETRIEVAL_MODE: 'hybrid',
  AI_SERVICE_URL: 'http://ai.test/',
  AI_SERVICE_API_KEY: 'k',
};
let fetchMock: ReturnType<typeof vi.fn>;

const capabilities = (caps: Record<string, boolean>, status = 200) =>
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ capabilities: caps }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

beforeEach(() => {
  resetHybridCapabilityCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseRetrievalMode', () => {
  it('defaults to dense; only `hybrid` turns it on', () => {
    expect(parseRetrievalMode(undefined)).toBe('dense');
    expect(parseRetrievalMode('')).toBe('dense');
    expect(parseRetrievalMode('dense')).toBe('dense');
    expect(parseRetrievalMode('on')).toBe('dense');
    expect(parseRetrievalMode(' Hybrid ')).toBe('hybrid');
  });
});

describe('hybridRetrievalForTurn', () => {
  it('asks nothing when the switch is off', async () => {
    expect(await hybridRetrievalForTurn({ ...ENV, CHAT_RETRIEVAL_MODE: undefined })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is on when ai-service has metadataFilterIn, and asks only once', async () => {
    capabilities({ metadataFilterIn: true });
    expect(await hybridRetrievalForTurn(ENV)).toBe(true);
    expect(await hybridRetrievalForTurn(ENV)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/capabilities');
  });

  it('🔴 falls back to dense when the capability is missing, and logs once', async () => {
    capabilities({ orgDelegation: true });
    expect(await hybridRetrievalForTurn(ENV)).toBe(false);
    expect(await hybridRetrievalForTurn(ENV)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]![0])).toContain('metadataFilterIn');
  });

  it('falls back to dense on a service that predates /v1/capabilities', async () => {
    capabilities({}, 404);
    expect(await hybridRetrievalForTurn(ENV)).toBe(false);
  });

  it('falls back to dense when ai-service is unreachable, and asks again later', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await hybridRetrievalForTurn(ENV)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const before = fetchMock.mock.calls.length;
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    capabilities({ metadataFilterIn: true });
    expect(await hybridRetrievalForTurn(ENV)).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
