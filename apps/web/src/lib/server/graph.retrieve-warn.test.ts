import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fetchGraphRetrieval` stays FAIL-OPEN (null → the turn runs with no graph),
 * but a non-2xx is now LOUD. It used to return null without a log line, which
 * hid an HTTP 500 on every graph-matching turn for weeks (fixed 2026-10-17 in
 * `apps/backend/src/lib/graph/queries.ts:intArray`).
 */

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...args: unknown[]) => backendFetch(...args) }));

const { fetchGraphRetrieval } = await import('./graph');

const input = { organizationId: '1', query: 'consulta previa' };

describe('fetchGraphRetrieval on a non-2xx', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    backendFetch.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('warns with the status and still returns null', async () => {
    backendFetch.mockResolvedValue(new Response('{"errors":[]}', { status: 500 }));
    await expect(fetchGraphRetrieval('t', input)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('500');
  });

  it('does not warn on a 2xx', async () => {
    backendFetch.mockResolvedValue(
      new Response(JSON.stringify({ entities: [], edges: [], documents: [], terms: [] }), {
        status: 200,
      }),
    );
    await fetchGraphRetrieval('t', input);
    expect(warn).not.toHaveBeenCalled();
  });
});
