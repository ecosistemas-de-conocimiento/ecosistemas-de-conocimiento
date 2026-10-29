/**
 * Presentation helpers for `/estudiante`. Display only: every rule about who
 * sees what lives in the backend (`endpoints/estudiante.ts`).
 */

import { graphEntityHref } from '$lib/graph';

/**
 * The `shareWithPeers` switch. It names everything a classmate's page shows
 * (`/estudiante/companero/<id>`): the name, the topics and PUBLISHED works.
 */
export const PEERS_CONSENT = 'Mostrar mi nombre, mis temas y mis trabajos publicados a otros estudiantes';

/** `/estudiante`'s load; `invalidate` it to re-read the overview. */
export const ESTUDIANTE_DEPENDENCY = 'app:estudiante';

/**
 * Re-read every 10 s for 5 min while "Mis temas" waits on a trabajo: topics
 * land only after the backend processes it, and nothing else reloads the page.
 */
export const TEMAS_POLL_MS = 10_000;
export const TEMAS_POLL_LIMIT = 30;

/** True while a trabajo exists but none of its topics have landed yet. */
export function temasPending(o: { temas: unknown[]; documentos: unknown[] } | null): boolean {
  return o != null && o.documentos.length > 0 && o.temas.length === 0;
}

/** A topic chip's link: the topic focused in the ecosistema's graph. */
export function topicHref(organization: string, topicId: number): string {
  return graphEntityHref(String(topicId), null, { eco: organization });
}

/** A classmate's page. `id` is the backend's opaque slug. */
export function companeroHref(id: string): string {
  return `/estudiante/companero/${encodeURIComponent(id)}`;
}

/** The page's tabs, in order. The id is also the `tab-<id>` test id. */
export const ESTUDIANTE_TABS = [
  { id: 'autores', label: 'Autores' },
  { id: 'companeros', label: 'Compañeros' },
  { id: 'privacidad', label: 'Privacidad' },
  { id: 'sugerir', label: 'Sugerir' },
] as const;

export type EstudianteTab = (typeof ESTUDIANTE_TABS)[number]['id'];

/**
 * The tab a key press moves to (WAI-ARIA tabs pattern: arrows wrap, Home and
 * End jump). `null` for any other key, so the caller leaves it alone.
 */
export function tabAfterKey(current: EstudianteTab, key: string): EstudianteTab | null {
  const ids: EstudianteTab[] = ESTUDIANTE_TABS.map((t) => t.id);
  const i = ids.indexOf(current);
  const at = (n: number) => ids[(n + ids.length) % ids.length] ?? null;
  if (key === 'ArrowRight') return at(i + 1);
  if (key === 'ArrowLeft') return at(i - 1);
  if (key === 'Home') return at(0);
  if (key === 'End') return at(-1);
  return null;
}

/** First and last initial: "María Fernanda Ortega" → "MO". Decorative only. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** "1 documento" / "6 documentos". */
export function docsLabel(n: number): string {
  return `${n} ${n === 1 ? 'documento' : 'documentos'}`;
}

/** "1 trabajo" / "3 trabajos". */
export function trabajosLabel(n: number): string {
  return `${n} ${n === 1 ? 'trabajo' : 'trabajos'}`;
}
