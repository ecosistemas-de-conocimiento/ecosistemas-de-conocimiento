import { describe, expect, it } from 'vitest';

import { AUDIO_EXTENSIONS, UPLOAD_ACCEPT } from './config';
import {
  AUDIO_UPLOAD_ENABLED,
  looseUploadErrorCopy,
  mayUploadVoces,
  mayUploadVocesAnywhere,
  parseUploadContentKind,
  uploadAccept,
  uploadButtonTitle,
} from './uploadKind';

describe('audio upload switch (UX demo backlog #8)', () => {
  it('🔴 is OFF unless PUBLIC_AUDIO_UPLOAD_ENABLED=1', () => {
    expect(AUDIO_UPLOAD_ENABLED).toBe(false);
  });

  it('with audio off, the picker offers only the document kinds', () => {
    expect(uploadAccept(UPLOAD_ACCEPT, AUDIO_EXTENSIONS, false).split(',')).toEqual([
      'application/pdf',
      '.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xlsx',
      'text/csv',
      '.csv',
      'text/html',
      '.html',
      '.htm',
      'text/markdown',
      '.md',
      '.markdown',
    ]);
  });

  it('with audio on, the picker keeps the full list', () => {
    expect(uploadAccept(UPLOAD_ACCEPT, AUDIO_EXTENSIONS, true)).toBe(UPLOAD_ACCEPT);
  });

  it('Mis documentos upload errors are Spanish and never echo the code', () => {
    for (const code of ['ecosystem_forbidden', 'unsupported_kind', 'file_too_large', 'boom', null]) {
      const copy = looseUploadErrorCopy(code, '20.0 MB');
      expect(`${copy.title} ${copy.message}`).not.toMatch(/_|boom/);
    }
    expect(looseUploadErrorCopy('unsupported_kind', '').message).not.toMatch(/audio/i);
  });

  it('the tooltip names audio only when audio is on', () => {
    expect(uploadButtonTitle(false)).not.toMatch(/audio|MP3/i);
    expect(uploadButtonTitle(true)).toMatch(/audio/);
  });
});

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
