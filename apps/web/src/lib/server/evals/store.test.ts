/**
 * `deleteSession` never throws (it runs in a `finally` and in the reaper), but
 * a failure is logged: a conversation left behind keeps its turns searchable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...a: unknown[]) => backendFetch(...a) }));

import { makeEvalStore } from './store';

afterEach(() => vi.restoreAllMocks());

describe('deleteSession', () => {
  it('logs a refused delete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backendFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(makeEvalStore('t').deleteSession('s1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s1'));
  });

  it('logs a transport failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backendFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(makeEvalStore('t').deleteSession('s1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TypeError'));
  });

  it('a 404 is already gone: no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backendFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await makeEvalStore('t').deleteSession('s1');
    expect(warn).not.toHaveBeenCalled();
  });
});
