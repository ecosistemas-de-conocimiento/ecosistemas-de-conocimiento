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
    expect(err.body.message).toContain('chat');
  });

  it('defaults entity/module to "page" when omitted', () => {
    const err = capture(() => notFound());
    expect(err.status).toBe(404);
    expect(err.body.module).toBe('page');
  });
});
