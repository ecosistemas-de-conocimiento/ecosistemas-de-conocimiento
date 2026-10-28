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
  return ` ${s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

const ASK =
  /\b(resumen|resume|resumeme|resumir|resumelo|panorama|vision general|vista general|describe|describeme|de que trata|de que tratan|de que va|que temas|que hay en|que contiene)\b/;
const WHOLE =
  /\b(el|del|al|este|ese|nuestro|todo el|los|todos los|la|esta|toda la)\s+(corpus(?! christi)|grafo|ecosistema|coleccion|biblioteca|mapa de conexiones|documentos del ecosistema|material publicado)\b/;
const AS_A_WHOLE = /\b(corpus|coleccion|ecosistema|material|documentos)\s+(como|en)\s+(un |su )?conjunto\b/;
const HAS_TOPIC = /\b(sobre|acerca de|respecto a|en cuanto a|relacionad[oa]s? con)\b/;

/** The longest message read as an overview question. Longer is a real question. */
export const OVERVIEW_MAX_CHARS = 200;

/** "Dame un resumen del corpus", "¿de qué trata el grafo?", "el corpus como conjunto". */
export function isCorpusOverview(message: string): boolean {
  const text = (message ?? '').trim();
  if (!text || text.length > OVERVIEW_MAX_CHARS) return false;
  const f = fold(text);
  if (AS_A_WHOLE.test(f)) return true;
  return ASK.test(f) && WHOLE.test(f) && !HAS_TOPIC.test(f);
}

/** The most document titles the list names. */
export const LIST_MAX_TITLES = 40;

/**
 * The published-documents list: counts by kind, then the documento titles.
 * 🔴 Testimonios are counted, never named (their names are not neutral;
 * `chatSourceTitle` and the gate keep them "Testimonio" everywhere else).
 * `fetchPublishedTitles` reads at most its scan limit, so the counts say
 * "al menos" when the read was full. `''` when there is nothing published.
 */
export function documentListText(published: readonly TitledDoc[], scanLimit: number): string {
  const documentos = published.filter((d) => (d.contentKind ?? 'documento') === 'documento');
  const testimonios = published.length - documentos.length;
  if (published.length === 0) return '';
  const atLeast = published.length >= scanLimit ? 'al menos ' : '';
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
