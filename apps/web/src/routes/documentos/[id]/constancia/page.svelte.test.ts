import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

import { uploadConsentText } from '$lib/uploadConsent';

const { default: Page } = await import('./+page.svelte');

const receipt = {
  id: 123,
  folio: 'EDC-2026-000123',
  consentVersion: 1,
  contentKind: 'testimonio' as const,
  acceptedAt: '2026-11-12T18:00:00.000Z',
  ecosystem: { id: 3, name: 'Semiosis' },
};
const document = { kind: 'audio', contentKind: 'testimonio' as const, createdAt: '2026-11-12T18:00:00.000Z', title: null };

const body = (constancia: unknown) => render(Page, { props: { data: { constancia } } as never }).body;

describe('/documentos/[id]/constancia page', () => {
  it('shows folio as given, version, ecosistema, document n.º and the consent text of that version', () => {
    const b = body({ documentId: 456, receipt, document });
    expect(b).toMatch(/data-testid="constancia-folio"[^>]*>EDC-2026-000123</);
    expect(b).toMatch(/EDC-\d{4}-\d{6}/);
    expect(b).toContain('Semiosis');
    expect(b).toContain('456');
    expect(b).toContain(uploadConsentText('testimonio', 1));
    expect(b).toContain('Descargar');
  });

  it('🔴 a null title is «Testimonio», never a filename', () => {
    const b = body({ documentId: 456, receipt, document: { ...document, title: null } });
    expect(b).toMatch(/data-testid="constancia-title"[^>]*>Testimonio</);
    expect(b).not.toMatch(/\.(mp3|m4a|wav|webm|pdf)/);
  });

  it('a readable title is shown', () => {
    const b = body({ documentId: 9, receipt: { ...receipt, contentKind: 'documento' }, document: { ...document, kind: 'pdf', contentKind: 'documento', title: 'Informe' } });
    expect(b).toMatch(/data-testid="constancia-title"[^>]*>Informe</);
    expect(b).toContain(uploadConsentText('documento', 1));
  });

  it('receipt null says there is no consent record', () => {
    const b = body({ documentId: 8, receipt: null, document: { ...document, title: 'Viejo' } });
    expect(b).toContain('Sin registro de consentimiento');
    expect(b).not.toContain('anterior al');
    expect(b).not.toContain('constancia-folio');
  });

  it('has a print stylesheet that hides the chrome', () => {
    const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
    expect(src).toMatch(/@media print\s*\{[\s\S]*primary-nav[\s\S]*display: none/);
    expect(src).toContain('window.print()');
  });
});
