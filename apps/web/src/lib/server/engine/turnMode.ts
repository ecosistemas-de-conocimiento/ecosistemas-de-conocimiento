/**
 * Is this turn a person telling their own story (a testimonio), or a request
 * for the documents? Pure and model-free: no extra call, no extra latency.
 *
 * Owner ruling 2026-10-26: a participant giving a testimonio meets an
 * INTERVIEWER (`interviewSystemPrompt` in `./prompt`), not answers from the
 * documents. A direct question still gets the documents and `[N]` sources.
 *
 * The signal, in order:
 *   1. A direct request (a `?`/`¿`, or a message or clause that opens with a
 *      question word or an ask such as "dime", "analiza", "me puedes",
 *      "necesito un") is ALWAYS an answer turn. This is what keeps "ask the
 *      documents" working mid-story, and what keeps staff analysis on answers.
 *   2. The conversation holds a testimonio or conversación the CALLER uploaded
 *      (their own audio or transcript) → interview. Someone else's attached
 *      testimonio is material to analyse, not a story being told (audit
 *      2026-10-26). The backend hides `uploadedBy` on a colleague's gated row,
 *      so a missing uploader is "not mine": fail closed to answer.
 *   3. This message is a first-person narrative → interview.
 *   4. The interview continues on a short reply ("En la sierra") only while
 *      the assistant's last turn asked a question and an earlier user message,
 *      back to the last request, was a story. An answer from the documents
 *      ends it.
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
  // Analysis and production asks (audit 2026-10-26: staff turns read as stories).
  'analiza', 'analízame', 'analizar', 'identifica', 'identifícame', 'genera', 'crea', 'elabora',
  'extrae', 'clasifica', 'describe', 'descríbeme', 'evalúa', 'revisa', 'sintetiza', 'organiza',
  'agrupa', 'sugiere', 'sugiéreme', 'propón', 'propon', 'proponme', 'señala', 'menciona', 'destaca',
  'encuentra', 'localiza', 'traduce', 'calcula', 'prepara', 'compárame', 'contrasta', 'detecta',
  'resumir', 'resúmelo', 'explicar', 'enlista', 'ordena', 'cuenta cuántos', 'cuenta cuántas',
  'necesito un', 'necesito una', 'necesito que', 'necesito los', 'necesito las',
  'quiero un', 'quiero una', 'quiero que', 'quisiera un', 'quisiera una', 'quisiera que',
  'me puedes', 'me podrías', 'me podrias', 'me ayudas', 'puedes', 'podrías', 'podrias', 'pudieras',
  'ayúdame', 'ayudame',
];

/** Courtesy words before the ask: "Por favor, analiza…". */
const LEADING_COURTESY = /^(?:por favor|porfa|hola|oye|bueno|ok|okay)(?![\p{L}])[^\p{L}]*/u;

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

function opensWithRequest(text: string): boolean {
  let opening = text.replace(/^[^\p{L}]+/u, '');
  for (let prev = ''; prev !== opening; ) {
    prev = opening;
    opening = opening.replace(LEADING_COURTESY, '');
  }
  return REQUEST_OPENERS.some((o) => opening === o || new RegExp(`^${o}(?![\\p{L}])`, 'u').test(opening));
}

/**
 * A question or an explicit ask. The message, or any clause of it ("Del
 * testimonio, identifica…"), opening with an ask counts.
 */
export function isDirectRequest(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (m === '') return false;
  if (/[?¿]/.test(m)) return true;
  return m.split(/[,;:.\n]+/).some(opensWithRequest);
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
  /** This conversation's documents (`fetchSessionDocs`); `contentKind` and `uploadedBy` are read. */
  sessionDocs?: ReadonlyArray<{ contentKind?: string | null; uploadedBy?: string | null }>;
  /** The signed-in user's id. Missing ⇒ no attachment counts as theirs. */
  callerId?: string | null;
}

function isOwnStory(doc: { contentKind?: string | null; uploadedBy?: string | null }, callerId: string | null): boolean {
  if (!OWN_STORY_KINDS.has((doc.contentKind ?? '').toLowerCase())) return false;
  return callerId != null && doc.uploadedBy != null && String(doc.uploadedBy) === String(callerId);
}

export function chatTurnMode({
  userMessage,
  history = [],
  sessionDocs = [],
  callerId = null,
}: TurnModeInput): ChatTurnMode {
  if (userMessage.trim() === '' || isDirectRequest(userMessage)) return 'answer';
  if (sessionDocs.some((d) => isOwnStory(d, callerId))) return 'interview';
  if (isFirstPersonNarrative(userMessage)) return 'interview';
  // A short reply continues the interview only if the assistant last asked something.
  const lastBot = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastBot || !/[?？]["'»”)\s]*$/u.test(lastBot.content.trim())) return 'answer';
  // Earlier user turns, newest first, back to the last request.
  const earlier = history.filter((m) => m.role === 'user').map((m) => m.content).reverse();
  for (const m of earlier) {
    if (isDirectRequest(m)) return 'answer';
    if (isFirstPersonNarrative(m)) return 'interview';
  }
  return 'answer';
}
