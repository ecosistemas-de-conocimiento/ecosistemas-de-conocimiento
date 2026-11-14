/**
 * 🔴 The per-resource upload consent in the store (`$lib/uploadConsent.ts`):
 * no version, no request; and one notice per refusal, never two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './app.svelte';
import { toasts } from './toasts.svelte';
import { UPLOAD_CONSENT_VERSION } from '$lib/uploadConsent';

let answer: () => Response;
const fetchMock = vi.fn(async () => answer());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pdf = () => new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
const titles = () => toasts.list.map((t) => t.title);

beforeEach(() => {
  for (const t of [...toasts.list]) toasts.dismiss(t.id);
  fetchMock.mockClear();
  answer = () => json({ doc: { id: 7, name: 'Nota', kind: 'markdown' } }, 201);
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('no consent version → nothing is sent', () => {
  it.each([undefined, 0, -1, 1.5, Number.NaN])('uploadDoc with %p', async (v) => {
    expect(await app.uploadDoc('1', pdf(), 'documento', false, v)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Falta el consentimiento']);
  });

  it.each([undefined, 0])('newDoc with %p', async (v) => {
    expect(await app.newDoc('1', undefined, v)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Falta el consentimiento']);
  });

  it('with the version, the request goes out carrying it', async () => {
    await app.newDoc('1', undefined, UPLOAD_CONSENT_VERSION);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).uploadConsentVersion).toBe(UPLOAD_CONSENT_VERSION);
  });
});

describe('one notice per refusal', () => {
  it('a note refused on another consent version: one notice, the consent one', async () => {
    answer = () => json({ error: 'consent_version_changed' }, 409);
    expect(await app.newDoc('1', undefined, UPLOAD_CONSENT_VERSION)).toBeNull();
    expect(titles()).toEqual(['El consentimiento cambió']);
  });

  it('a note that fails for any other reason: one generic notice', async () => {
    answer = () => json({ error: 'document_create_failed' }, 500);
    expect(await app.newDoc('1', undefined, UPLOAD_CONSENT_VERSION)).toBeNull();
    expect(titles()).toEqual(['No se pudo crear la nota']);
  });

  it('an upload refused on another consent version: one notice', async () => {
    answer = () => json({ error: 'consent_version_changed' }, 409);
    expect(await app.uploadDoc('1', pdf(), 'documento', false, UPLOAD_CONSENT_VERSION)).toBeNull();
    expect(titles()).toEqual(['El consentimiento cambió']);
  });
});
