import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { readable } from 'svelte/store';

/**
 * 🔴 The server-rendered sign-in form is what a person can press before the
 * script hydrates, and all they get with JS off. Its "Entrar" button must be
 * live there: the native submit is a POST to the form action
 * (`+page.server.ts`), never a GET with the password in the URL.
 */

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({
  page: readable({ url: new URL('http://edc.test/sign-in') }),
}));

const { default: SignIn } = await import('./+page.svelte');

describe('/sign-in page before hydration (SSR)', () => {
  const { body } = render(SignIn, { props: { form: null } });

  it('posts the form natively', () => {
    expect(body).toMatch(/<form[^>]*method="post"/);
  });

  it('leaves "Entrar" enabled', () => {
    const button = body.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toMatch(/disabled/);
  });

  it("shows the form action's error after a failed no-JS submit", () => {
    const { body: failed } = render(SignIn, {
      props: { form: { error: 'Correo o contraseña incorrectos.' } },
    });
    expect(failed).toContain('Correo o contraseña incorrectos.');
  });
});
