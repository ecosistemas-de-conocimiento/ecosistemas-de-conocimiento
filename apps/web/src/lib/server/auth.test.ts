import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE COPY-LEAK TEST.
 *
 * `/sign-in` and `/sign-up` are the first screens anyone sees on a
 * Spanish-language product, and everything they can print comes from here.
 * Two things must hold, and neither is checkable by reading the happy path:
 *
 *  1. The backend's own words NEVER reach the user. Payload answers in English
 *     ("The email or password provided is incorrect."), and a thrown fetch
 *     answers with our plumbing ("fetch failed"). Both are classified into a
 *     code here; the English lands in `detail`, which only the log reads.
 *
 *  2. The classification is not flattened. A wrong password, a locked account,
 *     an already-taken email and an unreachable backend are four different
 *     situations that need four different instructions from the user. The
 *     bodies asserted below are the real ones, captured from the running
 *     backend at :45402.
 */

vi.mock('$env/dynamic/private', () => ({ env: { BACKEND_URL: 'http://backend.test:3002' } }));

const {
  AUTH_ERROR_COPY,
  authErrorMessage,
  loginWithBackend,
  registerWithBackend,
} = await import('./auth');

/** Stub `fetch` with a JSON body + status, the way Payload replies. */
function replyOnce(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Payload's 401 for a rejected login. */
const WRONG_PASSWORD = { errors: [{ message: 'The email or password provided is incorrect.' }] };
/** Payload's 401 once `maxLoginAttempts` trips. */
const LOCKED = {
  errors: [{ message: 'This user is locked due to having too many failed login attempts.' }],
};
/** Payload's 400 `ValidationError` — the useful sentence is nested under `data`. */
function validationError(field: string, message: string) {
  return {
    errors: [
      {
        message: `The following field is invalid: ${field}`,
        data: { collection: 'users', errors: [{ message, path: field }] },
      },
    ],
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loginWithBackend', () => {
  it('returns the token and user on success', async () => {
    replyOnce(200, { token: 'jwt', user: { id: 1, email: 'a@b.mx' } });
    const res = await loginWithBackend('a@b.mx', 'unaClaveLarga');
    expect(res).toMatchObject({ ok: true, token: 'jwt' });
    expect(res.failure).toBeUndefined();
  });

  it('classifies a rejected password as invalid-credentials', async () => {
    replyOnce(401, WRONG_PASSWORD);
    const res = await loginWithBackend('a@b.mx', 'mala');
    expect(res.failure).toBe('invalid-credentials');
  });

  it('separates a locked account from a wrong password', async () => {
    replyOnce(401, LOCKED);
    const res = await loginWithBackend('a@b.mx', 'mala');
    // Same status, opposite instruction: "wait" vs "check your password".
    expect(res.failure).toBe('account-locked');
    expect(AUTH_ERROR_COPY['account-locked']).not.toBe(
      AUTH_ERROR_COPY['invalid-credentials'],
    );
  });

  it('classifies a 5xx as a server problem, not a bad password', async () => {
    replyOnce(500, { message: 'Internal Server Error' });
    expect((await loginWithBackend('a@b.mx', 'x')).failure).toBe('server');
  });

  it('classifies a thrown fetch as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const res = await loginWithBackend('a@b.mx', 'x');
    expect(res.failure).toBe('unreachable');
    expect(res.detail).toBe('fetch failed');
  });

  it('keeps the backend English in detail and out of the copy', async () => {
    replyOnce(401, WRONG_PASSWORD);
    const res = await loginWithBackend('a@b.mx', 'mala');
    expect(res.detail).toContain('The email or password provided is incorrect.');
    expect(authErrorMessage(res.failure!)).not.toMatch(/[Tt]he email/);
  });
});

describe('registerWithBackend', () => {
  it('classifies a duplicate email', async () => {
    replyOnce(
      400,
      validationError('email', 'A user with the given email is already registered.'),
    );
    expect((await registerWithBackend('a@b.mx', 'unaClaveLarga', 'A')).failure).toBe(
      'email-taken',
    );
  });

  it('classifies a malformed email', async () => {
    replyOnce(400, validationError('Email', 'Please enter a valid email address.'));
    expect((await registerWithBackend('no-es-correo', 'unaClaveLarga', 'A')).failure).toBe(
      'email-invalid',
    );
  });

  it('classifies the allowed-domain fence', async () => {
    // Thrown by `Users.beforeValidate` when IDENTITY_ALLOWED_EMAIL_DOMAIN is set.
    replyOnce(400, validationError('email', 'Only @cide.edu addresses may sign up.'));
    const res = await registerWithBackend('a@gmail.com', 'unaClaveLarga', 'A');
    expect(res.failure).toBe('email-domain');
    // The fenced domain is an installation detail; it must not be echoed back.
    expect(authErrorMessage('email-domain')).not.toContain('cide.edu');
  });

  it('classifies an unreachable backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect((await registerWithBackend('a@b.mx', 'unaClaveLarga', 'A')).failure).toBe(
      'unreachable',
    );
  });
});

describe('AUTH_ERROR_COPY', () => {
  const entries = Object.entries(AUTH_ERROR_COPY);

  it('is Spanish everywhere — no English fallback survives', () => {
    for (const [code, text] of entries) {
      expect(text, code).not.toMatch(
        /\b(failed|invalid|required|password|email|error|incorrect|locked|registered|sign|try again)\b/i,
      );
    }
  });

  it('never names our plumbing', () => {
    for (const [code, text] of entries) {
      expect(text, code).not.toMatch(/fetch|HTTP|JSON|401|500|backend|token/i);
    }
  });

  it('tells the person what to do next', () => {
    // Every line ends on an action, not a diagnosis. A message with no next
    // move is the same as no message.
    for (const [code, text] of entries) {
      expect(
        /inténtalo|intentarlo|revisa|recarga|escribe|espera|inicia sesión|usa otro|avisa|pide/i.test(
          text,
        ),
        `${code} offers no next step: ${text}`,
      ).toBe(true);
    }
  });

  it('gives the four common failures four different sentences', () => {
    const four = [
      AUTH_ERROR_COPY['invalid-credentials'],
      AUTH_ERROR_COPY['account-locked'],
      AUTH_ERROR_COPY['email-taken'],
      AUTH_ERROR_COPY.unreachable,
    ];
    expect(new Set(four).size).toBe(4);
  });
});
