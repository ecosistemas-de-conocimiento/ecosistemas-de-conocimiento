/**
 * The student view over the backend's `/api/estudiante/*` and
 * `/api/sugerencias` (`apps/backend/src/endpoints/estudiante.ts`, which owns
 * every rule: `studentView` on, role, consent). This file decides nothing.
 */

import { backendFetch } from '$lib/server/auth';

export interface StudentAccess {
  student: boolean;
  teacher: boolean;
  admin: boolean;
}

export const NO_ACCESS: StudentAccess = { student: false, teacher: false, admin: false };

export interface DocRef {
  id: number;
  name: string;
}

export interface Author {
  name: string;
  docs: number;
  page: DocRef | null;
}

export interface StudentOverview {
  perfil: { shareWithPeers: boolean; shareActivity: boolean; shareTestimonios?: boolean };
  temas: string[];
  documentos: Array<{ id: number; name: string; status: string }>;
  companeros: Array<{ name: string; topics: string[] }>;
  autores: Author[];
  autoresParaLeer: Author[];
  temasDelEcosistema: string[];
  /** `studentTestimonios` on: the consent wording must say so. */
  testimoniosEnReporte?: boolean;
}

export interface Suggestion {
  id: string | number;
  kind: string;
  text: string;
  createdAt: string;
  author: string;
}

export interface ActivityReport {
  student: { id: number; name: string };
  summary: { documents: number; published: number; topics: number; conversations: number };
  /** Documentos only; a draft's `name` is null. */
  uploads: Array<{ id: number; name: string | null; createdAt: string; status: string; kind: string }>;
  topics: string[];
  gaps: string[];
  readings: DocRef[];
  /** Only when `studentTestimonios` is on. Anonymised output or a status line. */
  testimonios?: ReportTestimonio[];
}

export type ReportTestimonio =
  | { id: number; createdAt: string; state: 'visible'; title: string; text: string }
  | { id: number; createdAt: string; state: 'held' | 'rejected' | 'pending' };

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function call<T>(token: string | undefined, path: string, init: RequestInit = { method: 'GET' }): Promise<Result<T>> {
  try {
    const res = await backendFetch(token, path, init);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = (body?.errors as Array<{ message?: unknown }> | undefined)?.[0]?.message;
      return { ok: false, status: res.status, message: typeof message === 'string' ? message : 'No disponible.' };
    }
    return { ok: true, value: (body ?? {}) as T };
  } catch {
    return { ok: false, status: 502, message: 'No disponible.' };
  }
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Who may see what. Any failure (incl. `studentView` off → 404) is "nothing". */
export async function fetchStudentAccess(token: string | undefined, org: string | null | undefined): Promise<StudentAccess> {
  if (!org) return NO_ACCESS;
  const r = await call<Partial<StudentAccess>>(token, `/api/estudiante/acceso?${qs({ organization: org })}`);
  if (!r.ok) return NO_ACCESS;
  return { student: r.value.student === true, teacher: r.value.teacher === true, admin: r.value.admin === true };
}

export const fetchOverview = (token: string | undefined, org: string) =>
  call<StudentOverview>(token, `/api/estudiante?${qs({ organization: org })}`);

export const savePerfil = (
  token: string | undefined,
  org: string,
  patch: Partial<StudentOverview['perfil']> & { consentVersion?: number },
) =>
  call<{ perfil: StudentOverview['perfil'] }>(token, '/api/estudiante/perfil', {
    method: 'PATCH',
    body: JSON.stringify({ organization: org, ...patch }),
  });

export const postSuggestion = (token: string | undefined, org: string, kind: string, text: string) =>
  call<{ ok: true }>(token, '/api/sugerencias', { method: 'POST', body: JSON.stringify({ organization: org, kind, text }) });

export const fetchSuggestions = (token: string | undefined, org: string) =>
  call<{ sugerencias: Suggestion[] }>(token, `/api/sugerencias?${qs({ organization: org })}`);

export const fetchConsentingStudents = (token: string | undefined, org: string) =>
  call<{ estudiantes: Array<{ id: number; name: string }> }>(token, `/api/estudiante/reportes?${qs({ organization: org })}`);

export const fetchReport = (token: string | undefined, org: string, user: string) =>
  call<{ reporte: ActivityReport }>(token, `/api/estudiante/reporte?${qs({ organization: org, user })}`);

export type Alcance = 'mios' | 'companeros';

export function parseAlcance(raw: unknown): Alcance | null {
  return raw === 'mios' || raw === 'companeros' ? raw : null;
}

/**
 * The document ids a scoped chat turn may cite. `null` = could not read (or
 * not a student, or the switch is off): the caller must then retrieve NOTHING,
 * never fall back to the whole ecosistema.
 */
export async function fetchScopeDocumentIds(
  token: string | undefined,
  org: string,
  alcance: Alcance,
): Promise<Set<string> | null> {
  const r = await call<{ documentIds?: unknown }>(token, `/api/estudiante/alcance?${qs({ organization: org, alcance })}`);
  if (!r.ok || !Array.isArray(r.value.documentIds)) return null;
  return new Set(r.value.documentIds.map(String));
}
