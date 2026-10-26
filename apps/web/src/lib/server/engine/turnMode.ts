/**
 * Is this turn a person telling their own story (a testimonio), or a request
 * for the documents? Pure and model-free: no extra call, no extra latency.
 *
 * Owner ruling 2026-10-26: a participant giving a testimonio meets an
 * INTERVIEWER (`interviewSystemPrompt` in `./prompt`), not answers from the
 * documents. A direct question still gets the documents and `[N]` sources.
 *
 * The signal, in order:
 *   1. A direct request (a `?`/`¿`, or a message that opens with a question
 *      word or an ask such as "dime", "resume", "quiero saber") is ALWAYS an
 *      answer turn. This is what keeps "ask the documents" working mid-story.
 *   2. The conversation holds a testimonio or conversación the person
 *      uploaded (their own audio or transcript) → interview.
 *   3. This message, or an earlier user message since the last request, is a
 *      first-person narrative → interview. So "En la sierra", answering the
 *      interviewer's "¿dónde?", keeps the interview going.
 *
 * ⚠ Role is not part of the signal: the web app has no cheap per-ecosistema
 * role read on this path (`BackendUser` carries none), and an investigador
 * telling their own story is giving a testimonio too. Inferred acceptable.
 *
 * ⚠ The word lists are a heuristic, unit-tested on hand-written examples
 * only; not measured on real dev conversations yet.
 */

export type ChatTurnMode = 'answer' | 'interview';

/** Content kinds that are the person's own story (`contentKind` on a session doc). */
const OWN_STORY_KINDS = new Set(['testimonio', 'conversacion', 'conversación']);

/** A message opening with one of these asks for something. Accented forms only: "como madre…" is a story. */
const REQUEST_OPENERS = [
  'qué', 'que dice', 'que dicen', 'que hay', 'cómo', 'cuál', 'cuáles', 'cuándo', 'dónde', 'quién',
  'quiénes', 'por qué', 'cuánto', 'cuánta', 'cuántos', 'cuántas',
  'dime', 'dame', 'explica', 'explícame', 'explicame', 'resume', 'resúmeme', 'resumeme', 'busca',
  'búscame', 'muestra', 'muéstrame', 'enséñame', 'compara', 'lista', 'enumera', 'haz', 'escribe',
  'redacta', 'ayúdame a', 'ayudame a', 'quiero saber', 'quisiera saber', 'quiero información',
  'necesito saber', 'necesito información', 'busco información', 'háblame', 'hablame',
];

/** First-person words (pronouns, possessives, common first-person verb forms). */
const FIRST_PERSON = new Set([
  'yo', 'me', 'mi', 'mis', 'conmigo', 'mío', 'mía', 'míos', 'mías',
  'nosotros', 'nosotras', 'nos', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'soy', 'estoy', 'tengo', 'vivo', 'fui', 'estuve', 'tuve', 'viví', 'vivía', 'llegué', 'empecé',
  'trabajé', 'trabajaba', 'pude', 'sentí', 'conocí', 'decidí', 'aprendí', 'perdí', 'nací', 'crecí',
  'estaba', 'tenía', 'conocía', 'sabía', 'quería', 'iba', 'hice', 'dije', 'vi', 'salí', 'entré',
  'somos', 'estamos', 'tenemos', 'vivimos', 'fuimos', 'tuvimos', 'perdimos', 'llegamos', 'empezamos',
]);

function words(message: string): string[] {
  return message.toLowerCase().match(/\p{L}+/gu) ?? [];
}

/** A question or an explicit ask for information. */
export function isDirectRequest(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (m === '') return false;
  if (/[?¿]/.test(m)) return true;
  const opening = m.replace(/^[^\p{L}]+/u, '');
  return REQUEST_OPENERS.some((o) => opening === o || new RegExp(`^${o}(?![\\p{L}])`, 'u').test(opening));
}

/** First-person narrative: two first-person words, or one in a message of ten words or more. */
export function isFirstPersonNarrative(message: string): boolean {
  const w = words(message);
  const hits = w.filter((x) => FIRST_PERSON.has(x)).length;
  return hits >= 2 || (hits >= 1 && w.length >= 10);
}

export interface TurnModeInput {
  userMessage: string;
  /** Everything before the latest user message. */
  history?: ReadonlyArray<{ role: string; content: string }>;
  /** This conversation's documents (`fetchSessionDocs`); only `contentKind` is read. */
  sessionDocs?: ReadonlyArray<{ contentKind?: string | null }>;
}

export function chatTurnMode({ userMessage, history = [], sessionDocs = [] }: TurnModeInput): ChatTurnMode {
  if (userMessage.trim() === '' || isDirectRequest(userMessage)) return 'answer';
  if (sessionDocs.some((d) => OWN_STORY_KINDS.has((d.contentKind ?? '').toLowerCase()))) return 'interview';
  if (isFirstPersonNarrative(userMessage)) return 'interview';
  // Earlier user turns, newest first, back to the last request.
  const earlier = history.filter((m) => m.role === 'user').map((m) => m.content).reverse();
  for (const m of earlier) {
    if (isDirectRequest(m)) return 'answer';
    if (isFirstPersonNarrative(m)) return 'interview';
  }
  return 'answer';
}
