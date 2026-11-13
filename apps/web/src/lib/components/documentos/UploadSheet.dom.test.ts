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
import { UPLOAD_CONSENT_VERSION, uploadConsentLine } from '$lib/uploadConsent';
import { CONSENT_CHANGED } from '$lib/consent';

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

async function openWithFile(hasOptions = true, status = 201, body = '{}', file = new File(['x'], 'tesis.pdf', { type: 'application/pdf' }), audioOn = false): Promise<HTMLElement> {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(init?.body as FormData);
    return new Response(body, { status });
  }) as typeof fetch;
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(UploadSheet, { target, props: { open: true, hasOptions, audioOn, onUploaded: () => {} } }));
  await settle();
  const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  return target;
}

const q = <T extends HTMLElement>(root: HTMLElement, id: string) => root.querySelector<T>(`[data-testid="${id}"]`)!;

/** 🔴 Tick the per-resource consent and send. */
async function consentAndSend(root: HTMLElement): Promise<void> {
  q(root, 'upload-consent').click();
  await settle();
  q(root, 'upload-send').click();
  await settle();
}

describe('UploadSheet — "Anonimizar" (ADR-0020)', () => {
  it('starts on for a documento and the upload asks for the gate', async () => {
    const root = await openWithFile();
    expect(q<HTMLInputElement>(root, 'owned-anonymise').checked).toBe(true);
    await consentAndSend(root);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get('contentKind')).toBe('documento');
    expect(sent[0]!.get('anonymise')).toBe('true');
  });

  it('turned off, the upload names no anonymise', async () => {
    const root = await openWithFile();
    q(root, 'owned-anonymise').click();
    await settle();
    expect(q<HTMLInputElement>(root, 'owned-anonymise').checked).toBe(false);
    await consentAndSend(root);
    expect(sent[0]!.get('anonymise')).toBeNull();
  });

  it('a testimonio shows no switch and sends no anonymise', async () => {
    const root = await openWithFile();
    q(root, 'upload-kind-testimonio').click();
    await settle();
    expect(root.querySelector('[data-testid="owned-anonymise"]')).toBeNull();
    await consentAndSend(root);
    expect(sent[0]!.get('contentKind')).toBe('testimonio');
    expect(sent[0]!.get('anonymise')).toBeNull();
  });
});

describe('🔴 UploadSheet — the per-resource consent', () => {
  it('always stops on a confirmation step, even with no options, and sends nothing unticked', async () => {
    const root = await openWithFile(false);
    expect(sent).toHaveLength(0);
    const box = q<HTMLInputElement>(root, 'upload-consent');
    expect(box.checked).toBe(false);
    expect(root.querySelector('[data-testid="upload-kind-documento"]')).toBeNull();
    expect(root.querySelector('a[href="/privacidad"]')?.getAttribute('target')).toBe('_blank');
    expect(q<HTMLButtonElement>(root, 'upload-send').disabled).toBe(true);
    q(root, 'upload-send').click();
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('ticked, the upload carries the version', async () => {
    const root = await openWithFile(false);
    await consentAndSend(root);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get('uploadConsentVersion')).toBe(String(UPLOAD_CONSENT_VERSION));
  });

  it('a testimonio shows the testimonio wording', async () => {
    const root = await openWithFile();
    expect(root.textContent).toContain(uploadConsentLine('documento')!.after.trim());
    q(root, 'upload-kind-testimonio').click();
    await settle();
    expect(root.textContent).toContain(uploadConsentLine('testimonio')!.after.trim());
  });

  it('🔴 a participant\'s audio shows the testimonio wording (the backend files it as one)', async () => {
    const root = await openWithFile(false, 201, '{}', new File(['x'], 'voz.mp3', { type: 'audio/mpeg' }), true);
    expect(root.textContent).toContain(uploadConsentLine('testimonio')!.after.trim());
  });

  it('changing the kind unticks the box', async () => {
    const root = await openWithFile();
    q<HTMLInputElement>(root, 'upload-consent').click();
    await settle();
    expect(q<HTMLButtonElement>(root, 'upload-send').disabled).toBe(false);
    q(root, 'upload-kind-testimonio').click();
    await settle();
    expect(q<HTMLButtonElement>(root, 'upload-send').disabled).toBe(true);
  });

  it('is unchecked again for the next file', async () => {
    const root = await openWithFile(false);
    await consentAndSend(root);
    const input = q<HTMLInputElement>(root, 'upload-input');
    Object.defineProperty(input, 'files', { value: [new File(['y'], 'otro.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(q<HTMLInputElement>(root, 'upload-consent').checked).toBe(false);
  });

  it('a 409 shows the "text changed" copy', async () => {
    const root = await openWithFile(false, 409, JSON.stringify({ error: 'consent_version_changed' }));
    await consentAndSend(root);
    expect(q(root, 'upload-error').textContent).toContain(CONSENT_CHANGED);
  });
});
