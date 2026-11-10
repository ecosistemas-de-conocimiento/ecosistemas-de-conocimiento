/**
 * Feature switches over the backend's `/api/funciones` and `/api/plataforma`
 * (`apps/backend/src/endpoints/funciones.ts`, which decides who may do what).
 */

import { backendFetch } from '$lib/server/auth';
import { resolveAnswerStyles, type AnswerStyles } from '$lib/answerStyle';
import { isFeatureKey, PLATFORM_ADMIN_ONLY_FEATURES, resolveFeatures, type FeatureKey, type Features } from '$lib/features';

export interface EcosystemSettings {
  features: Features;
  /** The answer style (owner ruling 2026-10-28). Any failure: no style. */
  answerStyles: AnswerStyles;
}

/**
 * One ecosistema's switches and answer style, in one read. ⚠ Any failure is
 * the DEFAULTS (today's behaviour): the backend enforces every switch again,
 * so a blip here only risks showing a control the backend then refuses —
 * never hiding one. A failed read sends no style: the base prompt.
 */
export async function fetchEcosystemSettings(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<EcosystemSettings> {
  const none = (): EcosystemSettings => ({ features: resolveFeatures(null), answerStyles: resolveAnswerStyles(null) });
  if (organizationId == null || organizationId === '') return none();
  try {
    const res = await backendFetch(
      token,
      `/api/funciones?organization=${encodeURIComponent(String(organizationId))}`,
      { method: 'GET' },
    );
    if (!res.ok) return none();
    const body = (await res.json().catch(() => ({}))) as { features?: unknown; answerStyles?: unknown };
    return { features: resolveFeatures(body.features), answerStyles: resolveAnswerStyles(body.answerStyles) };
  } catch {
    return none();
  }
}

/** One ecosistema's switches ({@link fetchEcosystemSettings}). */
export async function fetchFeatures(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<Features> {
  return (await fetchEcosystemSettings(token, organizationId)).features;
}

export interface EditableEcosystem {
  id: string;
  name: string;
  slug: string;
  /** Switched off (`organizations.isActive`). Missing = active: only the default pick reads it. */
  isActive: boolean;
  features: Features;
  answerStyles: AnswerStyles;
}

export interface PlatformSwitches {
  /** `null` = the env value. */
  detectorFallback: 'hosted' | 'none' | null;
  detectorFallbackEnv: 'hosted' | 'none' | 'invalid';
  detectorFallbackEffective: 'hosted' | 'none' | 'invalid';
}

export type EditablesResult =
  | {
      state: 'ready';
      ecosistemas: EditableEcosystem[];
      plataforma: PlatformSwitches | null;
      /** Switches this caller sees read-only. Missing from the body = the admin-only ones. */
      lockedFeatures: FeatureKey[];
      /** Only a platform admin edits the answer style. Missing = false. */
      answerStylesEditable: boolean;
    }
  | { state: 'forbidden' }
  | { state: 'unavailable' };

export async function fetchEditables(token: string | undefined): Promise<EditablesResult> {
  try {
    const res = await backendFetch(token, '/api/funciones/editables', { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { state: 'forbidden' };
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json()) as {
      ecosistemas?: unknown;
      plataforma?: unknown;
      lockedFeatures?: unknown;
      answerStylesEditable?: unknown;
    };
    const list = Array.isArray(body.ecosistemas) ? (body.ecosistemas as Array<Record<string, unknown>>) : [];
    return {
      state: 'ready',
      ecosistemas: list.map((e) => ({
        id: String(e.id ?? ''),
        name: typeof e.name === 'string' ? e.name : '',
        slug: typeof e.slug === 'string' ? e.slug : '',
        isActive: e.isActive !== false,
        features: resolveFeatures(e.features),
        answerStyles: resolveAnswerStyles(e.answerStyles),
      })),
      plataforma: (body.plataforma as PlatformSwitches | null) ?? null,
      lockedFeatures: Array.isArray(body.lockedFeatures)
        ? body.lockedFeatures.filter(isFeatureKey)
        : [...PLATFORM_ADMIN_ONLY_FEATURES],
      answerStylesEditable: body.answerStylesEditable === true,
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export type SaveResult = { ok: true } | { ok: false; status: number; message: string };

async function send(token: string | undefined, path: string, body: unknown): Promise<SaveResult> {
  try {
    const res = await backendFetch(token, path, { method: 'PATCH', body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: unknown }> };
    const message = parsed.errors?.[0]?.message;
    return { ok: false, status: res.status, message: typeof message === 'string' ? message : 'No se pudo guardar.' };
  } catch {
    return { ok: false, status: 502, message: 'No se pudo guardar.' };
  }
}

export const saveFeatures = (token: string | undefined, organization: string, features: Partial<Features>) =>
  send(token, '/api/funciones', { organization, features });

export const savePlatform = (token: string | undefined, detectorFallback: 'hosted' | 'none' | null) =>
  send(token, '/api/plataforma', { detectorFallback });

export const saveAnswerStyles = (token: string | undefined, organization: string, answerStyles: AnswerStyles) =>
  send(token, '/api/funciones/estilo', { organization, answerStyles });

/** `GET /api/organizations/:id/anonimizacion`: the ecosistema's re-check backlog (I-01, I-02). */
export interface AnonRegateStatus {
  /** Documents whose check is stale against the current switches. */
  pendingRegate: number;
  /** A re-check of this ecosistema is running now. */
  regating: boolean;
  /** Documents a re-check put back to draft that still are. */
  unpublishedByRegate: number;
}

const anonPath = (organizationId: string) => `/api/organizations/${encodeURIComponent(organizationId)}/anonimizacion`;
const tally = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** Null on any failure or refusal: the page then just says nothing about it. */
export async function fetchAnonRegateStatus(
  token: string | undefined,
  organizationId: string,
): Promise<AnonRegateStatus | null> {
  if (!organizationId) return null;
  try {
    const res = await backendFetch(token, anonPath(organizationId), { method: 'GET' });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return null;
    return {
      pendingRegate: tally(body.pendingRegate),
      regating: body.regating === true,
      unpublishedByRegate: tally(body.unpublishedByRegate),
    };
  } catch {
    return null;
  }
}

/** `POST /api/organizations/:id/anonimizacion/reintentar` (202 `{ started, pendingRegate }`). */
export async function retryEcosystemRegate(token: string | undefined, organizationId: string): Promise<SaveResult> {
  try {
    const res = await backendFetch(token, `${anonPath(organizationId)}/reintentar`, { method: 'POST' });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: unknown }> };
    const message = parsed.errors?.[0]?.message;
    return { ok: false, status: res.status, message: typeof message === 'string' ? message : 'No se pudo reintentar.' };
  } catch {
    return { ok: false, status: 502, message: 'No se pudo reintentar.' };
  }
}
