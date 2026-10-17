import { describe, expect, it } from 'vitest';

import { mayUploadVoces, mayUploadVocesAnywhere, parseUploadContentKind } from './uploadKind';

describe('parseUploadContentKind', () => {
  it('defaults an absent field to documento', () => {
    for (const raw of [null, undefined, '']) expect(parseUploadContentKind(raw)).toBe('documento');
  });

  it('accepts the two kinds a form may name', () => {
    expect(parseUploadContentKind('documento')).toBe('documento');
    expect(parseUploadContentKind('testimonio')).toBe('testimonio');
  });

  it('🔴 refuses conversacion and anything else', () => {
    for (const raw of ['conversacion', 'Testimonio', 'x', 3]) {
      expect(parseUploadContentKind(raw)).toBeNull();
    }
  });
});

describe('mayUploadVoces', () => {
  const grant = { isPlatformAdmin: false, slugs: ['eco-a'], ok: true };

  it('is per ecosistema', () => {
    expect(mayUploadVoces(grant, 'eco-a')).toBe(true);
    expect(mayUploadVoces(grant, 'eco-b')).toBe(false);
  });

  it('fails closed on a failed read, no slug, or no grant', () => {
    expect(mayUploadVoces({ ...grant, ok: false }, 'eco-a')).toBe(false);
    expect(mayUploadVoces(grant, null)).toBe(false);
    expect(mayUploadVoces(null, 'eco-a')).toBe(false);
  });

  it('lets a platform admin through', () => {
    expect(mayUploadVoces({ isPlatformAdmin: true, slugs: [], ok: true }, null)).toBe(true);
  });

  it('anywhere: any slug, or a platform admin', () => {
    expect(mayUploadVocesAnywhere(grant)).toBe(true);
    expect(mayUploadVocesAnywhere({ ...grant, slugs: [] })).toBe(false);
    expect(mayUploadVocesAnywhere(undefined)).toBe(false);
  });
});
