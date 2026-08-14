import { afterEach, describe, expect, it, vi } from 'vitest';
import { degradeListResponse } from './degrade';

function res(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('degradeListResponse', () => {
  it('passes an ok body straight through', () => {
    const body = { docs: [{ id: 1 }], totalDocs: 1 };
    const out = degradeListResponse(res(200), body, 'sessions');
    expect(out).toEqual({ kind: 'ok', status: 200, body });
  });

  it('falls back to an empty-list body when an ok response has no usable body', () => {
    const out = degradeListResponse(res(200), null, 'sessions');
    expect(out.kind).toBe('ok');
    expect(out.body).toEqual({ docs: [] });
  });

  it('passes 401 through as unauthorized — never degraded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = degradeListResponse(res(401), { error: 'nope' }, 'sessions');
    expect(out).toEqual({ kind: 'unauthorized', status: 401, body: { error: 'unauthorized' } });
    // No degrade warning for a genuine session expiry.
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades 403 to an empty 200 with reason=forbidden and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = degradeListResponse(res(403), { errors: [] }, 'sessions');
    expect(out.kind).toBe('degraded');
    expect(out.status).toBe(200);
    expect(out.reason).toBe('forbidden');
    expect(out.body).toMatchObject({ docs: [], degraded: true, reason: 'forbidden' });
    // Keep the signal: a real authz regression must stay observable.
    expect(warn).toHaveBeenCalledOnce();
  });

  it('degrades 404 to reason=unavailable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = degradeListResponse(res(404), {}, 'messages');
    expect(out.kind).toBe('degraded');
    expect(out.reason).toBe('unavailable');
    expect(out.body).toMatchObject({ docs: [], degraded: true, reason: 'unavailable' });
  });

  it('degrades 5xx to reason=unavailable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = degradeListResponse(res(503), {}, 'documents');
    expect(out.kind).toBe('degraded');
    expect(out.status).toBe(200);
    expect(out.reason).toBe('unavailable');
  });

  it('degrades an unmapped 4xx to reason=unavailable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = degradeListResponse(res(418), {}, 'sessions');
    expect(out.reason).toBe('unavailable');
  });
});
