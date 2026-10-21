/**
 * `lengua` — the language of the PEOPLE a documento is about. Not the language
 * it is written in: every document in the seeded corpus is in Spanish.
 *
 * Pure rules and copy for the three places that filter on it: the biblioteca,
 * the grafo and the chat. Kept out of `.svelte` files because this app's vitest
 * runs with no DOM (same reason as `$lib/biblioteca.ts`).
 *
 * 🔴 ONLY A `documento` EVER HAS ONE. On a testimonio the language is a
 * re-identification key, so the backend nulls it on write, hides it on read,
 * and `GET /api/lenguas` reads documentos only
 * (`apps/backend/src/endpoints/lenguas.ts`). Everything here therefore works
 * from that route's answer and never from a row's own `lengua` field — a
 * testimonio cannot reach this module with a language attached.
 *
 * ⚠ A CONSEQUENCE THE UI STATES: filtering by lengua hides every testimonio.
 * That is not a bug; they record no language.
 */

/** One language and how many published documentos are about it. */
export interface LenguaFacet {
  lengua: string;
  documentos: number;
}

/** `/api/lenguas`, parsed: the facets plus document id → lengua. */
export interface LenguaIndex {
  lenguas: LenguaFacet[];
  byDocument: Record<string, string>;
}

export const EMPTY_LENGUA_INDEX: LenguaIndex = { lenguas: [], byDocument: {} };

/** A filter value travels in URLs and request bodies; cap it. */
export const MAX_LENGUA_LENGTH = 60;

export const LENGUA_LABEL = 'Lengua';
export const LENGUA_ALL = 'Todas las lenguas';
export const LENGUA_PANEL_TITLE = 'Lenguas en los documentos publicados';
export const LENGUA_PANEL_EMPTY = 'Ningún documento publicado registra una lengua todavía.';
export const LENGUA_CHAT_HINT = 'Responder solo con documentos sobre personas que hablan esta lengua.';

/** `''` means "no filter". */
export function parseLengua(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_LENGUA_LENGTH) : '';
}

/**
 * The ai-service `/v1/retrieve` metadata filter for a lengua (jsonb `@>` over
 * chunk metadata; `chunkMetadata` in `apps/backend/src/lib/contentKind.ts` puts
 * `lengua` there on a documento only).
 */
export function lenguaRetrievalFilter(lengua: string): { lengua: string } | undefined {
  return lengua ? { lengua } : undefined;
}

export function parseLenguaIndex(body: unknown): LenguaIndex {
  const out: LenguaIndex = { lenguas: [], byDocument: {} };
  if (!body || typeof body !== 'object') return out;
  const raw = body as { lenguas?: unknown; documentos?: unknown };
  for (const f of Array.isArray(raw.lenguas) ? raw.lenguas : []) {
    const facet = f as { lengua?: unknown; documentos?: unknown } | null;
    const lengua = parseLengua(facet?.lengua);
    const n = facet?.documentos;
    if (lengua && typeof n === 'number' && Number.isFinite(n) && n > 0) {
      out.lenguas.push({ lengua, documentos: n });
    }
  }
  for (const d of Array.isArray(raw.documentos) ? raw.documentos : []) {
    const doc = d as { id?: unknown; lengua?: unknown } | null;
    const lengua = parseLengua(doc?.lengua);
    const id = doc?.id;
    if (lengua && (typeof id === 'string' || typeof id === 'number')) {
      out.byDocument[String(id)] = lengua;
    }
  }
  return out;
}

export function documentIdsForLengua(byDocument: Record<string, string>, lengua: string): string[] {
  return Object.keys(byDocument).filter((id) => byDocument[id] === lengua);
}

function documentosCopy(n: number): string {
  return n === 1 ? '1 documento' : `${n.toLocaleString('es-MX')} documentos`;
}

/** `mixteco · 18 documentos` — an option label or a list row. */
export function lenguaFacetCopy(facet: LenguaFacet): string {
  return `${facet.lengua} · ${documentosCopy(facet.documentos)}`;
}

/**
 * The line of the chat's deterministic summary that names the languages.
 *
 * It answers "¿qué lenguas indígenas aparecen?" from the column instead of from
 * whatever chunks retrieval happened to return. Retrieval cannot answer an
 * aggregate question: it returns the top few passages, and 11 languages spread
 * over 191 documentos do not fit in a top few (eval G05, recall 0.36).
 *
 * ⚠ It says what it counts. A model told "lenguas: mixteco…" would present it
 * as everyone in the ecosistema, testimonios included; they record none.
 */
export function lenguaSummaryLine(facets: readonly LenguaFacet[]): string {
  if (facets.length === 0) return '';
  const list = facets.map((f) => `${f.lengua} (${documentosCopy(f.documentos)})`).join(', ');
  return (
    `Lenguas de las personas de las que hablan los documentos publicados del ecosistema: ${list}. ` +
    'Los testimonios no registran lengua, así que no están contados.'
  );
}

/** What `/grafo`'s load adds to `GrafoPageData` (kept here: `$lib/graph.ts` is the graph lane's). */
export interface GrafoLenguaData {
  /** `?lengua=`; `''` ⇒ no filter. */
  lengua: string;
  lenguas: LenguaFacet[];
  lenguaByDocument: Record<string, string>;
}

/** Set (or clear, with `''`) `?lengua=` on an in-app href, keeping every other parameter. */
export function withLengua(href: string, lengua: string): string {
  const [path, query = ''] = href.split('?', 2);
  const qs = new URLSearchParams(query);
  if (lengua) qs.set('lengua', lengua);
  else qs.delete('lengua');
  const out = qs.toString();
  return out ? `${path}?${out}` : path!;
}

/** Keep the documents in `lengua`. Anything absent from `byDocument` — every testimonio — is dropped. */
export function filterByLengua<T extends { id: string }>(
  docs: readonly T[],
  byDocument: Record<string, string>,
  lengua: string,
): T[] {
  return lengua ? docs.filter((d) => byDocument[d.id] === lengua) : [...docs];
}

export interface LenguaTurn {
  lengua: string;
  /** For `respond()` / `prepareTurn()`'s `retrievalFilter`. Absent ⇒ unfiltered. */
  retrievalFilter?: { lengua: string };
  /**
   * Whether the GraphRAG leg may run. `false` under a lengua filter: that leg
   * retrieves with its own widened query and NO filter, and its block counts
   * the whole ecosistema — both would contradict a "solo esta lengua" turn.
   */
  graph: boolean;
}

/** A chat turn's `lengua` request field, turned into what the engine needs. */
export function lenguaTurn(raw: unknown): LenguaTurn {
  const lengua = parseLengua(raw);
  const retrievalFilter = lenguaRetrievalFilter(lengua);
  return retrievalFilter ? { lengua, retrievalFilter, graph: false } : { lengua, graph: true };
}
