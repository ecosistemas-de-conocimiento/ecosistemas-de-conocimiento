/**
 * Per-ecosistema switches — mirror of the backend's `lib/features.ts`, which
 * owns them and enforces each one server-side. Here: the defaults (today's
 * behaviour), so a failed read never hides anything, and the admin labels.
 */

export const FEATURE_DEFAULTS = {
  audioUpload: true,
  liveMic: true,
  interviewerMode: true,
  graph: true,
  graph3d: true,
  combinedGraph: true,
  chatOrientation: true,
  testimonioTitles: true,
  autoPublishMembers: true,
  studentView: false,
  keepPublicFigures: false,
  keepDocumentAuthor: false,
  keepCitedAuthors: false,
  studentTestimonios: false,
} as const satisfies Record<string, boolean>;

export type FeatureKey = keyof typeof FEATURE_DEFAULTS;
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_KEYS = Object.keys(FEATURE_DEFAULTS) as FeatureKey[];

/**
 * Switches only a platform admin may change (owner ruling Q16 A). The backend
 * says which are locked for the caller (`lockedFeatures`); this is the
 * fail-closed fallback when it does not.
 */
export const PLATFORM_ADMIN_ONLY_FEATURES: readonly FeatureKey[] = ['keepPublicFigures', 'studentTestimonios'];

export const isFeatureKey = (k: unknown): k is FeatureKey =>
  typeof k === 'string' && Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, k);

/** Admin-page labels. Exhaustive by type. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  audioUpload: 'Subir audio',
  liveMic: 'Micrófono en vivo',
  interviewerMode: 'Modo entrevista',
  graph: 'Grafo',
  graph3d: 'Vista 3D del grafo',
  combinedGraph: 'Incluir en el grafo combinado',
  chatOrientation: 'Conversaciones anteriores como contexto',
  testimonioTitles: 'Títulos automáticos para testimonios',
  autoPublishMembers: 'Publicar automáticamente lo de participantes',
  studentView: 'Vista de estudiante',
  keepPublicFigures: 'Conservar nombres de figuras públicas en documentos',
  // A document may override these two (`/documentos/[id]/anonimizacion`).
  keepDocumentAuthor: 'Conservar al autor del documento',
  keepCitedAuthors: 'Conservar autores citados',
  studentTestimonios: 'Testimonios de estudiantes en el reporte (anonimizados)',
};

/** Whatever came over the wire, made whole. Junk reads as the defaults. */
export function resolveFeatures(raw: unknown): Features {
  const out: Features = { ...FEATURE_DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of FEATURE_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
