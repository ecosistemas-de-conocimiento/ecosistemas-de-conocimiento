/**
 * Feature switches over the backend's `/api/funciones` and `/api/plataforma`
 * (`apps/backend/src/endpoints/funciones.ts`, which decides who may do what).
 */

import { backendFetch } from '$lib/server/auth';
import { isFeatureKey, PLATFORM_ADMIN_ONLY_FEATURES, resolveFeatures, type FeatureKey, type Features } from '$lib/features';

/**
 * One ecosistema's switches. ⚠ Any failure is the DEFAULTS (today's
 * behaviour): the backend enforces every switch again, so a blip here only
 * risks showing a control the backend then refuses — never hiding one.
 */
export async function fetchFeatures(
  token: string | undefined,
  organizationId: string | number | null | undefined,
): Promise<Features> {
  if (organizationId == null || organizationId === '') return resolveFeatures(null);
  try {
    const res = await backendFetch(
      token,
      `/api/funciones?organization=${encodeURIComponent(String(organizationId))}`,
      { method: 'GET' },
    );
    if (!res.ok) return resolveFeatures(null);
    const body = (await res.json().catch(() => ({}))) as { features?: unknown };
    return resolveFeatures(body.features);
  } catch {
    return resolveFeatures(null);
  }
}

export interface EditableEcosystem {
  id: string;
  name: string;
  slug: string;
  features: Features;
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
    }
  | { state: 'forbidden' }
  | { state: 'unavailable' };

export async function fetchEditables(token: string | undefined): Promise<EditablesResult> {
  try {
    const res = await backendFetch(token, '/api/funciones/editables', { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { state: 'forbidden' };
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json()) as { ecosistemas?: unknown; plataforma?: unknown; lockedFeatures?: unknown };
    const list = Array.isArray(body.ecosistemas) ? (body.ecosistemas as Array<Record<string, unknown>>) : [];
    return {
      state: 'ready',
      ecosistemas: list.map((e) => ({
        id: String(e.id ?? ''),
        name: typeof e.name === 'string' ? e.name : '',
        slug: typeof e.slug === 'string' ? e.slug : '',
        features: resolveFeatures(e.features),
      })),
      plataforma: (body.plataforma as PlatformSwitches | null) ?? null,
      lockedFeatures: Array.isArray(body.lockedFeatures)
        ? body.lockedFeatures.filter(isFeatureKey)
        : [...PLATFORM_ADMIN_ONLY_FEATURES],
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
