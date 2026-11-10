/**
 * 🔴 ADR-0020: the most protective value is the default. In "Subir", a
 * `documento` starts with "Anonimizar" on; the person can turn it off, and
 * then the upload asks for no gate. A testimonio sends no `anonymise` (it is
 * always gated).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

import UploadSheet from './UploadSheet.svelte';

let sent: FormData[] = [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  sent = [];
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

async function openWithFile(): Promise<HTMLElement> {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(init?.body as FormData);
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(UploadSheet, { target, props: { open: true, hasOptions: true, audioOn: false, onUploaded: () => {} } }));
  await settle();
  const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]')!;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'tesis.pdf', { type: 'application/pdf' })], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  return target;
}

const q = <T extends HTMLElement>(root: HTMLElement, id: string) => root.querySelector<T>(`[data-testid="${id}"]`)!;

describe('UploadSheet — "Anonimizar" (ADR-0020)', () => {
  it('starts on for a documento and the upload asks for the gate', async () => {
    const root = await openWithFile();
    expect(q<HTMLInputElement>(root, 'owned-anonymise').checked).toBe(true);
    q(root, 'upload-send').click();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get('contentKind')).toBe('documento');
    expect(sent[0]!.get('anonymise')).toBe('true');
  });

  it('turned off, the upload names no anonymise', async () => {
    const root = await openWithFile();
    q(root, 'owned-anonymise').click();
    await settle();
    expect(q<HTMLInputElement>(root, 'owned-anonymise').checked).toBe(false);
    q(root, 'upload-send').click();
    await settle();
    expect(sent[0]!.get('anonymise')).toBeNull();
  });

  it('a testimonio shows no switch and sends no anonymise', async () => {
    const root = await openWithFile();
    q(root, 'upload-kind-testimonio').click();
    await settle();
    expect(root.querySelector('[data-testid="owned-anonymise"]')).toBeNull();
    q(root, 'upload-send').click();
    await settle();
    expect(sent[0]!.get('contentKind')).toBe('testimonio');
    expect(sent[0]!.get('anonymise')).toBeNull();
  });
});
