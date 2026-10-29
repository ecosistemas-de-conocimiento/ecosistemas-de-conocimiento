/**
 * The backend reads and writes of the evals dashboard, as the signed-in
 * platform admin (`backendFetch` with their token). The backend refuses
 * everyone else (`eval-items`, `eval-runs`, `/api/evals/*`).
 */
import { backendFetch } from '$lib/server/auth';
import type { EvalItem, EvalRun, GateTermVerdict } from './types';

const json = { 'content-type': 'application/json' };

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
  return body?.errors?.[0]?.message ?? `backend ${res.status}`;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x)) : []);

export function toItem(row: Record<string, unknown>): EvalItem {
  return {
    id: String(row.id),
    kind: row.kind === 'privacidad' ? 'privacidad' : 'pregunta',
    question: typeof row.question === 'string' ? row.question : '',
    expectedDocIds: ints(row.expectedDocIds),
    shouldRefuse: row.shouldRefuse === true,
    notes: typeof row.notes === 'string' ? row.notes : '',
    text: typeof row.text === 'string' ? row.text : '',
    privateNames: strings(row.privateNames),
    publicNames: strings(row.publicNames),
    gateKind: row.gateKind === 'testimonio' ? 'testimonio' : 'documento',
  };
}

export function toRun(row: Record<string, unknown>): EvalRun {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const status = ['queued', 'running', 'done', 'failed'].includes(String(row.status)) ? (row.status as EvalRun['status']) : 'failed';
  return {
    id: String(row.id),
    status,
    createdAt: str(row.createdAt) ?? '',
    startedAt: str(row.startedAt),
    finishedAt: str(row.finishedAt),
    estimateUsd: num(row.estimateUsd),
    costUsd: num(row.costUsd),
    progress: (row.progress as EvalRun['progress']) ?? null,
    models: (row.models as EvalRun['models']) ?? null,
    commitSha: str(row.commitSha),
    sessionId: row.sessionId == null || row.sessionId === '' ? null : String(row.sessionId),
    metrics: (row.metrics as EvalRun['metrics']) ?? null,
    results: Array.isArray(row.results) ? (row.results as EvalRun['results']) : [],
    error: str(row.error),
  };
}

export interface EvalStore {
  listItems(orgId: string): Promise<EvalItem[] | null>;
  saveItem(orgId: string, id: string | null, data: Record<string, unknown>): Promise<{ ok: true } | { ok: false; message: string }>;
  deleteItem(id: string): Promise<boolean>;
  seed(orgId: string): Promise<{ ok: true } | { ok: false; message: string }>;
  listRuns(orgId: string, limit?: number): Promise<EvalRun[] | null>;
  createRun(orgId: string, data: Record<string, unknown>): Promise<string | null>;
  updateRun(id: string, data: Record<string, unknown>): Promise<boolean>;
  /** The conversation for a RUNNING run's turns, bound to it by the backend (R77). */
  createSession(runId: string): Promise<string>;
  deleteSession(id: string): Promise<void>;
  gate(itemId: string): Promise<{ status: 'ready' | 'hold'; stage?: string; detector: string; model: string | null; terms: GateTermVerdict[] }>;
  expansionCost(messageId: string): Promise<number>;
}

export function makeEvalStore(token: string | undefined): EvalStore {
  const call = (path: string, init: RequestInit = {}) => backendFetch(token, path, init);
  return {
    async listItems(orgId) {
      const qs = new URLSearchParams({ 'where[organization][equals]': orgId, limit: '200', sort: 'createdAt', depth: '0' });
      const res = await call(`/api/eval-items?${qs}`, { method: 'GET' }).catch(() => null);
      if (!res?.ok) return null;
      return (((await res.json()) as { docs?: Record<string, unknown>[] }).docs ?? []).map(toItem);
    },
    async saveItem(orgId, id, data) {
      const res = await call(id ? `/api/eval-items/${encodeURIComponent(id)}` : '/api/eval-items', {
        method: id ? 'PATCH' : 'POST',
        headers: json,
        body: JSON.stringify(id ? data : { ...data, organization: Number(orgId) }),
      });
      return res.ok ? { ok: true } : { ok: false, message: await errorText(res) };
    },
    async deleteItem(id) {
      const res = await call(`/api/eval-items/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
      return Boolean(res?.ok);
    },
    async seed(orgId) {
      const res = await call('/api/evals/seed', { method: 'POST', headers: json, body: JSON.stringify({ organization: Number(orgId) }) });
      return res.ok ? { ok: true } : { ok: false, message: await errorText(res) };
    },
    async listRuns(orgId, limit = 12) {
      const qs = new URLSearchParams({ 'where[organization][equals]': orgId, limit: String(limit), sort: '-createdAt', depth: '0' });
      const res = await call(`/api/eval-runs?${qs}`, { method: 'GET' }).catch(() => null);
      if (!res?.ok) return null;
      return (((await res.json()) as { docs?: Record<string, unknown>[] }).docs ?? []).map(toRun);
    },
    async createRun(orgId, data) {
      const res = await call('/api/eval-runs', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ ...data, organization: Number(orgId) }),
      }).catch(() => null);
      if (!res?.ok) return null;
      const id = ((await res.json()) as { doc?: { id?: unknown } }).doc?.id;
      return id == null ? null : String(id);
    },
    async updateRun(id, data) {
      const res = await call(`/api/eval-runs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify(data),
      }).catch(() => null);
      return Boolean(res?.ok);
    },
    async createSession(runId) {
      const res = await call('/api/evals/session', { method: 'POST', headers: json, body: JSON.stringify({ run: Number(runId) }) });
      if (!res.ok) throw new Error(`no session: ${await errorText(res)}`);
      return String(((await res.json()) as { id: unknown }).id);
    },
    async deleteSession(id) {
      // Never throws (a `finally` and the reaper call it), but never silent: a
      // conversation left behind keeps the run's turns searchable by members.
      try {
        const res = await call(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) console.warn(`[evals] deleting eval conversation ${id}: backend ${res.status}`);
      } catch (err) {
        console.warn(`[evals] deleting eval conversation ${id}: ${err instanceof Error ? err.name : 'error'}`);
      }
    },
    async gate(itemId) {
      const res = await call('/api/evals/gate', { method: 'POST', headers: json, body: JSON.stringify({ item: Number(itemId) }) });
      if (!res.ok) throw new Error(await errorText(res));
      return (await res.json()) as Awaited<ReturnType<EvalStore['gate']>>;
    },
    async expansionCost(messageId) {
      const res = await call(`/api/messages/${encodeURIComponent(messageId)}?depth=0`, { method: 'GET' }).catch(() => null);
      if (!res?.ok) return 0;
      const meta = ((await res.json()) as { generationMeta?: { expansionCostUsd?: unknown } }).generationMeta;
      return typeof meta?.expansionCostUsd === 'number' ? meta.expansionCostUsd : 0;
    },
  };
}
