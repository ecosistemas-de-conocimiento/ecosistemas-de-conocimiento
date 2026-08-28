import { describe, expect, it } from 'vitest';
import { denyAccess, notFound } from './deny';

// SvelteKit's `error()` throws an `HttpError` shaped `{ status, body }`, where
// `body` is exactly the object we passed. We assert on that thrown shape so the
// `+error.svelte` boundary's `kind`/`module`/`cta` contract stays pinned.

interface ThrownHttpError {
  status: number;
  body: App.Error;
}

function capture(fn: () => never): ThrownHttpError {
  try {
    fn();
  } catch (e) {
    return e as ThrownHttpError;
  }
  throw new Error('expected the helper to throw');
}

describe('denyAccess', () => {
  it('throws a structured 403 with kind=access-denied', () => {
    const err = capture(() => denyAccess({ module: 'chat', reason: 'cross-user' }));
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({
      kind: 'access-denied',
      module: 'chat',
      reason: 'cross-user',
    });
    expect(typeof err.body.message).toBe('string');
  });

  it('uses the provided message and cta', () => {
    const cta = { label: 'Go home', href: '/' };
    const err = capture(() =>
      denyAccess({ module: 'document', message: 'Nope.', cta }),
    );
    expect(err.body.message).toBe('Nope.');
    expect(err.body.cta).toEqual(cta);
  });
});

describe('notFound', () => {
  it('throws a structured 404 with kind=not-found', () => {
    const err = capture(() => notFound({ entity: 'chat' }));
    expect(err.status).toBe(404);
    expect(err.body).toMatchObject({ kind: 'not-found', module: 'chat' });
    // `module` keeps the machine word; the COPY gets the Spanish noun phrase.
    expect(err.body.message).toContain('esa conversación');
  });

  it('defaults entity/module to "page" when omitted', () => {
    const err = capture(() => notFound());
    expect(err.status).toBe(404);
    expect(err.body.module).toBe('page');
    expect(err.body.message).toContain('esa página');
  });

  it('never prints an unmapped machine entity at the user', () => {
    const err = capture(() => notFound({ entity: 'widget' }));
    expect(err.body.module).toBe('widget');
    expect(err.body.message).not.toContain('widget');
    expect(err.body.message).toContain('lo que buscas');
  });
});

// 🔴 The whole product is Spanish. A boundary that falls back to English is
// exactly the gap this branch closed, so pin the defaults.
describe('default copy', () => {
  it('is Spanish on both helpers', () => {
    const denied = capture(() => denyAccess({ module: 'chat' }));
    const missing = capture(() => notFound());
    expect(denied.body.message).toContain('No tienes acceso');
    expect(missing.body.message).toContain('No encontramos');
  });
});
