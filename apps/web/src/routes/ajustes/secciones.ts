/**
 * `/ajustes` — which switch sits in which tab, and which switch only means
 * something while another is on.
 *
 * 🔴 EVERY KEY IN EXACTLY ONE PLACE (`secciones.test.ts`). The switches form is
 * one `<form>` across the switch tabs: the action writes every key it is not
 * told is locked, and an absent box reads as "off". A key missing here would be
 * switched off by the next save.
 *
 * ⚠ A CHILD IS HIDDEN, NOT REMOVED, while its parent is off. It stays in the
 * form, so its stored value round-trips untouched. The parent pairs are the
 * backend's own rules: the combined graph needs `graph && combinedGraph`
 * (`endpoints/graph.ts`), the 3D view is a mode of the graph, and the student
 * report (`studentTestimonios`) lives under `studentView` (`endpoints/estudiante.ts`).
 */

import type { FeatureKey, Features } from '$lib/features';

export type SeccionId = 'conversacion' | 'grafo' | 'publicacion' | 'estudiantes' | 'estilo';

export interface SwitchGroup {
  key: FeatureKey;
  children: readonly FeatureKey[];
}

export interface Seccion {
  id: SeccionId;
  label: string;
  /** Empty for the answer-style tab, which is its own form. */
  switches: readonly SwitchGroup[];
}

const solo = (key: FeatureKey): SwitchGroup => ({ key, children: [] });

export const SECCIONES: readonly Seccion[] = [
  {
    id: 'conversacion',
    label: 'Conversación',
    switches: [solo('audioUpload'), solo('liveMic'), solo('interviewerMode'), solo('chatOrientation')],
  },
  { id: 'grafo', label: 'Grafo', switches: [{ key: 'graph', children: ['graph3d', 'combinedGraph'] }] },
  {
    id: 'publicacion',
    label: 'Publicación',
    switches: [solo('autoPublishMembers'), solo('testimonioTitles'), solo('keepPublicFigures')],
  },
  { id: 'estudiantes', label: 'Estudiantes', switches: [{ key: 'studentView', children: ['studentTestimonios'] }] },
  { id: 'estilo', label: 'Estilo de respuesta', switches: [] },
];

export const keysOf = (s: Seccion): FeatureKey[] => s.switches.flatMap((g) => [g.key, ...g.children]);

/** Whether any editable switch in this tab differs from what is stored. */
export function seccionDirty(s: Seccion, now: Features, saved: Features, locked: readonly FeatureKey[]): boolean {
  return keysOf(s).some((k) => !locked.includes(k) && now[k] !== saved[k]);
}

/** Every switch in this tab is read-only for this caller. */
export const seccionLocked = (s: Seccion, locked: readonly FeatureKey[]): boolean =>
  s.switches.length > 0 && keysOf(s).every((k) => locked.includes(k));
