/**
 * 🔴 CORPUS-OVERVIEW TURNS (owner-approved fix, 2026-10-28).
 *
 * Measured on dev (Discapacidad, org 7): "dame un resumen del grafo / corpus"
 * ran keyword retrieval, which matched the word "corpus" and pulled passages
 * about the "ex convento de Corpus Christi". A question about the corpus AS A
 * WHOLE is not answered by the passages that share its words.
 *
 * So an overview question ({@link isCorpusOverview}) skips passage retrieval
 * ({@link withoutRetrieval}) and gets two summary sources instead
 * (`./sources`): the graph's top entities over the whole published corpus
 * (`makeOverviewGraphProvider` in `$lib/server/graph`, the graph view the
 * /grafo page reads) and the published-documents list
 * ({@link documentListText}). Both are numbered, so the answer cites them.
 * No new backend endpoint: both reads already exist.
 *
 * Detection is deliberately narrow: an overview verb AND a whole-collection
 * noun with its article ("del corpus", "el grafo"), or "… como conjunto". A
 * question with a topic ("resumen del corpus sobre salud") is a normal turn.
 */

import type { AIClient } from '@edc/chat-engine/core';
import type { TitledDoc } from '$lib/server/titleMatch';

/** Lowercase, accents stripped, punctuation to spaces, spaces collapsed. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// 🔴 The collection noun must END the question (only the TAIL words may
// follow it). Audit 2026-10-28: an unanchored match read 11 of 13 topical
// questions as overviews ("Describe el ecosistema de manglares de la costa",
// "¿Qué temas hay en el corpus legal de la SCJN?"). False negatives are the
// cheap side: a missed overview is a normal turn, as before.
const ASK =
  '(?:resumen|resume|resumeme|resumir|resumelo|sintesis|sintetiza|panorama|vision general|vista general|describe|describeme|explica|explicame|de que trata|de que tratan|de que va|que temas|temas principales|que hay en|que contiene)';
const ARTICLE =
  '(?:el|del|al|este|ese|nuestro|todo el|los|todos los|de los|de todos los|la|esta|toda la|de la|de esta|de toda la)';
const NOUN =
  '(?:corpus|grafo|ecosistema|coleccion|biblioteca|mapa de conexiones|material publicado|documentos del ecosistema|documentos publicados|documentos)';
/** "grafo / corpus", "grafo o corpus": two collection nouns in a row. */
const NOUNS = `${NOUN}(?: (?:o |y )?${NOUN})?`;
/** The only words that may follow the noun: no topic, no qualifier. */
const TAIL =
  '(?: (?:de este proyecto|del proyecto|de este ecosistema|del ecosistema|por favor|completo|completa|entero|entera|en general|en conjunto|como conjunto|como un conjunto|en su conjunto|actual))*';
/**
 * At most four words before the request ("me puedes dar un panorama…"): a
 * longer lead is a compound question ("Háblame de la partería en Oaxaca y
 * luego dame un resumen del corpus"), a normal turn. A negation never leads.
 */
const LEAD = '^(?!no )(?:\\S+ ){0,4}';
/** ASK, at most three words, the article, the noun(s), the tail, the end. */
const WHOLE_QUESTION = new RegExp(`${LEAD}${ASK}(?: \\S+){0,3}? ${ARTICLE} ${NOUNS}${TAIL}$`);
/** "… el corpus como conjunto", at the end. */
const AS_A_WHOLE = new RegExp(
  `${LEAD}(?:el|la|los|del|de la|de los) (?:corpus|coleccion|ecosistema|material|documentos)(?: publicados?)? (?:como|en) (?:un |su )?conjunto${TAIL}$`,
);
/** "resumen general de todo lo que hay aquí": the whole, with no noun. */
const EVERYTHING = new RegExp(`${LEAD}${ASK}(?: \\S+){0,3}? (?:de )?todo lo que hay(?: aqui| aca| en el ecosistema| en el corpus)?$`);
const HAS_TOPIC = /\b(sobre|acerca de|respecto a|en cuanto a|relacionad[oa]s? con|que hablan)\b/;

/** The longest message read as an overview question. Longer is a real question. */
export const OVERVIEW_MAX_CHARS = 200;

/** "Dame un resumen del corpus", "¿de qué trata el grafo?", "… el corpus como conjunto". */
export function isCorpusOverview(message: string): boolean {
  const text = (message ?? '').trim();
  if (!text || text.length > OVERVIEW_MAX_CHARS) return false;
  const f = fold(text);
  if (HAS_TOPIC.test(f)) return false;
  return AS_A_WHOLE.test(f) || WHOLE_QUESTION.test(f) || EVERYTHING.test(f);
}

/** The most document titles the list names. */
export const LIST_MAX_TITLES = 40;

/**
 * The published-documents list: counts by kind, then the documento titles.
 * 🔴 Testimonios are counted, never named (their names are not neutral;
 * `chatSourceTitle` and the gate keep them "Testimonio" everywhere else).
 * The titles read stops at its scan limit, so the counts say "al menos" when
 * that read was full (`truncated`: the RAW row count reached the limit, before
 * any filter; `fetchPublishedTitleScan`). `''` when there is nothing published.
 */
export function documentListText(published: readonly TitledDoc[], truncated: boolean): string {
  const documentos = published.filter((d) => (d.contentKind ?? 'documento') === 'documento');
  const testimonios = published.length - documentos.length;
  if (published.length === 0) return '';
  const atLeast = truncated ? 'al menos ' : '';
  const counts =
    `Material publicado en el ecosistema: ${atLeast}${documentos.length} ` +
    `${documentos.length === 1 ? 'documento' : 'documentos'} y ${testimonios} ` +
    `${testimonios === 1 ? 'testimonio' : 'testimonios'}.`;
  if (documentos.length === 0) return counts;
  const shown = documentos.slice(0, LIST_MAX_TITLES).map((d) => `- ${d.name}`);
  const more = documentos.length - shown.length;
  return [counts, '', 'Documentos:', ...shown, ...(more > 0 ? [`- … y ${more} más.`] : [])].join('\n');
}

/**
 * The same client with passage retrieval switched off: every retrieve answers
 * no matches, so the engine sends no passages and pays no retrieve. Generation
 * (and the engine's condense call) go through unchanged.
 */
export function withoutRetrieval<T extends AIClient>(base: T): T {
  return {
    ...base,
    generateSync: base.generateSync.bind(base),
    ingest: base.ingest.bind(base),
    async retrieve() {
      return { matches: [] };
    },
    ...(base.retrieveMulti
      ? {
          async retrieveMulti() {
            return { matches: [], corpora: [] };
          },
        }
      : {}),
  };
}
