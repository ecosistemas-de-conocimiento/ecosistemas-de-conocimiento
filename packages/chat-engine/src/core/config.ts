/**
 * Engine configuration — every per-product string/knob is injected here rather
 * than hardcoded. Nothing in `core/` reads a literal prompt or a product kind
 * directly; it all flows through `EngineConfig` + `KindRegistry`.
 */

/**
 * The "kind registry": the open set of ref kinds a product supports, each with
 * a display label, an inline glyph (emoji), and the `@kind`-prefix aliases the
 * mention parser recognises. The label/emoji/alias maps are data, not code.
 */
export interface KindDescriptor {
  /** Canonical kind id (matches `ContextRef.kind`). */
  kind: string;
  /** Human label, already localized by the product. */
  label: string;
  /** Small inline glyph for pills/chips. */
  emoji: string;
  /**
   * `@`-prefix aliases that select this kind (lowercased). e.g.
   * `['story','historia']`. The bare kind id is auto-registered as an alias.
   */
  aliases?: string[];
}

export interface KindRegistry {
  descriptors: KindDescriptor[];
}

/** Lookup helpers over a KindRegistry — pure, no I/O. */
export function kindLabel(registry: KindRegistry, kind: string): string {
  return registry.descriptors.find((d) => d.kind === kind)?.label ?? kind;
}

export function kindEmoji(registry: KindRegistry, kind: string): string {
  return registry.descriptors.find((d) => d.kind === kind)?.emoji ?? '';
}

/** Build the `alias -> kind` map (bare kind id always included). */
export function buildAliasMap(registry: KindRegistry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of registry.descriptors) {
    out[d.kind.toLowerCase()] = d.kind;
    for (const a of d.aliases ?? []) out[a.toLowerCase()] = d.kind;
  }
  return out;
}

/**
 * Injected behavioral / prompt configuration. All defaults are Spanish strings
 * (the product's first locale) but they are DATA, not hardcoded — a future
 * English surface overrides them.
 */
export interface EngineConfig {
  /** Logical surface name for ai-service attribution (e.g. 'chat'). */
  surface: string;

  /** System prompt — BEHAVIORAL ONLY. Factual context lives in the user turn. */
  systemPrompt: string;

  /** Main chat generation tuning. */
  chatEffort: 'quick' | 'standard' | 'deep' | 'maximum';
  chatMaxTokens: number;

  /** Query-condensation prompt (anaphora → standalone search query). */
  condenseSystemPrompt: string;

  /** Thread-title prompt. */
  titlePrompt: string;

  /**
   * The labelled context preamble wrapping all factual context in the user
   * turn. `{context}` and `{message}` are substituted. This is the load-bearing
   * invariant (spec §0) — the default wording is proven; keep it verbatim.
   */
  userContextPreamble: string;

  /** Section headers for each context block in the user turn. */
  blockHeaders: {
    summary: string;
    retrieved: string;
    inlineRefs: string;
    /**
     * Header for the OPTIONAL structured/graph context block (`graphContext`
     * on `buildChatTurn`). Optional in the type so a consumer's existing
     * config object literal still typechecks; `buildChatTurn` falls back to
     * the default below when it is absent. The block only renders when a
     * `graphContext` string is actually supplied.
     */
    graph?: string;
  };

  /** Header injected before team/thread custom instructions in the system prompt. */
  teamInstructionsHeader: string;

  /** Placeholder titles the engine is willing to overwrite (lowercased). */
  placeholderTitles: string[];
}

/** The proven, load-bearing default strings (spec §0). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  surface: 'chat',
  systemPrompt:
    'Eres un asistente que colabora con un miembro del equipo. Tienes acceso a ' +
    'un resumen de contexto y a contenido recuperado de una base de ' +
    'conocimiento.\n\n' +
    'Puedes razonar, proponer ideas y aportar conocimiento general. Pero cuando ' +
    'afirmes hechos sobre el contexto actual, básate en el resumen y el ' +
    'contenido recuperado; no inventes detalles. Distingue con claridad entre lo ' +
    'que consta en el contexto y tus propias sugerencias. Si el contexto no ' +
    'alcanza para responder algo, dilo explícitamente.\n\n' +
    'Responde en español, de forma clara y concisa. Usa Markdown (encabezados, ' +
    'listas, código) cuando ayude a la lectura.',
  chatEffort: 'standard',
  chatMaxTokens: 1800,
  condenseSystemPrompt:
    'Reescribe la última pregunta del usuario como una consulta de búsqueda ' +
    'autónoma que incorpore el contexto necesario de la conversación (resuelve ' +
    'pronombres y referencias). Responde SOLO con la consulta reescrita, en el ' +
    'mismo idioma, sin explicaciones ni comillas.',
  titlePrompt:
    'Genera un título muy breve (3 a 6 palabras) que resuma el tema de esta ' +
    'conversación. Responde SOLO con el título, sin comillas, sin punto final, ' +
    'en el mismo idioma que el usuario.',
  userContextPreamble:
    '[CONTEXTO disponible para responder — es tu FUENTE PRINCIPAL y está AQUÍ ' +
    'MISMO; NO digas que no tienes información ni pidas datos que ya aparecen ' +
    'abajo]\n\n{context}\n\n========\n\nMensaje del usuario:\n{message}',
  blockHeaders: {
    summary: 'Contexto del proyecto/organización:',
    retrieved: 'Contexto recuperado de la base de conocimiento:',
    inlineRefs: 'Entidades citadas por el usuario (@):',
    graph: 'Contexto del grafo de conocimiento:',
  },
  teamInstructionsHeader: 'Instrucciones del equipo para este asistente:',
  placeholderTitles: ['', 'chat', 'nuevo chat'],
};
