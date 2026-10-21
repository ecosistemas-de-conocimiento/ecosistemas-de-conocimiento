import { describe, expect, it } from 'vitest';
import { uploadErrorToast } from './uploadErrors';

describe('uploadErrorToast fallback (UX backlog #26)', () => {
  it('never shows "Error inesperado" or an HTTP number', () => {
    for (const status of [400, 500, 502, 503]) {
      const t = uploadErrorToast(`http_${status}`, status);
      expect(`${t.title} ${t.message}`).not.toMatch(/inesperado|HTTP|\d{3}/);
    }
  });

  it('reads a bare 413 as "too large" and a bare 401 as "session expired"', () => {
    expect(uploadErrorToast('http_413', 413).title).toBe('El archivo es muy grande');
    expect(uploadErrorToast('http_401', 401).title).toBe('Tu sesión expiró');
  });
});
