/**
 * 🔴 An empty answer is a failed answer (dev 2026-11-10: 3 of 6 turns came
 * back with no text). `Chat.svelte` mounted in jsdom, faked only at `fetch`:
 * the bubble shows the one-line error and "Reintentar", and "Reintentar" asks
 * the same turn once more without saving the question a second time.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
  page: { subscribe: (fn: (v: unknown) => void) => readable({ data: {}, params: {} }).subscribe(fn) },
}));
vi.mock('$app/navigation', () => ({ goto: async () => {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import Chat from './Chat.svelte';
import { app } from '$lib/stores/app.svelte';
import { ANSWER_TRUNCATED_MESSAGE, EMPTY_ANSWER_MESSAGE } from '$lib/api';

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let sent: Sent[];
/** What each `/api/generate` call answers, in order. */
let answers: Array<() => Response>;

const sse = (...frames: unknown[]) => () =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const done = (text: string) => ({ type: 'done', text, messageId: '77', provenance: null });

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
});

beforeEach(() => {
  sent = [];
  answers = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.startsWith('/api/generate')) return (answers.shift() ?? sse(done('Sin guion.')))();
    if (url === '/api/sessions/5/messages' && method === 'POST') {
      return new Response(JSON.stringify({ doc: { id: 'u1' } }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  app.sessions = [{ id: '5', title: 'Partería', createdAt: 0, updatedAt: 0, messages: [], docs: [] }];
  app.activeSessionId = '5';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

async function ask(question: string): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(Chat, { target, props: {} }));
  await settle();
  const input = target.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
  input.value = question;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  return target;
}

const generates = () => sent.filter((c) => c.url.startsWith('/api/generate'));
const questionSaves = () =>
  sent.filter((c) => c.url === '/api/sessions/5/messages' && c.method === 'POST' && c.body?.role === 'user');
const retryButton = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[data-testid="answer-retry"]');

describe('🔴 Chat: an empty answer is a failed answer with "Reintentar"', () => {
  it.each([
    ['an empty_answer error frame', sse({ type: 'error', code: 'empty_answer', message: 'x' })],
    ['a `done` with no text', sse(done('   '))],
  ])('%s: one short line, Reintentar, and no automatic second wait', async (_label, first) => {
    answers = [first];
    const root = await ask('¿Qué hacen las parteras?');
    expect(root.textContent).toContain(EMPTY_ANSWER_MESSAGE);
    expect(retryButton(root)).not.toBeNull();
    expect(generates()).toHaveLength(1);
  });

  it('Reintentar asks the same turn once more, without saving the question again', async () => {
    answers = [sse(done('')), sse(done('Acompañan los nacimientos.'))];
    const root = await ask('¿Qué hacen las parteras?');
    retryButton(root)!.click();
    await settle();

    expect(generates()).toHaveLength(2);
    const [a, b] = generates().map((c) => c.body!);
    expect(b!.turnId).toBe(a!.turnId);
    expect(b!.sessionId).toBe('5');
    expect(b!.messages).toEqual(a!.messages);
    expect(questionSaves()).toHaveLength(1);
    expect(app.active!.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(root.textContent).toContain('Acompañan los nacimientos.');
    expect(root.textContent).not.toContain(EMPTY_ANSWER_MESSAGE);
    expect(retryButton(root)).toBeNull();
  });
});

describe('🔴 Chat: an answer cut at the output limit has no "Reintentar"', () => {
  it.each([
    ['an answer_truncated error frame', sse({ type: 'error', code: 'answer_truncated', message: 'x' })],
    [
      'a 502 answer_truncated before the stream',
      () => new Response(JSON.stringify({ code: 'answer_truncated', message: 'x' }), { status: 502 }),
    ],
  ])('%s: one short line, no Reintentar, no second ask', async (_label, first) => {
    answers = [first];
    const root = await ask('¿Qué hacen las parteras?');
    expect(root.textContent).toContain(ANSWER_TRUNCATED_MESSAGE);
    expect(retryButton(root)).toBeNull();
    expect(generates()).toHaveLength(1);
  });
});
