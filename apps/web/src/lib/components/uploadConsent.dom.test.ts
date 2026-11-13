/**
 * 🔴 The per-resource upload consent (Etapa 1 correction, 2026-11-12) in the
 * entry points other than `UploadSheet` (its own test): the chat panel's
 * "Subir" and "Nota", the mic, and "Nueva nota" in Mis documentos. Without the
 * checkbox nothing is created; ticked, the version goes with the resource.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
  page: readable({ data: {}, url: new URL('http://x/') }),
}));
vi.mock('$app/navigation', () => ({ goto: async () => {} }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_AUDIO_UPLOAD_ENABLED: '1' } }));
vi.mock('$lib/liveCapture', () => ({
  LiveUplink: class {
    conversation: () => string | null = () => null;
    push() {}
    async close() {}
  },
  liveLine: () => '',
}));

import DocsPanel from './DocsPanel.svelte';
import MicButton from './MicButton.svelte';
import NoteSheet from './documentos/NoteSheet.svelte';
import { app } from '$lib/stores/app.svelte';
import { UPLOAD_CONSENT_VERSION, uploadConsentLine } from '$lib/uploadConsent';

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
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

function place(component: unknown, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(component as never, { target, props } as never));
  return target;
}

const q = <T extends HTMLElement>(root: HTMLElement, id: string) =>
  root.querySelector<T>(`[data-testid="${id}"]`);

describe('🔴 DocsPanel — consent before the file picker and before a new note', () => {
  function panel(): HTMLElement {
    app.sessions = [{ id: '1', title: 'C', createdAt: 0, updatedAt: 0, messages: [], docs: [] }];
    app.activeSessionId = '1';
    app.docsPanelOpen = true;
    return place(DocsPanel, {});
  }

  it('"Subir" opens the checkbox, not the picker; the picker only once ticked', async () => {
    const root = panel();
    await settle();
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const picked = vi.spyOn(input, 'click').mockImplementation(() => {});
    q(root, 'panel-upload')!.click();
    await settle();
    expect(picked).not.toHaveBeenCalled();
    expect(q<HTMLInputElement>(root, 'panel-consent-check')!.checked).toBe(false);
    expect(q<HTMLButtonElement>(root, 'panel-consent-go')!.disabled).toBe(true);
    q(root, 'panel-consent-check')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it('a file chosen with the box ticked goes up with the version', async () => {
    const root = panel();
    await settle();
    vi.spyOn(app, 'ensureSession').mockResolvedValue('1');
    const upload = vi.spyOn(app, 'uploadDoc').mockResolvedValue(null);
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    q(root, 'panel-upload')!.click();
    await settle();
    q(root, 'panel-consent-check')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![4]).toBe(UPLOAD_CONSENT_VERSION);
    // Not remembered: the strip is gone, and the next "Subir" starts unticked.
    expect(q(root, 'panel-consent')).toBeNull();
    q(root, 'panel-upload')!.click();
    await settle();
    expect(q<HTMLInputElement>(root, 'panel-consent-check')!.checked).toBe(false);
  });

  it('🔴 a participant\'s audio file asks again, on the testimonio line, before it goes up', async () => {
    app.features = { ...app.features, audioUpload: true };
    const root = panel();
    await settle();
    vi.spyOn(app, 'ensureSession').mockResolvedValue('1');
    const upload = vi.spyOn(app, 'uploadDoc').mockResolvedValue(null);
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    q(root, 'panel-upload')!.click();
    await settle();
    expect(q(root, 'panel-consent')!.textContent).toContain(uploadConsentLine('documento')!.after.trim());
    q(root, 'panel-consent-check')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.mp3', { type: 'audio/mpeg' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    // No voces permission: the backend files it as a testimonio, so the box is
    // asked again on that line.
    expect(upload).not.toHaveBeenCalled();
    expect(q(root, 'panel-consent')!.textContent).toContain(uploadConsentLine('testimonio')!.after.trim());
    expect(q<HTMLInputElement>(root, 'panel-consent-check')!.checked).toBe(false);
    expect(q<HTMLButtonElement>(root, 'panel-consent-go')!.disabled).toBe(true);
    q(root, 'panel-consent-check')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![2]).toBe('documento');
    expect(upload.mock.calls[0]![4]).toBe(UPLOAD_CONSENT_VERSION);
  });

  it('a file chosen without it does not go up', async () => {
    const root = panel();
    await settle();
    const upload = vi.spyOn(app, 'uploadDoc').mockResolvedValue(null);
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(upload).not.toHaveBeenCalled();
  });

  it('"Nota" creates nothing until ticked, then sends the version', async () => {
    const root = panel();
    await settle();
    vi.spyOn(app, 'ensureSession').mockResolvedValue('1');
    const newDoc = vi.spyOn(app, 'newDoc').mockResolvedValue(null);
    q(root, 'panel-new-note')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    await settle();
    expect(newDoc).not.toHaveBeenCalled();
    q(root, 'panel-consent-check')!.click();
    await settle();
    q(root, 'panel-consent-go')!.click();
    await settle();
    expect(newDoc).toHaveBeenCalledWith('1', undefined, UPLOAD_CONSENT_VERSION);
  });
});

describe('🔴 MicButton — the checkbox before the microphone opens', () => {
  class FakeRecorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = 'recording';
      const data = new Blob(['\x1aE\xdf\xa3'], { type: 'audio/webm' });
      // jsdom's Blob has no arrayBuffer(); the live uplink reads it.
      Object.assign(data, { arrayBuffer: async () => new ArrayBuffer(4) });
      this.ondataavailable?.({ data });
    }
    requestData() {}
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }

  it('first tap shows the testimonio checkbox and opens no mic; ticked, it records and uploads with the version', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.spyOn(app, 'ensureSession').mockResolvedValue('1');
    const upload = vi.spyOn(app, 'uploadDoc').mockResolvedValue(null);

    const root = place(MicButton, { ontext: () => {} });
    await settle();
    q(root, 'mic-start')!.click();
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    // No voces permission here: it sends `documento`, and the backend refiles a
    // participant's audio as a testimonio — the line the constancia shows.
    expect(q(root, 'mic-consent')!.textContent).toContain(uploadConsentLine('testimonio')!.after.trim());
    expect(q<HTMLButtonElement>(root, 'mic-consent-go')!.disabled).toBe(true);

    q(root, 'mic-consent-check')!.click();
    await settle();
    q(root, 'mic-consent-go')!.click();
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(q(root, 'mic-consent')).toBeNull();

    q(root, 'mic-stop')!.click();
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![2]).toBe('documento');
    expect(upload.mock.calls[0]![4]).toBe(UPLOAD_CONSENT_VERSION);
    vi.unstubAllGlobals();
  });
});

describe('🔴 NoteSheet — "Guardar" needs the checkbox', () => {
  it('stays disabled unticked; ticked, the note carries the version', async () => {
    const onSave = vi.fn(async () => true);
    const root = place(NoteSheet, { open: true, onSave });
    await settle();
    const body = q<HTMLTextAreaElement>(root, 'note-body')!;
    body.value = 'texto';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(q<HTMLInputElement>(root, 'note-consent')!.checked).toBe(false);
    expect(q<HTMLButtonElement>(root, 'note-save')!.disabled).toBe(true);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(onSave).not.toHaveBeenCalled();

    q(root, 'note-consent')!.click();
    await settle();
    expect(q<HTMLButtonElement>(root, 'note-save')!.disabled).toBe(false);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(onSave).toHaveBeenCalledWith({ title: 'Nota sin título', body: 'texto', uploadConsentVersion: UPLOAD_CONSENT_VERSION });
  });
});
