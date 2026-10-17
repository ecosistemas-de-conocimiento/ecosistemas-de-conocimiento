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
   * invariant (spec §0).
   *
   * MACHINERY, therefore ENGLISH. This is the engine instructing the model, not
   * copy a user ever sees. Products are multilingual; Spanish inference is for
   * END USERS. An English directive also avoids presuming the conversation is
   * Spanish. Contrast `blockHeaders` / `teamInstructionsHeader` below, which are
   * CONTENT and stay localized.
   *
   * The default carries THREE obligations. All three must survive any edit:
   *   (a) do not deny the context that IS present (the original failure:
   *       "no tengo acceso a tu proyecto" with the project sitting right below);
   *   (b) do not invent a fact that is ABSENT — say what is missing instead.
   *       Numbers and counts especially: a summary may list names without a
   *       total, and counting the visible names is NOT the total;
   *   (c) reply in the USER's language. Rule (c) exists precisely because
   *       (a)+(b) are written in English: without an explicit rule, an English
   *       instruction block can pull the model into answering in English. That
   *       would be a user-facing regression, so the response language is stated,
   *       never inferred from the prompt's own language.
   *
   * Dropping (b) reintroduces confidently-wrong numbers. Dropping (a)
   * reintroduces the false "I have no access". Dropping (c) risks English
   * answers to Spanish users. None of the three is optional.
   *
   * ⚠ Unit tests can only pin this string. Whether a model OBEYS it has to be
   * measured against a real model.
   */
  userContextPreamble: string;

  /**
   * Section headers for each context block in the user turn.
   *
   * CONTENT, therefore LOCALIZED — deliberately NOT translated to English with
   * the preamble. These labels sit inside the context the model reads, right
   * next to the product's own prose, so the model can echo them into its reply
   * ("según el contexto recuperado…"). An English label echoed into a Spanish
   * answer is a user-visible defect, so they follow the CONTENT language, not
   * the machinery language.
   *
   * The defaults below are Spanish because that is the first locale. A product
   * in another locale MUST override them; the engine will not translate.
   */
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

  /**
   * Header injected before team/thread custom instructions in the system prompt.
   * CONTENT, therefore LOCALIZED — same reasoning as `blockHeaders`: it labels
   * product-authored prose and is echo-prone. Override it per locale.
   */
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
    'Responde en el mismo idioma que el usuario, de forma clara y concisa. ' +
    'Usa Markdown (encabezados, ' +
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
    '[CONTEXT for your reply — it is RIGHT BELOW and it is your primary ' +
    'source.\n' +
    '\n' +
    'Rules:\n' +
    '1. What is below, you have. Never say you lack information that appears ' +
    'below, and never ask the user for something that already appears below.\n' +
    '2. What is NOT below, you do not have. Say so plainly and name the ' +
    'missing detail. Never invent, assume, estimate or extrapolate it, and do ' +
    'not dress a guess as "about", "around" or "at least" — numbers and counts ' +
    'above all.\n' +
    '3. Give a number only if that number is written below, or you can derive ' +
    'it by arithmetic over numbers that are written below. Otherwise rule 2 ' +
    'applies — including when you could work it out by counting a list.\n' +
    '4. A list below may be partial. If you report how many items it shows, ' +
    'say plainly that it is the number listed here, not the total.\n' +
    '5. Saying that a detail is not here is a correct and complete answer. A ' +
    'plausible number is not.\n' +
    '6. Write your reply in the same language as the user message.]' +
    '\n\n{context}\n\n========\n' +
    '\nUser message (reply in this same language):\n{message}',
  blockHeaders: {
    summary: 'Contexto del proyecto/organización:',
    retrieved: 'Contexto recuperado de la base de conocimiento:',
    inlineRefs: 'Entidades citadas por el usuario (@):',
    graph: 'Contexto del grafo de conocimiento:',
  },
  teamInstructionsHeader: 'Instrucciones del equipo para este asistente:',
  placeholderTitles: ['', 'chat', 'nuevo chat'],
};
