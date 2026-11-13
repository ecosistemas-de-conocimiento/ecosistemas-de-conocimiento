import { describe, expect, it } from 'vitest';

import { DERECHOS, NOTICE_PARTS, PRIVACY_NOTICE_DRAFT_LABEL, hrefOf, pendingItems, segments } from './privacyNotice';

const allText = JSON.stringify(NOTICE_PARTS);

describe('privacy notice content', () => {
  it('is the integral, the simplificado and «Tus derechos», marked as a draft', () => {
    expect(NOTICE_PARTS.map((p) => p.id)).toEqual(['integral', 'simplificado', 'derechos']);
    expect(DERECHOS.title).toBe('Tus derechos');
    expect(PRIVACY_NOTICE_DRAFT_LABEL).toBe('Borrador sin validación jurídica');
  });

  it('🔴 ARCO deadlines say «días», never «días hábiles»', () => {
    expect(allText).not.toMatch(/h[áa]bil/i);
    expect(JSON.stringify(DERECHOS)).toContain('20 días');
  });

  it('names the Unidad de Transparencia del CIDE as the contact', () => {
    expect(allText).toContain('Unidad de Transparencia del CIDE');
    expect(allText).toContain('unidad.enlace@cide.edu');
    expect(allText).toContain('(55) 5727 9800, ext. 2451 y 2402');
  });

  it('keeps the gaps visible as [POR DEFINIR: …]', () => {
    const pending = pendingItems();
    expect(pending.length).toBeGreaterThan(10);
    for (const p of pending) expect(p).toMatch(/^\[POR DEFINIR: .+\]$/);
  });
});

describe('segments', () => {
  it('splits gaps, URLs and the e-mail address out of the text', () => {
    expect(segments('A [POR DEFINIR: x]. Ver https://a.mx/b y c.d@cide.edu.')).toEqual([
      { kind: 'text', value: 'A ' },
      { kind: 'pending', value: '[POR DEFINIR: x]' },
      { kind: 'text', value: '. Ver ' },
      { kind: 'link', value: 'https://a.mx/b' },
      { kind: 'text', value: ' y ' },
      { kind: 'link', value: 'c.d@cide.edu' },
      { kind: 'text', value: '.' },
    ]);
    expect(hrefOf('c.d@cide.edu')).toBe('mailto:c.d@cide.edu');
    expect(hrefOf('https://a.mx/b')).toBe('https://a.mx/b');
  });
});
