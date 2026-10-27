import { describe, expect, it, vi } from 'vitest';
import { LiveUplink, MAX_REQUEST_BYTES, liveLine, type LiveText } from './liveCapture';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: Uint8Array | null; method: string }> = [];
  const texts: LiveText[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: (init?.body as Uint8Array) ?? null, method: init?.method ?? 'GET' });
    const next = responses.shift();
    return next ? next() : ok({ committed: '', tentative: '' });
  }) as unknown as typeof fetch;
  const uplink = new LiveUplink((t) => texts.push(t), fetchImpl, 'sid-1');
  return { uplink, calls, texts };
}

describe('LiveUplink', () => {
  it('sends slices with their offset and reports the text', async () => {
    const { uplink, calls, texts } = harness([
      () => ok({ committed: '', tentative: 'hola' }),
      () => ok({ committed: 'hola', tentative: ' mundo' }),
    ]);
    uplink.push(bytes(1, 2, 3));
    await tick();
    uplink.push(bytes(4));
    await tick();
    expect(calls.map((c) => c.url)).toEqual(['/api/live/sid-1?offset=0', '/api/live/sid-1?offset=3']);
    expect(liveLine(texts.at(-1)!)).toBe('hola mundo');
  });

  it('keeps one request in flight and batches slices that arrive meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { uplink, calls } = harness([async () => (await gate, ok({}))]);
    uplink.push(bytes(1));
    uplink.push(bytes(2));
    uplink.push(bytes(3));
    await tick();
    expect(calls).toHaveLength(1);
    release();
    await tick();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('/api/live/sid-1?offset=1');
    expect(Array.from(calls[1]!.body!)).toEqual([2, 3]);
  });

  it('on a 409 starts a new session and resends from 0', async () => {
    const { uplink, calls } = harness([() => ok({}), () => new Response('{}', { status: 409 })]);
    uplink.push(bytes(1));
    await tick();
    uplink.push(bytes(2));
    await tick();
    await tick();
    const last = calls.at(-1)!;
    expect(last.url).toMatch(/\?offset=0$/);
    expect(last.url).not.toContain('sid-1');
    expect(Array.from(last.body!)).toEqual([1, 2]);
  });

  it('goes quiet on a 503 and does not retry in a loop on a 502', async () => {
    const quiet = harness([() => new Response('{}', { status: 503 })]);
    quiet.uplink.push(bytes(1));
    await tick();
    quiet.uplink.push(bytes(2));
    await tick();
    expect(quiet.calls).toHaveLength(1);
    expect(quiet.uplink.off).toBe(true);

    const flaky = harness([() => new Response('{}', { status: 502 })]);
    flaky.uplink.push(bytes(1));
    await tick();
    await tick();
    expect(flaky.calls).toHaveLength(1);
    flaky.uplink.push(bytes(2));
    await tick();
    expect(flaky.calls[1]!.url).toBe('/api/live/sid-1?offset=0');
  });

  it('drops text that arrives after close (stop while a request is in flight)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { uplink, texts } = harness([async () => (await gate, ok({ tentative: 'texto crudo' }))]);
    uplink.push(bytes(1));
    await tick();
    const closing = uplink.close();
    release();
    await closing;
    expect(texts).toEqual([]);
  });

  it('caps each request and catches up in pieces', async () => {
    const { uplink, calls } = harness([]);
    uplink.push(new Uint8Array(MAX_REQUEST_BYTES + 10));
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.map((c) => c.body!.byteLength)).toEqual([MAX_REQUEST_BYTES, 10]);
    expect(calls[1]!.url).toBe(`/api/live/sid-1?offset=${MAX_REQUEST_BYTES}`);
  });

  it('close drops the server session', async () => {
    const { uplink, calls } = harness([]);
    await uplink.close();
    expect(calls.at(-1)).toMatchObject({ url: '/api/live/sid-1', method: 'DELETE' });
  });

  it('🔴 names the active conversation on every slice, read when each slice is sent', async () => {
    const { uplink, calls } = harness([]);
    let active: string | null = null;
    uplink.conversation = () => active;
    uplink.push(bytes(1));
    await tick();
    active = '55';
    uplink.push(bytes(2));
    await tick();
    expect(calls.map((c) => c.url)).toEqual([
      '/api/live/sid-1?offset=0',
      '/api/live/sid-1?offset=1&conversation=55',
    ]);
  });
});
