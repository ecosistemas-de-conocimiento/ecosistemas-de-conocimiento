/**
 * `/admin/evals` — the evals dashboard. 🔴 PLATFORM ADMIN ONLY: anyone else
 * gets the structured 403 (`denyAccess`), whatever their roles. The backend
 * refuses them again on every row and route (`eval-items`, `eval-runs`,
 * `/api/evals/*`), so this check is the page's, not the only one.
 *
 * `?eco=<id>` picks the ecosistema, like `/admin` and `/ajustes`. A run is one
 * ecosistema's whole set, on its budget, after a confirm on the estimate.
 */
import { fail } from '@sveltejs/kit';

import { isPlatformAdmin } from '$lib/components/admin/summary';
import { CONVERSACIONES_HREF } from '$lib/inicio';
import { listAllEcosystems } from '$lib/server/admin';
import { denyAccess } from '$lib/server/deny';
import { estimateRun } from '$lib/server/evals/estimate';
import { activeRunIds, claimRun, enqueueRun, productionTurn, releaseRun } from '$lib/server/evals/runner';
import { makeEvalStore, type EvalStore } from '$lib/server/evals/store';
import type { EvalRun } from '$lib/server/evals/types';
import { fetchEcosystemSettings } from '$lib/server/features';
import type { Actions, PageServerLoad } from './$types';

function guard(locals: App.Locals): void {
  if (!locals.user || !isPlatformAdmin(locals.user)) {
    denyAccess({
      module: 'evals',
      reason: 'not-platform-admin',
      message: 'Esta sección es solo para administración de la plataforma.',
      cta: { label: 'Volver al chat', href: CONVERSACIONES_HREF },
    });
  }
}

/**
 * A queued/running row this process is not running was lost to a restart:
 * mark it failed and delete its eval conversation, whose turns members could
 * otherwise still find in search.
 */
async function reapLostRuns(store: EvalStore, runs: EvalRun[]): Promise<EvalRun[]> {
  const active = activeRunIds();
  return Promise.all(
    runs.map(async (r) => {
      if ((r.status !== 'queued' && r.status !== 'running') || active.has(r.id)) return r;
      if (r.sessionId) await store.deleteSession(r.sessionId);
      await store.updateRun(r.id, { status: 'failed', error: 'interrumpida' });
      return { ...r, status: 'failed' as const, error: 'interrumpida' };
    }),
  );
}

const STYLE_FOR_RUN = (s: { generales: string | null }) => (s.generales?.trim() ? s.generales : null);

export const load: PageServerLoad = async ({ locals, url }) => {
  guard(locals);
  const directory = await listAllEcosystems(locals.token);
  const requested = url.searchParams.get('eco') ?? '';
  const selected = directory.rows.find((e) => e.id === requested) ?? directory.rows[0] ?? null;
  if (!selected) return { state: 'empty' as const, ecosistemas: directory.rows, selected: null };

  const store = makeEvalStore(locals.token);
  const [items, rawRuns, settings] = await Promise.all([
    store.listItems(selected.id),
    store.listRuns(selected.id),
    fetchEcosystemSettings(locals.token, selected.id),
  ]);
  if (items === null || rawRuns === null) {
    return { state: 'unavailable' as const, ecosistemas: directory.rows, selected };
  }
  const runs = await reapLostRuns(store, rawRuns);
  const latest = runs.find((r) => r.status === 'done' || r.status === 'failed') ?? null;
  return {
    state: 'ready' as const,
    ecosistemas: directory.rows,
    selected,
    items,
    // Oldest first, metrics only: the trend lines. The latest keeps its results.
    trend: runs
      .filter((r) => r.status === 'done' && r.metrics)
      .reverse()
      .map((r) => ({ id: r.id, createdAt: r.createdAt, metrics: r.metrics!, costUsd: r.costUsd })),
    latest,
    running: runs.find((r) => r.status === 'queued' || r.status === 'running') ?? null,
    estimate: estimateRun(items, runs),
    hasStyle: STYLE_FOR_RUN(settings.answerStyles) !== null,
  };
};

const text = (form: FormData, k: string) => String(form.get(k) ?? '').trim();

export const actions: Actions = {
  guardar: async ({ locals, request }) => {
    guard(locals);
    const form = await request.formData();
    const organization = text(form, 'organization');
    const id = text(form, 'id') || null;
    const kind = text(form, 'kind') === 'privacidad' ? 'privacidad' : 'pregunta';
    const data =
      kind === 'pregunta'
        ? {
            kind,
            question: text(form, 'question'),
            expectedDocIds: text(form, 'expectedDocIds'),
            shouldRefuse: form.get('shouldRefuse') === 'on',
            notes: text(form, 'notes'),
          }
        : {
            kind,
            text: text(form, 'text'),
            privateNames: text(form, 'privateNames'),
            publicNames: text(form, 'publicNames'),
            gateKind: text(form, 'gateKind') === 'testimonio' ? 'testimonio' : 'documento',
            notes: text(form, 'notes'),
          };
    const res = await makeEvalStore(locals.token).saveItem(organization, id, data);
    if (!res.ok) return fail(400, { scope: 'item' as const, id, message: res.message });
    return { scope: 'item' as const, id, saved: true };
  },
  borrar: async ({ locals, request }) => {
    guard(locals);
    const id = text(await request.formData(), 'id');
    if (!(await makeEvalStore(locals.token).deleteItem(id))) {
      return fail(400, { scope: 'item' as const, id, message: 'No se pudo borrar.' });
    }
    return { scope: 'item' as const, id, deleted: true };
  },
  cargar: async ({ locals, request }) => {
    guard(locals);
    const res = await makeEvalStore(locals.token).seed(text(await request.formData(), 'organization'));
    if (!res.ok) return fail(400, { scope: 'seed' as const, message: res.message });
    return { scope: 'seed' as const, saved: true };
  },
  ejecutar: async ({ locals, request }) => {
    guard(locals);
    const form = await request.formData();
    const organization = text(form, 'organization');
    if (form.get('confirm') !== 'si') return fail(400, { scope: 'run' as const, message: 'Falta confirmar.' });
    // 🔴 Claim BEFORE the first await below: two quick posts both reading "no
    // run yet" would queue two runs. `enqueueRun` takes the claim over.
    if (!claimRun(organization)) return fail(409, { scope: 'run' as const, message: 'Ya hay una ejecución en curso.' });
    const refuse = (status: number, message: string) => (releaseRun(organization), fail(status, { scope: 'run' as const, message }));
    const store = makeEvalStore(locals.token);
    const [items, runs, settings] = await Promise.all([
      store.listItems(organization),
      store.listRuns(organization),
      fetchEcosystemSettings(locals.token, organization),
    ]).catch(() => [null, null, null] as const);
    if (!items || !runs || !settings) return refuse(502, 'No se pudo leer el set.');
    if (items.length === 0) return refuse(400, 'No hay preguntas.');
    const estimate = estimateRun(items, runs);
    const runId = await store
      .createRun(organization, {
        status: 'queued',
        estimateUsd: estimate.usd,
        triggeredBy: locals.user!.id,
        progress: { done: 0, total: items.length },
      })
      .catch(() => null);
    if (!runId) return refuse(502, 'No se pudo crear la ejecución.');
    // The run outlives this request: its own store, same token.
    enqueueRun({
      runId,
      orgId: organization,
      items,
      style: STYLE_FOR_RUN(settings.answerStyles),
      store: makeEvalStore(locals.token),
      turn: productionTurn(locals.user!, locals.token),
    });
    return { scope: 'run' as const, started: true };
  },
};
