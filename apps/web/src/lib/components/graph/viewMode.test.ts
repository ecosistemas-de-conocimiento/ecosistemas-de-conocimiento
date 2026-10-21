import { describe, expect, it } from 'vitest';

import {
  NO_WEBGL_COPY,
  VIEW_MODE_KEY,
  readViewMode,
  resolveViewMode,
  webglAvailable,
  writeViewMode,
} from './viewMode';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('the 2D / 3D choice, per viewer', () => {
  it('remembers 3D, and reads it back', () => {
    const store = memory();
    writeViewMode(() => store, '3d');
    expect(store.data.get(VIEW_MODE_KEY)).toBe('3d');
    expect(readViewMode(() => store)).toBe('3d');
  });

  it('defaults to 2D: nothing stored, junk stored, or no storage at all', () => {
    expect(readViewMode(() => memory())).toBe('2d');
    expect(readViewMode(() => memory({ [VIEW_MODE_KEY]: 'cuatro-d' }))).toBe('2d');
    expect(readViewMode(() => null)).toBe('2d');
    expect(readViewMode(() => undefined)).toBe('2d');
  });

  it('never throws, whatever storage does', () => {
    expect(readViewMode(() => throwing)).toBe('2d');
    expect(() => writeViewMode(() => throwing, '3d')).not.toThrow();
    expect(
      readViewMode(() => {
        throw new Error('localStorage is not defined');
      }),
    ).toBe('2d');
  });
});

describe('WebGL fallback', () => {
  it('3D where WebGL exists; 2D plus the one line where it does not', () => {
    expect(resolveViewMode('3d', true)).toEqual({ mode: '3d', fallback: false });
    expect(resolveViewMode('3d', false)).toEqual({ mode: '2d', fallback: true });
    expect(resolveViewMode('2d', false)).toEqual({ mode: '2d', fallback: false });
    expect(NO_WEBGL_COPY).toBe('Tu navegador no puede mostrar 3D.');
  });

  it('detects WebGL 2, then WebGL 1; no context, no canvas or a throw is none', () => {
    expect(webglAvailable(() => ({ getContext: (id) => (id === 'webgl2' ? {} : null) }))).toBe(true);
    expect(webglAvailable(() => ({ getContext: (id) => (id === 'webgl' ? {} : null) }))).toBe(true);
    expect(webglAvailable(() => ({ getContext: () => null }))).toBe(false);
    // The probe context is released, so it never counts against the browser's cap.
    let lost = 0;
    const gl = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: () => void lost++ } : null) };
    expect(webglAvailable(() => ({ getContext: () => gl }))).toBe(true);
    expect(lost).toBe(1);
    expect(webglAvailable(() => null)).toBe(false);
    expect(
      webglAvailable(() => ({
        getContext: () => {
          throw new Error('blocked');
        },
      })),
    ).toBe(false);
  });
});
