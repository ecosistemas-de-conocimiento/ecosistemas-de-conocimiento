import { describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

import { GET } from './+server';
import { POST as register } from '../api/auth/register/+server';

/** 🔴 Sign-up is closed (UX backlog #6). Both doors say so; neither creates an account. */
describe('closed sign-up', () => {
  it('/sign-up sends old links to sign-in with the "closed" note', () => {
    let thrown: unknown;
    try {
      GET({} as Parameters<typeof GET>[0]);
    } catch (err) {
      thrown = err;
    }
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { location: string }).location).toBe('/sign-in?registro=cerrado');
  });

  it('/api/auth/register refuses in plain Spanish, without calling the backend', async () => {
    const res = await register({} as Parameters<typeof register>[0]);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // Only a PLATFORM admin creates accounts — an ecosistema admin cannot.
    expect(body.error).toContain('Pide a quien administra la plataforma');
  });
});
