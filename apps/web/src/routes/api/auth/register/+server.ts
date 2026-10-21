import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * 🔴 SIGN-UP IS CLOSED (UX demo backlog #6, decided 2026-10-21).
 *
 * This route used to proxy to the backend's public `POST /api/users`. The
 * backend now refuses that to everyone but a platform admin, so this answers
 * the same thing up front, in Spanish, without a backend round trip.
 */
const REGISTRATION_CLOSED_MESSAGE =
  'Ya no se pueden crear cuentas desde aquí. Pide a quien administra la plataforma que te cree una cuenta.';

export const POST: RequestHandler = () =>
  json({ error: REGISTRATION_CLOSED_MESSAGE }, { status: 403 });
