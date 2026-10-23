import { afterEach, describe, expect, it, vi } from 'vitest';
import { isActionFailure, isRedirect } from '@sveltejs/kit';

/**
 * 🔴 The no-JS sign-in path. A submit before hydration used to go out as a GET,
 * putting the email and password in the URL (and every server and proxy log).
 * The form now posts to the default action here, which must sign in exactly
 * like `/api/auth/login`, and a GET must never sign anyone in.
 */

vi.mock('$env/dynamic/private', () => ({ env: { BACKEND_URL: 'http://backend.test:3002' } }));

const { actions, load } = await import('./+page.server');
const { POST: loginApi } = await import('../api/auth/login/+server');

const EMAIL = 'ana@example.org';
const PASSWORD = 'secreto-muy-largo-123';

function backendReplies(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function fakeCookies() {
  const set = vi.fn();
  return { set, get: vi.fn(), delete: vi.fn() };
}

function formPost(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return new Request('http://edc.test/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function runAction(request: Request, cookies = fakeCookies()) {
  try {
    const out = await actions.default!({ request, cookies } as never);
    return { out, cookies };
  } catch (thrown) {
    return { thrown, cookies };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/sign-in form action (no JS)', () => {
  it('signs in, sets the same session cookie as the API, and redirects to /', async () => {
    const fetchFn = backendReplies(200, { token: 'jwt-abc', user: { id: 1, email: EMAIL } });
    const { thrown, cookies } = await runAction(formPost({ email: EMAIL, password: PASSWORD }));

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { status: number; location: string }).status).toBe(303);
    expect((thrown as { location: string }).location).toBe('/');
    expect(fetchFn).toHaveBeenCalledOnce();

    // Same cookie the JSON endpoint sets.
    const apiCookies = fakeCookies();
    backendReplies(200, { token: 'jwt-abc', user: { id: 1, email: EMAIL } });
    const res = await loginApi({
      request: new Request('http://edc.test/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
      cookies: apiCookies,
    } as never);
    expect(res.status).toBe(200);
    expect(cookies.set.mock.calls).toEqual(apiCookies.set.mock.calls);
    const [name, , opts] = cookies.set.mock.calls[0]!;
    expect(name).toBe('chat_auth');
    expect(opts).toMatchObject({ httpOnly: true, path: '/' });
  });

  it('a wrong password fails in Spanish, sets no cookie, echoes no credentials, logs none', async () => {
    backendReplies(401, { errors: [{ message: 'The email or password provided is incorrect.' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { out, cookies } = await runAction(formPost({ email: EMAIL, password: PASSWORD }));

    expect(isActionFailure(out)).toBe(true);
    expect((out as { status: number }).status).toBe(401);
    expect((out as { data: { error: string } }).data.error).toContain('no coinciden');
    expect(cookies.set).not.toHaveBeenCalled();

    const echoed = JSON.stringify(out);
    const logged = JSON.stringify([warn.mock.calls, log.mock.calls, err.mock.calls]);
    for (const secret of [EMAIL, PASSWORD]) {
      expect(echoed).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  it('empty fields fail without calling the backend', async () => {
    const fetchFn = backendReplies(200, {});
    const { out } = await runAction(formPost({ email: '', password: '' }));
    expect(isActionFailure(out)).toBe(true);
    expect((out as { status: number }).status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('/sign-in GET', () => {
  it('never signs in from query credentials, and strips them from the URL', async () => {
    const fetchFn = backendReplies(200, { token: 'jwt-abc', user: { id: 1, email: EMAIL } });
    const url = new URL(
      `http://edc.test/sign-in?email=${encodeURIComponent(EMAIL)}&password=${PASSWORD}`,
    );
    let thrown: unknown;
    try {
      await load({ locals: { user: null }, url } as never);
    } catch (e) {
      thrown = e;
    }
    expect(isRedirect(thrown)).toBe(true);
    const location = (thrown as { location: string }).location;
    expect(location).toBe('/sign-in');
    expect(location).not.toContain(PASSWORD);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps the "registro cerrado" note link working', async () => {
    const url = new URL('http://edc.test/sign-in?registro=cerrado');
    await expect(load({ locals: { user: null }, url } as never)).resolves.toEqual({});
  });
});
