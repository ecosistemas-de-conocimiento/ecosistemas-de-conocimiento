import { describe, expect, it, vi } from 'vitest';

import { guardLeave, LEAVE_PROMPT } from './unsaved';

const nav = (type: string) => ({ type, cancel: vi.fn() });

describe('/ajustes — leaving with unsaved changes', () => {
  it('lets every navigation through when nothing is unsaved (e.g. after a save)', () => {
    const ask = vi.fn(() => false);
    for (const type of ['link', 'leave', 'popstate', 'goto']) {
      const n = nav(type);
      guardLeave(false, n, ask);
      expect(n.cancel).not.toHaveBeenCalled();
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks before an in-app navigation and stays when the answer is no', () => {
    const ask = vi.fn(() => false);
    const n = nav('link');
    guardLeave(true, n, ask);
    expect(ask).toHaveBeenCalledWith(LEAVE_PROMPT);
    expect(n.cancel).toHaveBeenCalledOnce();
  });

  it('leaves when the answer is yes', () => {
    const n = nav('popstate');
    guardLeave(true, n, () => true);
    expect(n.cancel).not.toHaveBeenCalled();
  });

  it('hands a reload or tab close to the browser prompt, without a confirm', () => {
    const ask = vi.fn(() => true);
    const n = nav('leave');
    guardLeave(true, n, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(n.cancel).toHaveBeenCalledOnce();
  });

  it('uses the minimal copy', () => {
    expect(LEAVE_PROMPT).toBe('Hay cambios sin guardar. ¿Salir?');
  });
});
