/**
 * R4-14 (review of ola 4, 2026-11-10): "Anonimizar" was on by default in
 * `UploadSheet` and off in the conversation's panel. ADR-0020 sets the most
 * protective value on both upload screens. SSR render, someone who holds
 * `voces:upload` (the only one who sees the choice).
 */
import { describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
  page: readable({ data: { vocesUpload: { ok: true, isPlatformAdmin: true, slugs: [] } } }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import { render } from 'svelte/server';
import DocsPanel from './DocsPanel.svelte';
import { app } from '$lib/stores/app.svelte';

describe('DocsPanel — "Anonimizar" for a documento', () => {
  it('starts on', () => {
    app.sessions = [{ id: '1', title: 'C', createdAt: 0, updatedAt: 0, messages: [], docs: [] }];
    app.activeSessionId = '1';
    app.docsPanelOpen = true;
    const html = render(DocsPanel, { props: {} }).body;
    const box = /<input[^>]*data-testid="panel-anonymise"[^>]*>/.exec(html)?.[0];
    expect(box).toBeDefined();
    expect(box).toMatch(/\bchecked\b/);
  });
});
