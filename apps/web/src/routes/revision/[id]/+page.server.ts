/**
 * `/revision/[id]` — read ONE held document, and decide about it.
 *
 * ── 🔴 WHY THE DECISION IS A FORM ACTION AND NOT A `fetch` ─────────────────
 *
 * Approving is a human overriding a fail-closed safety gate. It has to work on
 * a cheap phone with flaky JavaScript, and the thing that always works is a
 * `<form method="post">`. The action runs on the server, forwards the caller's
 * JWT to `POST /api/holds/:id`, and redirects — so a refresh cannot re-submit
 * a decision, and the person never sees a half-applied screen.
 *
 * ── ⚠ THE ACCESS CHECK IS THE BACKEND'S, NOT OURS ──────────────────────────
 *
 * There is no ecosistema check in this file, and that is deliberate rather than
 * missing: `GET /api/holds/:id` resolves the document's own ecosistema and
 * refuses with 404 if the caller may not review there. Re-deriving that here
 * would mean a second, independently-wrong copy of the rule. What this route
 * adds is the capability pre-check, so somebody with no reviewing role
 * anywhere meets a sentence rather than a "no encontramos" they will read as a
 * bug.
 *
 * 🔴 A REFUSAL RENDERS AS "no encontramos", NEVER AS "no tienes permiso". The
 * backend folds five different reasons into one 404 precisely so this screen
 * cannot be used to find out whether an id is real. Splitting them here would
 * hand that back.
 */

import { fail, redirect } from '@sveltejs/kit';

import { denyAccess, notFound } from '$lib/server/deny';
import {
  decideHold,
  mayReviewAnywhere,
  readHold,
  readReviewCapability,
} from '$lib/server/holds';
import { DECISION_FAILED, MAX_NOTE_LENGTH, NOT_A_REVIEWER } from '$lib/holds';
import type { Actions, PageServerLoad } from './$types';

async function requireReviewer(locals: App.Locals) {
  const capability = locals.user ? await readReviewCapability(locals.token) : null;
  if (!capability || !mayReviewAnywhere(capability)) {
    denyAccess({
      module: 'holds',
      reason: 'no-holds-review',
      message: NOT_A_REVIEWER,
      cta: { label: 'Volver al chat', href: '/' },
    });
  }
}

export const load: PageServerLoad = async ({ locals, params }) => {
  await requireReviewer(locals);

  const result = await readHold(locals.token, String(params.id ?? ''));
  if (result.state === 'not-found') {
    notFound({
      entity: 'document',
      module: 'holds',
      message:
        'No encontramos este documento retenido. Puede que alguien ya lo haya revisado.',
      cta: { label: 'Volver a la lista', href: '/revision' },
    });
  }
  if (result.state === 'unavailable') {
    return { state: 'unavailable' as const, hold: null };
  }
  return { state: 'ready' as const, hold: result.value };
};

/**
 * 🔴 THE BODY IS BUILT HERE FROM WHAT THE FORM SENT, AND NOTHING ELSE.
 *
 * In particular: on a REJECTION no `text` is forwarded at all, and on an
 * approval the text is forwarded ONLY when the reviewer actually changed it.
 * An absent `text` tells the backend to release its own refused output, which
 * it already holds — see `decideOnHold`. There is no branch in this file that
 * could reach for the original, because this app never receives it.
 */
export const actions: Actions = {
  decide: async ({ locals, params, request }) => {
    await requireReviewer(locals);

    const form = await request.formData();
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'reject') {
      return fail(400, { message: 'Elige aprobar o rechazar.' });
    }

    const note = String(form.get('note') ?? '').trim().slice(0, MAX_NOTE_LENGTH);
    const text = String(form.get('text') ?? '');
    const original = form.get('original');
    // ⚠ `original` is what the server sent this browser. Comparing against it
    // is what makes `textEdited` on the audit row mean something: a reviewer
    // who changed nothing must not be recorded as having rewritten the
    // redaction.
    const edited = typeof original !== 'string' || text !== original;

    const body: { decision: 'approve' | 'reject'; text?: string; note?: string } = { decision };
    if (note) body.note = note;
    if (decision === 'approve') {
      if (text.trim() === '') {
        return fail(400, {
          message:
            'No puedes aprobar un texto vacío. Escribe la versión corregida, o rechaza el documento.',
        });
      }
      if (edited) body.text = text;
    }

    const result = await decideHold(locals.token, String(params.id ?? ''), body);

    if (result.state === 'rejected-input') return fail(400, { message: result.message });
    if (result.state === 'not-found') {
      return fail(404, {
        message: 'Este documento ya no está retenido. Puede que alguien lo haya revisado antes que tú.',
      });
    }
    if (result.state === 'unavailable') return fail(502, { message: DECISION_FAILED });

    // A redirect, so refreshing the page cannot repeat a decision that has
    // already been audited.
    redirect(303, `/revision?hecho=${result.value.decision}`);
  },
};
