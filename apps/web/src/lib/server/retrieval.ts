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
   * corpora it is. `null` when not identifiable.
   *
   * Used for two things, both in the generate route:
   *   1. LABELLING. A citation carries the corpus it came from, so this is the
   *      exact signal for "this source is a draft, only you can see it"
   *      (`$lib/publication.stampDraftProvenance`).
   *   2. NARROWING. ai-service gives each person ONE draft corpus spanning all
   *      of their conversations, so `$lib/server/engine/aiClient` filters this
   *      corpus's results down to the documents attached to the current
   *      conversation. A draft belongs to the conversation it was uploaded
   *      into; the ecosistema's published corpus is the global one.
   */
  draftCorpus: string | null;
  /**
   * The ecosistema's SHARED published corpus — the one corpus that is NOT
   * narrowed to the current conversation.
   *
   * 🔴 THIS, NOT `draftCorpus`, DECIDES WHAT GETS NARROWED, and the asymmetry is
   * deliberate. Deciding "narrow the corpus I recognise as the draft one" fails
   * OPEN: the day the response stops being recognisable, every draft goes global
   * again and the only symptom is wrong answers nobody traces back to here.
   * Deciding "narrow everything except the corpus I recognise as shared" fails
   * CLOSED: the same day, the caller loses their own drafts and says so out
   * loud. Same house rule as `asOf` above — be wrong in the direction someone
   * reports.
   *
   * `null` when the response did not identify one. See
   * `$lib/server/engine/aiClient`, which then narrows every authorised corpus.
   */
  publishedCorpus: string | null;
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
  const empty: SessionCorpora = {
    corpora: [],
    asOf: null,
    draftCorpus: null,
    publishedCorpus: null,
  };
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
  // ⚠ `published` / `draft` are what the backend ACTUALLY sends today —
  // `apps/backend/src/collections/Sessions.ts`, the `/corpora` handler, returns
  // `{corpora, published, draft, asOf}`. The camelCase spellings above predate
  // that endpoint being written and were guesses; they are kept because they
  // cost nothing, but these two are the real contract.
  push(body.published);
  push(body.draft);

  const asOf =
    asNonEmptyString(body.asOf) ??
    asNonEmptyString((body as { as_of?: unknown }).as_of);

  // The ecosistema's shared corpus. Read the backend's own field first; the
  // camelCase spellings are legacy guesses. NO name-shaped fallback here on
  // purpose: guessing which corpus is the global one is precisely the guess
  // that fails open (see `SessionCorpora.publishedCorpus`).
  const publishedCorpus =
    asNonEmptyString(body.published) ??
    asNonEmptyString(body.publishedCorpus) ??
    asNonEmptyString(body.ecosystemCorpus) ??
    asNonEmptyString(body.ecoCorpus) ??
    null;

  // The caller's own draft corpus. Used for LABELLING a citation "borrador,
  // solo tú lo ves" (`$lib/publication.stampDraftProvenance`), not for deciding
  // what to narrow — `publishedCorpus` does that. A miss here costs a missing
  // label, which is why the loose name-shaped fallback is acceptable.
  const draftCorpus =
    asNonEmptyString(body.draft) ??
    asNonEmptyString(body.draftCorpus) ??
    asNonEmptyString((body as { draft_corpus?: unknown }).draft_corpus) ??
    names.find((n) => n !== publishedCorpus && /draft|borrador/i.test(n)) ??
    null;

  return { corpora: names, asOf, draftCorpus, publishedCorpus };
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
