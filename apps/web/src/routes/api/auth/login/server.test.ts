import { beforeEach, describe, expect, it, vi } from 'vitest';

const signIn = vi.fn();
vi.mock('$lib/server/auth', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  authErrorMessage: (code: string) => code,
}));
vi.mock('$app/environment', () => ({ dev: true }));

const { POST } = await import('./+server');

const call = () =>
  POST({
    request: new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.invalid', password: 'x' }),
    }),
    cookies: {},
  } as never);

describe('POST /api/auth/login', () => {
  beforeEach(() => signIn.mockReset());

  it('a rate-limited sign-in carries Retry-After', async () => {
    signIn.mockResolvedValue({ ok: false, status: 429, error: 'rate-limited', retryAfterSeconds: 1800 });
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1800');
  });

  it('a wrong password carries none', async () => {
    signIn.mockResolvedValue({ ok: false, status: 401, error: 'login-failed' });
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
