/**
 * 🔴 C-13 (audit 2026-11-10): the live mic text is raw, pre-gate testimony.
 * It shows above the input while recording; on stop it is gone — it never
 * lands in the chat input, so it can never be sent or stored as a message.
 * Only the uploaded recording goes on, through the gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { readable } from 'svelte/store';

const mic = vi.hoisted(() => ({ ontext: null as null | ((line: string | null) => void) }));
vi.mock('$app/stores', () => ({
  page: { subscribe: (fn: (v: unknown) => void) => readable({ data: {}, url: new URL('http://x/') }).subscribe(fn) },
}));
vi.mock('$app/navigation', () => ({ goto: async () => {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_AUDIO_UPLOAD_ENABLED: '1' } }));
// The real button needs MediaRecorder; the stub only hands over `ontext`.
vi.mock('./MicButton.svelte', () => ({
  default: (_anchor: unknown, props: { ontext: (line: string | null) => void }) => {
    mic.ontext = props.ontext;
  },
}));

import Composer from './Composer.svelte';
import { app } from '$lib/stores/app.svelte';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  mic.ontext = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

describe('Composer — live mic text (C-13)', () => {
  it('shows the live line while recording and leaves nothing in the input on stop', async () => {
    app.features = { ...app.features, liveMic: true };
    const onsend = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(Composer, { target, props: { sessionId: 's1', onsend } }));
    await settle();
    expect(mic.ontext).toBeTypeOf('function');

    mic.ontext!('María López Ruiz vive en Juchitán');
    await settle();
    expect(target.querySelector('[data-testid="live-text"]')?.textContent).toContain('Juchitán');

    mic.ontext!(null);
    await settle();
    expect(target.querySelector('[data-testid="live-text"]')).toBeNull();
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    expect(input.value).toBe('');

    // Enter on the (empty) input sends nothing.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(onsend).not.toHaveBeenCalled();
  });

  it('keeps what the person typed, without the live line appended', async () => {
    app.features = { ...app.features, liveMic: true };
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(Composer, { target, props: { sessionId: 's1', onsend: () => {} } }));
    await settle();
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    input.value = 'mi pregunta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    mic.ontext!('María López Ruiz');
    await settle();
    mic.ontext!(null);
    await settle();
    expect(input.value).toBe('mi pregunta');
  });
});
