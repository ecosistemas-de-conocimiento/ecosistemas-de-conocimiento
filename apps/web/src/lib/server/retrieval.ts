/**
 * Retrieval scoping — corpus names and the `asOf` validity clock.
 *
 * ## Why `asOf` is load-bearing
 *
 * 🔴 Unpublishing a document does NOT delete its chunks. The backend sets a
 * validity end-date on them instead. A chunk only disappears from results when
 * the retrieve call carries `asOf`. **Omit `asOf` and unpublished documents keep
 * turning up in answers** — precisely the leak the draft/publish model exists to
 * prevent.
 *
 * So this module fails CLOSED: no `asOf`, no retrieve. An answer with less
 * context is a bad answer; an answer quoting a document that was deliberately
 * unpublished is a data leak.
 *
 * ## Why we never build corpus names here
 *
 * `GET /api/sessions/:id/corpora` is the sole derivation point, on purpose: a
 * client that can compose a corpus name can address another ecosistema's
 * corpus. We ask, we never guess — there is deliberately no `eco-${orgId}`
 * template anywhere in this app.
 *
 * ## ASSUMED response shape
 *
 * The endpoint's exact field names were not specified. `parseCorporaResponse`
 * therefore accepts the plausible shapes rather than betting on one, and any
 * unreadable answer yields `asOf: null`, which stops retrieval rather than
 * letting it run unbounded. If the real shape is something else entirely, this
 * one function is the fix.
 */

export interface SessionCorpora {
  /** Corpus names to retrieve from, exactly as the backend gave them. */
  corpora: string[];
  /**
   * The caller's OWN draft corpus, when the response identifies which of the
   * corpora it is. Used to label cited drafts exactly — a citation carries the
   * corpus it came from, so this identifies the user's private documents
   * regardless of which session uploaded them. `null` when not identifiable.
   */
  draftCorpus: string | null;
  /**
   * Validity instant every retrieve must be scoped to. `null` means we could
   * not read one — callers MUST then skip retrieval, not retrieve unscoped.
   */
  asOf: string | null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Normalise `GET /api/sessions/:id/corpora`.
 *
 * Accepts a `corpora` array of plain strings or of `{name}`/`{corpus}` objects,
 * and also the flat `{ecosystemCorpus, draftCorpus}` pairing. Anything it
 * cannot read becomes an empty list with `asOf: null`.
 */
export function parseCorporaResponse(raw: unknown): SessionCorpora {
  const empty: SessionCorpora = { corpora: [], asOf: null, draftCorpus: null };
  if (!raw || typeof raw !== 'object') return empty;
  const body = raw as Record<string, unknown>;

  const names: string[] = [];
  const push = (v: unknown) => {
    const s = asNonEmptyString(v);
    if (s && !names.includes(s)) names.push(s);
  };

  if (Array.isArray(body.corpora)) {
    for (const entry of body.corpora) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>;
        push(o.name ?? o.corpus ?? o.id);
      }
    }
  }
  // Flat pairing, in case the endpoint names the two corpora explicitly.
  push(body.ecosystemCorpus);
  push(body.ecoCorpus);
  push(body.draftCorpus);

  const asOf =
    asNonEmptyString(body.asOf) ??
    asNonEmptyString((body as { as_of?: unknown }).as_of);

  // Which of the two is the caller's own draft corpus? Prefer an explicit
  // field; otherwise fall back to a name that says so. `null` when neither
  // applies — the caller then labels drafts from the session's document list
  // alone, which is a narrower but never a wrong signal.
  const draftCorpus =
    asNonEmptyString(body.draftCorpus) ??
    asNonEmptyString((body as { draft_corpus?: unknown }).draft_corpus) ??
    names.find((n) => /draft|borrador/i.test(n)) ??
    null;

  return { corpora: names, asOf, draftCorpus };
}

export interface RetrieveBodyInput {
  corpus: string;
  query: string;
  topK?: number;
  filter?: unknown;
  /** The validity instant from `/corpora`. Required — see the module header. */
  asOf: string | null | undefined;
}

/**
 * Build the `/v1/retrieve` request body, or `null` when the call must not be
 * made at all.
 *
 * 🔴 Returning `null` when `asOf` is missing is the whole point of this
 * function, and the reason it is a separate testable unit: it is the one place
 * that can guarantee no retrieve ever goes out unscoped. Do not "helpfully"
 * fall back to sending the request without it.
 */
export function buildRetrieveBody(input: RetrieveBodyInput): Record<string, unknown> | null {
  const asOf = asNonEmptyString(input.asOf);
  if (!asOf) return null;
  const corpus = asNonEmptyString(input.corpus);
  if (!corpus) return null;
  return {
    corpus,
    query: input.query,
    ...(input.topK ? { topK: input.topK } : {}),
    ...(input.filter === undefined || input.filter === null ? {} : { filter: input.filter }),
    asOf,
  };
}
